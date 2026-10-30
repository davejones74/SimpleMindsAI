# Phase 1 Implementation Report — Stages 1–3

Implementation completed in `/home/dave/Repositories/SimpleMindsAI`. No deployment, production training, production registry write, article consumption, or timer start occurred.

## 1. Files changed and purpose

### Stage 1 — Evidence and reproducibility

| File | Purpose |
|---|---|
| `src/training/candidate-identity.js` (new) | Canonical candidate identity/key: parent weight fingerprint, corpus fingerprint, eval fingerprint, tokenizer fingerprint, full training config, seed, split policy, content-derived trainer fingerprint |
| `scripts/run-staged-production-candidate.mjs` (pre-existing untracked, extended) | Uses the new identity/key; includes identity in candidate marker and run summary |
| `python/sma/train.py`, `python/sma/brain.py` | Propagate training seed; record corpus file hashes, parent weight fingerprint, Python trainer fingerprint, split hash, runtime/resource measurements |
| `src/training/python-trainer.js` | Passes `--seed` and validation policy; maps new Python provenance fields |
| `src/training/eval-cache.js` | Baseline cache key includes trainer code fingerprint |
| `src/storage/registry-store.js` | Persists evaluation evidence separately and links it by hash |
| `src/training/loss-evaluator.js` | Returns bootstrap method version and deterministic bootstrap seed |
| `src/training/lifecycle.js` | Persists candidate identity, split policy, selected checkpoint, per-document/group/bootstrap evidence, and full generation samples |
| `src/training/generation-quality.js`, `python/sma/brain.py` | Retains prompt-bank version, prompt IDs, decoding config, model fingerprint, and individual samples |
| `test/candidate-identity.test.js`, `test/evaluation-evidence.test.js`, `test/eval-cache.test.js`, `test/generation-quality.test.js` | New/updated evidence tests |

### Stage 2 — Fail-closed partitioning

| File | Purpose |
|---|---|
| `src/dataset/dedup.js` (new) | Deterministic exact/normalised/near-duplicate clustering with MinHash + LSH |
| `src/dataset/partition.js` (new) | Document/source-disjoint partition, deterministic split, exposure classification, explicit `INSUFFICIENT_VALIDATION` |
| `src/dataset/snapshot.js` | Integrates partition manifest/assignment file, source representatives, language eligibility, diversity/quality stats |
| `src/training/lifecycle.js` | Partitions before packing; excludes validation rows from training and consumption; records partition and exposure |
| `python/sma/data.py`, `python/sma/train.py`, `python/sma/brain.py` | Fail-closed document-source validation; no tail fallback for the production policy; `INSUFFICIENT_VALIDATION` error path |
| `test/dedup-partition.test.js` (new), `python/tests/test_corpus_roles.py`, `test/python-trainer.test.js` | Partition and fail-closed tests |

### Stage 3 — Corpus integrity and quality

| File | Purpose |
|---|---|
| `src/domain/review-policy.js` | Repaired near-duplicate shingle set construction |
| `src/dataset/corpus-text.js` (pre-existing untracked, extended) | Quality tier, source/publisher identity, language eligibility, source raw-text suppression |
| `src/dataset/language-policy.js` (new) | Explicit English-first language eligibility and recorded confidence/reason |
| `src/dataset/diversity.js` (new) | Source/publisher/language/quality distributions, top-share, Herfindahl, configurable caps |
| `src/dataset/snapshot.js` | Fallback token caps, source representative selection, diversity/quality in snapshot manifests |
| `src/config.js`, `.env.example` | New validation, seed, language, quality and diversity controls |
| `test/corpus-quality.test.js` (new), `test/review-policy.test.js`, `test/dataset.test.js` | Quality, language, diversity and dedup tests |

Pre-existing unrelated working-tree changes were preserved. No files were reset or discarded.

## 2. Design decisions and deviations

