# Phase 1 Closure and Validation Readiness Report — 2026-10-30

Bounded closure task on Stages 1–3. No deployment, production training/evaluation, production data mutation, article consumption, promotion, acquisition job, or timer start occurred.

## 1. Exact files changed in this closure task

| File | Purpose |
|---|---|
| `src/training/runtime-fingerprint.js` (new) | Node/Python/backend dependency and runtime fingerprint; identity vs metadata split |
| `src/training/candidate-identity.js` | Includes runtime identity in the candidate key; keeps runtime metadata informational |
| `scripts/run-staged-production-candidate.mjs` | Computes runtime fingerprint before keying; requires prospective-only validation env |
| `src/config.js` | Node production config accepts only `document-source-disjoint`; prospective-only defaults true |
| `src/training/lifecycle.js` | Fail-closed validation policy/prospective guard; optional test override; historical exposure includes consumption/contribution ledgers |
| `src/training/python-trainer.js` | Passes `--require-prospective-validation` to Python |
| `python/sma/train.py` | Rejects legacy tail split unless explicit; rejects document policy without prospective assertion |
| `python/sma/brain.py` | Production defaults, explicit legacy/prospective flags, richer provenance |
| `python/sma/portability.py` | Runtime environment now records tokenizers/numpy/safetensors/accelerate/hub versions and device/arch |
| `.env.example` | Documents production validation policy and prospective requirement |
| `test/runtime-fingerprint.test.js` (new) | Runtime determinism/invalidation; metadata non-invalidation |
| `python/tests/test_validation_policy.py` (new) | CLI/library validation-policy fail-closed tests |
| `python/tests/test_provenance_smoke.py` (new) | Gated real init/train provenance smoke test |
| `test/python-trainer.test.js` | Lifecycle guard and provenance smoke coverage |
| `test/jobs-resilience.test.js` | Test supplies paired evidence and fresh prospective material |
| `python/tests/test_training.py` | Explicit legacy opt-in for isolated corpus-info fixtures |
| `docs/PHASE1-IMPLEMENTATION-REPORT-2026-10-30.md` | Earlier Stages 1–3 report (still untracked) |

Earlier Stage 1–3 files remain changed/untracked. Pre-existing unrelated working-tree changes were preserved.

## 2. Production-reachable Python call-path findings

Traced call paths:

- `sma.brain train` CLI → `cmd_train` → `_cmd_train_locked` → `TrainConfig.validate()` → `train_mod.train()` → `data.pack_for_training()`.
- `python/sma/brain.py` `cmd_train` fallback is now `document-source-disjoint`, not `legacy-tail-split`.
- The CLI parser defaults to `document-source-disjoint`.
- `TrainConfig.validate()` now rejects:
  - `legacy-tail-split` unless `allowLegacyValidation=True`.
  - `document-source-disjoint` unless `requireProspectiveValidation=True`.
- `cmd_train` passes `--allow-legacy-validation` and `--require-prospective-validation` only when explicitly requested.
- `pythonTrainer` always passes `--validation-policy` and, when configured, `--require-prospective-validation`.
- Node `config.trainValidationPolicy` accepts only `document-source-disjoint`; setting `legacy-tail-split` fails config parsing.
- `executeFullRun` rejects Python training before the run lock/snapshot if the policy is not document/source-disjoint or prospective-only is false, with `INVALID_VALIDATION_POLICY` or `PROSPECTIVE_VALIDATION_REQUIRED`.
- `cmd_corpus_info` defaults to document/source-disjoint. It is a preflight, not a training path, and does not itself inspect historical exposure.
- `data.pack_for_training()` remains a low-level library function whose default is legacy. It does not train; all production training entry points validate the policy before calling it. Isolated fixture tests may call it directly. If Dave wants the low-level packer itself to reject legacy by default, that is a follow-up change.
- `cmd_eval` is a frozen-evaluation path and does not use training validation splitting.

No production training invocation can select legacy tail splitting through Node configuration or the Python CLI without an explicit legacy test opt-in.

## 3. Environment fingerprint specification

New module: `src/training/runtime-fingerprint.js`.

### Identity inputs (invalidate candidate reuse)

