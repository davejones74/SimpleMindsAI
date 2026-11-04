# Continuous Knowledge and Learning Effectiveness — Implementation Report

**Branch:** `programme/continuous-knowledge-learning-effectiveness-20261104`  
**Base:** `master` @ `ced98fd`  
**Status:** release-candidate implementation on a feature branch. **Not deployed.** Production remained read-only throughout.

This report describes what changed, why, how it was verified, and what remains before deployment.

---

## 1. Summary of implemented workstreams

| Workstream | Status | Main artefacts |
|---|---|---|
| A — acquisition quality | Implemented + tested | `src/discovery/source-quality.js`, discovery policy integration |
| B — extraction/curation granularity | Implemented + measured | `src/services/curator-segmentation.js`, learning-cycle integration |
| C — licensing/provenance | Implemented + tested + audited | `src/domain/licence.js`, store/GraphQL/snapshot integration, retired-replay audit |
| D — review/trainability | Implemented + tested | `src/domain/review-prefilter.js`, review-pass/learning integration |
| E — cumulative learning effectiveness | Implemented + tested + baseline measured | `src/training/learning-effectiveness.js`, `src/training/sealed-cohort.js`, report script |
| F — training/validation supply | Implemented + measured | `python/sma/measure.py`, `src/training/tokenizer-measurement.js`, measurement scripts |
| G — evaluation infrastructure | Implemented | sealed-cohort manifests, dataset hashing, leak/disjointness verification |
| H — observability/control plane | Implemented + tested | knowledge API/UI extensions |

---

## 2. Detailed changes

### 2.1 Optimiser continuity

**Files:** `python/sma/train.py`, `python/tests/test_working_checkpoint.py`

- The carry path previously overwrote every parameter group's `weight_decay` with `cfg.weightDecay`, turning the intended `[0.01, 0.0]` split into `[0.01, 0.01]`.
- It now captures the constructed per-group decays and re-applies those exact values after loading the parent optimizer state.
- Moments, step counters and the other hyperparameters remain carried.
- A regression test asserts the carried optimizer keeps `[0.01, 0.0]`.

**Transition note:** the first run after this fix will move the no-decay group from `0.01` (as recorded in `v495…v500`) back to `0.0`. This is intentional and must be recorded as a hyperparameter transition in the next working run's provenance.

### 2.2 Durable licensing and provenance

**Files:** `src/domain/licence.js`, `src/domain/article.js`, `src/storage/article-store.js`, `src/dataset/snapshot.js`, `src/dataset/corpus-text.js`, `src/graphql/schema.graphql`, `src/graphql/resolvers.js`, `src/config.js`, `README`/`.env.example`.

- Every new ingest with a source URL gets a resolved licence record:
  - `schema`, `policyVersion`, `status` (`safe|uncertain|restricted|unknown`), `decision` (`allow|review|deny`), `id`, `name`, `url`, `sourceHost`, attribution fields, reason and timestamp.
- Resolution uses an explicit declared licence first, then the conservative host policy. Missing metadata is `unknown`, never safe.
- `LICENCE_ENFORCEMENT`:
  - `off`: no resolution;
  - `shadow` (default): record only;
  - `enforce`: refuse restricted material (`skipped: true`, reason `licence-<status>`).
- Licence corrections are append-only (`licence` events).
- `isReplayEligible`/`isReplayExcluded` treat a resolved `deny`/`restricted` as authoritative.
- Snapshot rows carry compact licence provenance so a trained row remains attributable.
- Store stats expose:
  - `byLicenceStatus`;
  - `approvedRetired`;
  - `consumedApprovedRetired`;
  - `consumedApprovedRetiredReplayable`;
  - `consumedApprovedRetiredNotReplayable`.

**Backward compatibility:** existing records without a licence remain readable and are counted as `unresolved`; no historical record is rewritten.

### 2.3 Retired-replay recovery audit

**Files:** `src/training/retired-replay-audit.js`, `scripts/knowledge-pilot/audit-retired-replay.mjs`, `test/retired-replay-audit.test.js`.

- Pure classification of every retired article:
  - already eligible;
  - recoverable safe;
  - blocked by licence (uncertain/unknown/restricted);
  - blocked by quality/language/completeness;
  - blocked by integrity or missing approval;
  - retired but never consumed.