- The independent final test, multi-seed experiments, expanded generation protocol, acquisition pilot and deployment were **not** implemented, per instruction.
- The production validation default is `document-source-disjoint`. Direct Python library calls still default to `legacy-tail-split` for isolated fixture compatibility; the Python CLI and Node lifecycle default to fail-closed document/source partitioning.
- The Node partition target is derived from `trainValBlocks × trainSeqLen` when no explicit token target is configured, so the selected validation cohort matches the trainer's requested validation blocks.
- Source/domain caps are implemented but default to **disabled (0)**. The proposed 5% source / 15% domain limits are configurable hypotheses, not yet enforced.
- Language unknown policy defaults to **allow** for compatibility; it is recorded explicitly. Production can set `TRAIN_LANGUAGE_UNKNOWN_POLICY=reject`.
- Publisher/domain is **not** used for deduplication. Only article/content/source/family identity is used.
- One representative full-text row is chosen per source; other curated chunks remain as curated text with `rawTextSuppressed: true` rather than being discarded.
- Historical exposure coverage uses prior snapshots, fresh/replay roles, consumption records and contribution records available in the same store. Missing cross-workspace ledgers are reported as uncertainty, not treated as proof of non-exposure.

## 3. Candidate fingerprint specification

`src/training/candidate-identity.js` computes a canonical SHA-256 over:

- Parent version and persisted weight fingerprint (`init-manifest.json` tensor hashes).
- Corpus fingerprint: SHA-256 over the actual snapshot input rows, including cleaned text and role metadata.
- Evaluation file fingerprint and manifest fingerprint/dataset version.
- Tokenizer file fingerprint.
- Complete training configuration and seed.
- Split policy version, cluster policy version and split seed.
- Trainer/source fingerprint.

Trainer fingerprint components:

```text
src/training
src/dataset
src/domain
src/storage
src/brain
src/config.js
scripts/run-staged-production-candidate.mjs
python/sma/*.py
package.json
```

Excluded: tests, `__pycache__`, virtualenvs, `node_modules`, generated/transient runtime data. The fingerprint hashes file content, not the `python-v1` label.

The canonical key is recorded in `candidate-key.json` and the run record as `candidateIdentity`. A change to any listed input changes `candidateKey`; this is covered by `test/candidate-identity.test.js`.

## 4. Evaluation evidence retention format

Aggregate evaluation records remain in `registry/evaluations.ndjson`. Large evidence is written to:

```text
<registry>/evaluations/<evalRunId>.evidence.json
```

The aggregate record carries `evidenceFile` and `evidenceHash`. The evidence JSON contains:

- schema (`sma/eval-evidence@1`), evalRunId, kind, timestamp.
- Evaluation dataset ID/version, file hash, manifest hash, item IDs and content hashes.
- Metric and metric signature.
- Model version/ID, candidate key, parent weight fingerprint, code fingerprint, training seed.
- Per-document losses and source groups.
- Parent and candidate comparison inputs.
- Paired bootstrap result, method/version, bootstrap seed, CI level, sample count and minimum group count.

`test/evaluation-evidence.test.js` demonstrates that a reviewer can reconstruct the paired point estimate and confidence interval from the persisted evidence without rerunning training.

Generation evidence now retains prompt-bank version, prompt IDs, model fingerprint, decoding configuration, seed, generated token count, per-prompt metrics and generated samples in the run record and candidate marker.

## 5. Document/source clustering methodology

Identity types are kept separate:

- `articleId` — one snapshot row/curated chunk.
- `contentClusterId` — exact/normalised/near-duplicate content.
- `sourceId` — `fetchedContentHash` or canonicalised source URL.
- `publisherId` — host/domain, for reporting only.
- `familyId` — optional known syndication/translation family.

Clustering cascade:

1. Exact `contentHash`.
2. Normalised text hash (lowercase, NFKC, punctuation/whitespace normalisation).
3. Same `sourceId` / `fetchedContentHash` / canonical URL.
4. Same known `familyId`.
5. MinHash + LSH over 5-word shingles, exact Jaccard verification at threshold `0.6`.
6. Short documents (< 8 shingles) are not near-clustered by Jaccard.