- Node version.
- Node lockfile content digest: `package.json`, `package-lock.json`.
- Python requirement-file content digest: `requirements.txt`, `requirements-cuda.txt`, `requirements-rocm.txt`.
- Python version and implementation.
- Actual installed versions of: `torch`, `transformers`, `tokenizers`, `numpy`, `safetensors`, `accelerate`, `huggingface_hub`.
- Accelerator runtime: `backend`, `buildBackend`, `backendVersion`, device `archString` (e.g. `gfx1150`/compute capability).

### Informational metadata (retained, does not invalidate)

- Python executable path.
- Device name.
- Total device memory and whether it is shared.
- Platform probe error, if any.

The candidate key includes `runtime.identity`; `runtimeMetadata` is retained alongside but excluded from the key. Tests prove same inputs + changed device name/memory keep the key stable, while changed Torch/tokenizer/backend/Node/lockfile invalidates it.

Python train-state/provenance also records the richer environment via `portability.runtime_environment()`, plus parent weight fingerprint, trainer code fingerprint, seed, split hash, corpus file hashes, runtime wall time and peak RSS.

## 4. Prospective validation enforcement details

Required production settings:

```text
TRAIN_VALIDATION_POLICY=document-source-disjoint
TRAIN_VALIDATION_REQUIRE_PROSPECTIVE=true
```

Enforcement:

- Node config rejects any other policy value.
- `executeFullRun` checks both requirements before acquiring the run lock, collecting material, or creating a TrainingRun.
- The partitioner classifies prospective vs historical from prior snapshots, fresh/replay roles, consumption records and contribution records.
- If no prospective cohort is available: `INSUFFICIENT_VALIDATION`.
- If the prospective cohort is too small: `INSUFFICIENT_VALIDATION`.
- Historical exposure remains visible in the partition manifest as `prospective-only`, `mixed` or `historical-only`.
- Historical material is never relabelled as prospective.
- `eval-002` was not changed.

Python cannot itself inspect the Node historical-exposure ledgers. It receives an explicit `--require-prospective-validation` assertion and records it; Node remains the authority for that assertion. This is documented rather than hidden.

## 5. Smoke-test evidence

### Python real init/train smoke

Gated test: `python/tests/test_provenance_smoke.py`, run with `SMA_RUN_SMOKE=1`.

Observed in a temporary store:

- v001 initialised from random init; `initialisationType: RANDOM`, `pretrainedWeightsUsed: false`.
- v002 trained from v001 for 2 steps, seed 17, CPU float32.
- `parentWeightFingerprint` persisted.
- `trainerCodeFingerprint` persisted (12 Python files).
- `trainingSeed: 17`.
- `validationSplit.policy: document-source-disjoint`, non-empty `splitHash`.
- `corpusSplit.mode: role-appended`.
- Train/validation tokens separated: 8,000 train / 3,200 validation tokens; 2 validation blocks.
- `selectedStep: 1`, `selectedValidationLoss` recorded.
- 76 tensor hashes persisted in `init-manifest.json`.
- 74/74 parameters changed; 0 buffers drifted.
- `COMMITTED` records parent v001 and 2 completed steps.
- Corpus file SHA-256 persisted.

This is provenance/lifecycle evidence only, not evidence of learning quality.

### Node lifecycle provenance smoke

Added to `test/python-trainer.test.js` with a fake trainer:

- Candidate identity is recorded on the run.
- Partition policy, split hash and assignment file are recorded on the snapshot.
- Evaluation evidence file is written under `registry/evaluations/*.evidence.json`.
- Parent/candidate per-document rows, paired result and bootstrap seed are retained.
- Generation prompt-bank version and samples are retained.

## 6. Read-only prospective validation availability

Method: read-only `ArticleStore` + read-only production registry, current raw-text cleaning, English-first policy, no snapshot created, no articles consumed.