- Read-only production audit output (2026-11-04):
  - 10,252 retired;
  - 377 already eligible;
  - 2,869 retired but never consumed;
  - 5,113 blocked by quality (mostly sub-block fragments);
  - 944 licence-uncertain;
  - 949 licence-unknown;
  - **0 safely recoverable under the current policy**.
- No migration or apply path was added for production. The result shows that a safe recovery needs a licence/completeness policy decision, not a blanket migration.

### 2.4 Full-source curation and token yield

**Files:** `src/services/curator-segmentation.js`, `src/jobs/learning.js`, `src/services/curator.js`, `scripts/learning-effectiveness/measure-segmentation.mjs`, `test/curator-segmentation.test.js`.

- `CURATOR_STRATEGY=segmented` (new default) sends the whole source to the teacher in sentence-aligned chunks, rather than only `rawText.slice(0, 14000)`.
- Chunks are bounded by `CURATOR_CHUNK_MAX_CHARS`, targeted at `CURATOR_CHUNK_TARGET_CHARS`, with `CURATOR_CHUNK_MIN_CHARS`.
- Adjacent short units are merged within the same domain, up to `CURATOR_MERGE_MAX_CHARS`.
- `CURATOR_STRATEGY=legacy` restores the old single-slice behaviour exactly.
- A partial chunk failure does not mark the source complete; retries are possible and content-hash dedup prevents duplicate ingestion.
- Read-only measurement of the current fresh cohort:
  - legacy visible coverage **30.4%**;
  - segmented coverage **95.7%**;
  - curated **3,882 tokens / 30 blocks**;
  - cleaned raw text **40,947 tokens / 319 blocks** (~**10.5×**).

### 2.5 Discovery URL quality

**Files:** `src/discovery/source-quality.js`, `src/discovery/discovery-policy.js`, `src/discovery/discovery-service.js`, `src/harness/crawler.js`, `src/config.js`, `test/discovery-source-quality.test.js`.

- Rejects before enqueue:
  - Wikimedia File/Image/Category/Special/Template/Talk/User/Portal/Module namespaces;
  - images, audio/video, archives, CSS/JS/JSON/XML and other non-content extensions;
  - login/signup/search/account/cart/checkout/API paths;
  - known non-content Wikimedia hosts.
- `DISCOVERY_URL_QUALITY=off|shadow|enforce`, default `enforce`.
- The filter applies even to seed hosts, so a File page can never enter the frontier merely because its host is trusted.

### 2.6 Review prefilter

**Files:** `src/domain/review-prefilter.js`, `src/jobs/review-pass.js`, `src/jobs/learning.js`, `src/config.js`, `test/review-prefilter.test.js`.

- Deterministic pre-review decision:
  - hard non-prose (completeness reject) → reject;
  - below the length/word floor → reject;
  - quarantine-level short prose → flagged;
  - otherwise proceed.
- `REVIEW_PREFILTER_MODE=off|shadow|enforce`, default `shadow`.
- In enforce mode, review records an automation reject with `gate: "prefilter"` before calling the teacher.
- Learning ingest in enforce mode does not immediately queue obvious non-prose for teacher review; the record is retained and remains recoverable.

### 2.7 Cumulative learning effectiveness

**Files:** `src/training/learning-effectiveness.js`, `src/training/sealed-cohort.js`, `scripts/learning-effectiveness/report.mjs`, `test/learning-effectiveness.test.js`.

- Working trajectory is built from durable contributions + evaluation records:
  - candidate loss, stable loss, parent loss;
  - delta vs stable/parent;
  - fresh/replay/validation tokens and replay share;
  - net/best/worst delta, regressions, drift, drift velocity, efficiency.
- Sealed cohorts provide:
  - immutable manifest with content hashes and dataset hash;
  - `sealed: true`, `neverTrain: true`;
  - leak guard against seen content hashes/source URLs;
  - prospective/retention disjointness verification.
- The read-only production report measures six working advances:
  - net Δ vs `v493`: **+0.011532 nats**;
  - best: `v497` **−0.006051**;
  - worst: `v496` **+0.027715**;
  - 4/6 regressions vs stable;
  - drift velocity **+0.002306 nats/advance**;
  - no sealed prospective or retention cohort configured yet.

### 2.8 Tokenizer-aware validation supply

**Files:** `python/sma/measure.py`, `python/tests/test_measure.py`, `src/training/tokenizer-measurement.js`, `test/tokenizer-measurement.test.js`, `scripts/learning-effectiveness/measure-validation.mjs`, `src/admin/knowledge-accumulation.js`, `src/config.js`.