The repaired `nearDuplicateSimilarity` now builds a real word-shingle set. It no longer constructs a character set from the first regex match. Limitations are documented: lexical detection does not reliably catch translations, aggressive paraphrases or completely rewritten syndication unless source/family identifiers also match.

## 6. Validation split algorithm and failure behaviour

Algorithm:

1. Build content/source/family clusters over all candidate rows.
2. Treat the whole cluster as the partition unit.
3. Sort clusters by deterministic `sha256(splitSeed + ":" + clusterId)`.
4. Prefer prospective clusters; add historical clusters only when allowed.
5. Select until the token target or minimum cohort is met.
6. Assign all remaining clusters to training.
7. Record assignments and write an immutable assignment file under `snapshots/splits/`.
8. Record `splitHash`, article/cluster/source assignments, token/block stats and exposure.

Failure behaviour:

- If no prospective validation is available and `requireProspective` is true: `INSUFFICIENT_VALIDATION`.
- If minimum validation clusters or tokens cannot be met: `INSUFFICIENT_VALIDATION`.
- If no training clusters remain: explicit `INSUFFICIENT_CORPUS`.
- Python `document-source-disjoint` validation raises `InsufficientValidationError` when validation documents are missing, cannot form a block, or form fewer blocks than requested.
- No silent tail fallback occurs for the production policy. `legacy-tail-split` remains explicit and is used only by isolated library/fixture callers.

No TrainingRun is created after a failed preflight; this is tested in `test/python-trainer.test.js`.

## 7. Historical exposure handling

The partitioner builds the historical set from:

- All prior snapshot manifests in the registry.
- Rows classified as retained/replay rather than fresh.
- Durable consumption records.
- Training-contribution records, where available in the current store.

Validation exposure is recorded as `prospective-only`, `historical-only` or `mixed`, with counts of prospective/historical articles. The manifest states that historical exposure cannot be reversed. Missing ledgers are reported as uncertainty rather than assumed absent.

## 8. Corpus cleaning and language policy

- Quality tiers are explicit: `full-text`, `fallback`, `curated`.
- Source representative selection prevents multiple curated chunks from embedding multiple full copies of the same raw source.
- Fallback content has a configurable token-share cap (`TRAIN_CORPUS_MAX_FALLBACK_TOKEN_SHARE`), applied as deterministic deferral from the current snapshot.
- Language eligibility is a corpus decision, not a mutation of the article store.
- Supported languages, confidence and unknown policy are configurable and recorded per row.
- Non-English source material is untouched in the article store.
- Readability extraction was investigated but production extraction defaults were not changed.

## 9. Source diversity and quality reporting

Every snapshot now records:

- Candidate/included/excluded document counts and reasons.
- Raw-text versus fallback/curated token contribution.
- Estimated token counts with the estimate method identified.
- Language distribution.
- Source and publisher distributions.
- Top-1/top-10 source and publisher token shares.
- Source/publisher Herfindahl concentration.
- Quality-tier distribution.
- Tiny-document counts and token share.
- Duplicate/near-duplicate cluster information and split policy reference.

Caps are implemented as deterministic sampling/deferral; overrepresented material is not deleted from the article store. Defaults are disabled pending review.

## 10. Test results

- `git diff --check`: **clean**.
- Full Node suite: **717 tests, 710 passed, 0 failed, 7 existing skips**.
- Focused Node suite for this work: **148 passed, 0 failed**.
- Focused Python tests: `test_corpus_roles.py`, `test_eval_record.py`, `test_preflight.py` passed; no failures.
- Python venv emitted an existing `sys.prefix`/`sys.exec_prefix` warning; it did not affect results.
- Full Python suite was not run; focused checks were used as instructed.

No production training experiment was run.

## 11. Remaining limitations