| Metric | Value |
|---|---:|
| Included corpus rows | 2,106 |
| Fresh rows reported by collection | 2 |
| Documents prospectively unexposed | 0 |
| Documents historically exposed | 2,106 |
| Documents with uncertain exposure within available ledgers | 0 |
| Distinct content clusters | 388 |
| Prospective content clusters | 0 |
| Historical content clusters | 388 |
| Mixed-exposure clusters | 0 |
| Distinct source families | 394 |
| Distinct publishers | 145 |
| Estimated prospective validation tokens | 0 |
| Estimated historical tokens | 772,173 |
| Estimated maximum source-disjoint validation blocks | 0 |
| Configured minimum validation tokens | 4,096 |
| Configured minimum validation clusters | 1 |
| Configured minimum can be met | **No** |

Corpus composition in this read-only assessment:

- 185 full-text rows, 204 fallback rows, 1,717 curated rows.
- Token estimate: 690,127 full-text; 16,783 fallback; 65,263 curated.
- Language tokens: 752,535 English; 17,252 undetermined; 2,386 Dutch.
- Top-1 source share: 6.35%; top-10 source share: 32.47%.
- Top-1 publisher share: 35.68%; top-10 publisher share: 68.80%.
- Source Herfindahl: 0.0165; publisher Herfindahl: 0.1474.

**Conclusion:** there is currently **no prospective validation material** in the production-ledger view. The two “fresh” articles are already historically exposed through prior snapshots/ledgers. The configured prospective-only candidate workflow cannot start without new, unexposed material. The split policy was not relaxed and historical data was not substituted.

Largest uncertainty: isolated experiment corpora outside the production registry/store are not represented in this ledger assessment.

## 7. Test results

- `git diff --check`: clean.
- Full Node suite: **722 tests, 715 passed, 0 failed, 7 skipped**.
- Focused Python:
  - `test_corpus_roles.py`
  - `test_validation_policy.py`
  - `test_training.py`
  - `test_eval_record.py`
  - `test_preflight.py`
  - all passed.
- Gated real provenance smoke: passed with `SMA_RUN_SMOKE=1`.
- Python venv emits an existing `sys.prefix`/`sys.exec_prefix` warning; results unaffected.
- Test temp directories were redirected to the root filesystem because `/tmp` hit its tmpfs quota. This was an environment limitation, not a test failure.
- Full Python suite was not run; focused relevant tests were used.

No production training experiment was run.

## 8. Remaining limitations

- No prospective validation material currently exists; a controlled candidate experiment cannot start until new unexposed material is acquired and reviewed.
- The low-level `data.pack_for_training()` default remains legacy; only production training entry points enforce the policy. Direct callers can still request legacy explicitly.
- Python trusts the Node `--require-prospective-validation` assertion; it cannot independently reconstruct historical exposure.
- Runtime fingerprint records installed package versions and lock/requirement content, not hashes of every installed wheel or transitive dependency.
- CPU model, OS/kernel and low-level numerical library versions are not identity inputs; backend/architecture and package versions are.
- Isolated experiments outside the production registry/store are not represented in the historical-exposure report.
- Independent final test, multi-seed experiments, expanded generation protocol and acquisition jobs remain unimplemented.
- `eval-002` remains a development benchmark.
- The gated smoke test requires network/cached Hugging Face config/tokenizer access.
- No commit or push was performed.

## 9. Git and production status

- HEAD: `9324fbf`.
- No commit and no push.
- Working tree: 50 status entries, including pre-existing unrelated changes, earlier Stage 1–3 work, and this closure work.
- New closure files are untracked.
- Production state unchanged:
  - `/var/lib/simpleminds/store/active.json` still v389.
  - Production registry mtimes remain before this task.
  - No production files were written after this task began.
- Perpetual timer remains paused.

## 10. Recommendation

The implementation is hardened for production-reachable validation enforcement and reproducibility. However, the prospective-only policy cannot currently be satisfied: the read-only assessment found zero prospective documents/clusters. Therefore:

1. Do not start a controlled candidate experiment yet.
2. Acquire and review genuinely new, unexposed material first.
3. Then re-run the prospective-availability assessment.
4. Only after that should Dave decide whether to proceed to the independent final-test architecture.

Decisions requiring Dave’s approval: acquisition of new prospective material; whether to make the low-level packer reject legacy by default; whether to fingerprint OS/kernel/CPU details; and authorisation of the next controlled candidate experiment.