- Model-free Python measurement loads only the tokenizer and reports per-document tokens and packed block capacity.
- Node wrapper spawns it with an explicit tokenizer path and timeout.
- `measureValidationAvailability` augments the Node view with actual tokens, actual blocks and authoritative shortfall.
- Optional `KNOWLEDGE_TOKENIZER_MEASUREMENT=true` enables this in the admin knowledge view; default off to avoid Python spawn on every pull.
- Read-only production measurement:
  - 19 validation articles / 5 clusters;
  - estimated 1,547 tokens;
  - actual **1,208 tokens / 9 blocks**;
  - target 32 blocks; shortfall **23**;
  - only 1 document meets one block by itself.

### 2.9 Observability

**Files:** `src/admin/knowledge-accumulation.js`, `src/admin/public/brain/knowledge.js`, `src/admin/public/brain/brain.css`, `src/storage/registry-store.js`, `test/knowledge-observability.test.js`.

- Knowledge API now returns:
  - `funnel` (articles → reviewed → consumed → replayable → fresh trainable; retirement/replay loss);
  - `licence` buckets;
  - `learningEffectiveness` (summary, trajectory, limitations);
  - optional authoritative validation measurement.
- Brain UI renders the funnel, licence provenance, cumulative effect, working trajectory and actual tokenizer blocks.
- Existing pull-only architecture is preserved (no SSE, no timer).

---

## 3. Configuration added

See `.env.example` for full comments. New variables:

```text
CURATOR_STRATEGY=segmented
CURATOR_LEGACY_MAX_CHARS=14000
CURATOR_CHUNK_MAX_CHARS=12000
CURATOR_CHUNK_TARGET_CHARS=4000
CURATOR_CHUNK_MIN_CHARS=1000
CURATOR_MERGE_UNITS=true
CURATOR_MERGE_MIN_CHARS=800
CURATOR_MERGE_MAX_CHARS=6000

LICENCE_ENFORCEMENT=shadow

DISCOVERY_URL_QUALITY=enforce

REVIEW_PREFILTER_MODE=shadow
REVIEW_PREFILTER_MIN_CHARS=200
REVIEW_PREFILTER_MIN_WORDS=20

KNOWLEDGE_TOKENIZER_MEASUREMENT=false
```

No stable promotion gate, `eval-002`, `PROMOTE_*` threshold, checkpoint pointer or production job configuration was changed.

---

## 4. Verification

### Node

```text
824 tests
817 passed
0 failed
7 skipped
```

New tests:

- `test/licence.test.js` — 6
- `test/curator-segmentation.test.js` — 4
- `test/discovery-source-quality.test.js` — 4
- `test/review-prefilter.test.js` — 4
- `test/learning-effectiveness.test.js` — 4
- `test/retired-replay-audit.test.js` — 4
- `test/tokenizer-measurement.test.js` — 2
- `test/licence-backfill.test.js` — 1

### Python

```text
python/tests/test_working_checkpoint.py: passed
python/tests/test_measure.py: 2 passed
Full Python suite: all passing except the pre-existing CPU-only ROCm portability test
```

The CPU-only portability failure is unchanged from the starting baseline and is not caused by this work.

---

## 5. Known limitations and risks

1. **No sealed cohorts have been populated.** The framework is tested, but no never-trained prospective set or retention probe exists in the repository. Do not claim cumulative learning until they are scored.
2. **No production run has exercised the new curation/licence/optimiser defaults.** All measurements are read-only or isolated.
3. **Licence recovery is a policy decision.** The audit found zero safely recoverable records under the current conservative gate.
4. **Teacher cost will rise** with full-source segmentation. The chunk target must be calibrated against Ollama throughput.
5. **`raw-text` corpus mode is not enabled by this branch.** The measurement shows its potential; it must be tested end-to-end before adoption.
6. **The AdamW fix is a transition.** The next working run will change the no-decay group from `0.01` back to `0.0`; record it explicitly.

---

## 6. Recommended next phase

1. Create authorised sealed prospective and retention cohorts; score the current working lineage.
2. Run an isolated segmented/raw-text pipeline experiment with a frozen corpus and compare frozen/sealed/retention deltas.
3. Resolve the licence/completeness policy question for the 7,006 legacy records.
4. Prepare deployment and migration for approval; do not execute against production yet.