- Independent final test and access controls are not implemented.
- Multi-seed candidate comparison is not implemented.
- Larger generation-quality protocol is not implemented.
- Acquisition pilot and curriculum enforcement are not implemented.
- Near-duplicate detection is lexical; translations and paraphrases are not reliably detected without source/family metadata.
- Source/domain caps are available but disabled by default; no calibrated thresholds are enabled.
- Language unknown defaults to allow; production policy remains a decision.
- Historical exposure across workspaces and incomplete ledgers is reported with uncertainty.
- Candidate fingerprint includes source files but not the full dependency lockfile or Python package versions.
- Direct Python library callers can still choose legacy tail splitting; only the CLI/Node lifecycle default is fail-closed.
- No end-to-end real-model training run was performed, so provenance fields are implemented and compile-tested but not exercised against a newly trained checkpoint in this stage.

## 12. Production integration considerations

- Do not deploy this working tree directly; it is uncommitted and includes pre-existing unrelated changes.
- Production should set `TRAIN_VALIDATION_POLICY=document-source-disjoint`.
- For ordinary fresh-delta production, consider `TRAIN_VALIDATION_REQUIRE_PROSPECTIVE=true` so historical material is never presented as unseen validation.
- Decide whether to enable source/domain caps after reviewing measured concentration.
- Decide the unknown-language policy for production; current default is `allow`.
- Existing `eval-002` remains a development benchmark; it is not a final test.
- Existing snapshots and evaluation records are not migrated; new records carry the new fields.
- The candidate script is still untracked and must be committed/versioned before production use.

## 13. Exact commit and working-tree status

- HEAD: `9324fbf` (`Autonomous Importance Classification`).
- No commit and no push were performed.
- Working tree is dirty: 42 status entries, including pre-existing unrelated changes and the new Stage 1–3 files.
- Production state was not modified:
  - `/var/lib/simpleminds/store/active.json` remains v389.
  - Production registry mtimes remain before this implementation.
  - No production files were written after implementation began.
- The perpetual timer was not started or restarted.

## Acceptance criteria

### Stage 1

| Criterion | Status |
|---|---|
| Changing any candidate identity input invalidates cached candidate | **PASS** (`test/candidate-identity.test.js`, `test/eval-cache.test.js`) |
| Identical inputs produce identical key | **PASS** |
| Evaluation aggregates and paired CI independently reconstructable | **PASS** (`test/evaluation-evidence.test.js`) |
| Candidate provenance complete | **PASS** for implemented fields; not exercised against a real new checkpoint |
| No production state touched | **PASS** |

### Stage 2

| Criterion | Status |
|---|---|
| No article crosses the partition | **PASS** |
| No duplicate-content cluster crosses | **PASS** |
| No configured source family crosses | **PASS** |
| Training and validation tokenised/packed separately | **PASS** |
| Split deterministic | **PASS** |
| Insufficient validation fails explicitly | **PASS** |
| No silent tail fallback | **PASS** for production policy; legacy explicit only |
| No TrainingRun after failed preflight | **PASS** |
| Historical exposure distinguished from prospective holdout | **PASS** |
| Existing fresh-material lifecycle semantics unchanged | **PASS** (full suite) |

### Stage 3

| Criterion | Status |
|---|---|
| Near-duplicate detection works on fixtures | **PASS** |
| Full-text/fallback contribution measurable | **PASS** |
| Tiny-fragment dominance detectable | **PASS** |
| Language eligibility explicit and tested | **PASS** |
| Source concentration measurable | **PASS** |
| Snapshot manifests expose quality/diversity | **PASS** |
| Existing article data untouched | **PASS** |
| Normal learning lifecycle fresh-material policy unchanged | **PASS** |

## Recommendation

Stop here for review. Stages 1–3 provide the evidence, fail-closed partition and corpus-quality foundation. The independent final test, multi-seed evaluation, expanded generation protocol and acquisition pilot should wait for the next authorisation.

**Decisions requiring Dave's approval before the next stage:** enable source/domain caps and thresholds; choose production language unknown policy; require prospective-only validation in production; commit/version the candidate script and this implementation; and authorise the independent final-test architecture.
