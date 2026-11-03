# Implementation Report

## 1. Status and safety

| Item | Value |
|---|---|
| Branch | `knowledge-accumulation-pilot-20261102` |
| Base commit | `16a04c33e4f284ee6d1d9ca0dd56e2602f55531a` |
| Implementation commit | `13a0962` (code/tests); docs/manifest follow-up commit |
| Production mutation | **none** |
| Production service/job/timer restart | **none** |
| Production migration/activation | **none** |
| Full 7.75M-token run | **not attempted** |
| 3B training | **not attempted** |

Production article/gateway/model stores were opened read-only. The pilot used isolated stores under `/home/dave/sma-experiments/knowledge-accumulation-pilot-20261102/`.

## 2. Changed files

### Core implementation

| File | Change |
|---|---|
| `src/domain/article.js` | `UNRESOLVED`; `isReplayEligible`, independent `isReplayPool`, `isReplayExcluded`, replay text integrity |
| `src/storage/article-store.js` | durable `replay-eligibility` events; `setReplayEligibility`/`excludeFromReplay`; replay stats; replay-page filters; consumption `checkpointRole`/`version`; contribution working fields |
| `src/dataset/snapshot.js` | replay reservoir uses the independent eligibility property; retired replay-eligible rows included |
| `src/training/lifecycle.js` | working/stable parent separation; working guard; working commit/discard; stable gate unchanged; active unchanged on working-only acceptance; working crash recovery; rollback on cumulative drift; manifest/run provenance |
| `src/training/working-guard.js` | new pure working guard (`working-guard-v1`) |
| `src/training/python-trainer.js` | `resolveWorking`, `setWorking`, `setWorkingLastGood`, `--carry-optimizer`, stable/working baseline separation |
| `src/jobs/training.js` | pass consumption metadata through the exactly-once commit |
| `src/config.js` | `TRAIN_USE_WORKING_CHECKPOINT`, `TRAIN_CARRY_OPTIMIZER`, `WORKING_GUARD_*` |
| `src/graphql/schema.graphql` | `UNRESOLVED` enum value |
| `python/sma/store.py` | working/last-good pointers |
| `python/sma/brain.py` | `working` CLI; `--carry-optimizer`; carry state provenance |
| `python/sma/train.py` | validated AdamW-moment carry across a new corpus |
| `scripts/knowledge-pilot/*` | baseline capture, replay migration, pilot corpus builder, pilot runner, licence policy |
| `test/replay-eligibility.test.js` | replay independence/migration tests |
| `test/working-checkpoint-lifecycle.test.js` | working acceptance/rejection/recovery/rollback tests |
| `python/tests/test_working_checkpoint.py` | pointer and optimizer continuity tests |

## 3. Key behaviours implemented

1. **Retiring from review does not remove explicit replay eligibility.** A `RETIRED` article with `replayEligible:true` appears in the replay reservoir.
2. **Explicit rejection/quarantine/uncertainty still prevents replay.** The guard is not a blanket restoration.
3. **Historical migration is conservative and idempotent.** Production was dry-run only; apply is refused against production paths.
4. **Normal Python training resolves the working pointer first.** If absent, it bootstraps from stable without moving `active.json`.
5. **Working-only acceptance publishes a committed working version and consumes the fresh batch into that retained learning state.**
6. **A stable rejection does not delete the candidate when the working guard accepts it.**
7. **Working rejection discards the candidate and defers the batch; previous working and active remain intact.**
8. **Optimizer moments are carried across a new corpus.** The state is shape-validated; weights and optimizer state are committed together.
9. **Cumulative drift above the budget rolls back to last-known-good before training.**
10. **`active.json` moves only on strict promotion.** Working state is never served.

## 4. Test results

### Node

```text
npm test
778 tests, 771 passed, 0 failed, 7 skipped
```

New focused suites:

- `test/replay-eligibility.test.js` — 5 tests pass.
- `test/working-checkpoint-lifecycle.test.js` — 6 tests pass.
- Existing lifecycle/crash/dataset/article-store suites pass.

### Python

```text
python -m pytest
254 passed, 20 skipped, 1 failed
```

The failure is environment-specific:

```text
tests/test_portability.py::test_rocm_environment_device_is_cuda_but_backend_is_rocm
AssertionError: Torch not compiled with CUDA enabled
```

The pilot venv is CPU-only (`torch 2.14.1+cpu`). All other Python tests pass, including `test_working_checkpoint.py`.

## 5. Commit IDs

The implementation is committed on `knowledge-accumulation-pilot-20261102`. The exact commit is recorded in [`PILOT-MANIFEST.json`](./PILOT-MANIFEST.json); the base commit is `16a04c33e4f284ee6d1d9ca0dd56e2602f55531a`.

The working tree used for the pilot is the repository worktree; pilot data/checkpoints are outside the repository. No production worktree or store was used.

## 6. Storage and runtime

- Working checkpoint: ~708 MB (236 MB weights + 472 MB AdamW).
- Main pilot store: 1.7 GB (v389 + v001 + v002 + optimizer states).
- Scenario B store: 977 MB.
- Pilot corpus stores: 1.4 MB each.
- Real 62M CPU pilot runs: 2m15s, 3m09s, 3m57s, 4m25s.
- Presented tokens: 5,888; 33,280; 51,200; 64,000.
- Unique training tokens: 1,167; 3,311; 3,026; 3,267.

The pilot did not raise `TRAIN_MAX_STEPS` globally. It used small per-run caps. Full-corpus consolidation scheduling is a separate Phase 3 recommendation.

## 7. Limitations

1. **Production `v482` weights were not readable**; the pilot used the accessible `v389` 62M lineage.
2. **The pilot corpus is small** (32 source articles, ~7.7k estimated tokens). It exercises lifecycle decisions, not learning quality at scale.
3. **The working guard thresholds were widened for the pilot** (`0.10` overall / `0.20` group) to test useful rejected-candidate retention; production defaults remain `0.05` / `0.15`.
4. **Scenario C is a commit-boundary simulation**, not an OS-level process kill.
5. **No full replay migration was applied to production.** The 377 eligible / 3,875 unresolved dry-run classification is conservative and source-family-based.
6. **No automatic working-version pruning** is enabled in this pilot. Retention is explicit.
7. **No 3B work**; full 3B fine-tuning remains outside X1 Pro affordability assumptions.
8. **Contribution coverage is partial**; the existing ledger covers recent completed runs.

## 8. Risks and controls

| Risk | Control |
|---|---|
| Working drift/overfitting | working guard, drift budget, replay, rollback |
| Working pointer confused with serving | `active.json` is a separate pointer; serving code never reads working |
| Corrupt/stale optimizer paired with weights | shape validation in `train.py`; staged commit pairs weights + optimizer |
| Migration restores bad material | conservative licence policy; explicit rejection/quarantine checks; dry-run; production apply refused |
| Working checkpoint storage growth | explicit retention; no automatic unlimited retention |
| Crash at commit boundary | idempotent recovery for stable and working; working never moves active |
| Test suite environment drift | Python ROCm test remains environment-specific; CPU-only failure reported, not hidden |

## 9. Recommended next phase

1. **Review this pack** and the dry-run migration report.
2. **Run a production-safe replay migration rehearsal** on a verified snapshot copy; do not apply yet.
3. **Authorise a bounded production-adjacent pilot** with the default working guard, a larger accepted corpus, and explicit consolidation scheduling.
4. **Then** consider enabling `TRAIN_USE_WORKING_CHECKPOINT` in the deployed environment (requires service restart) and a separately authorised historical migration.
5. Keep `active.json`, frozen eval, stable promotion thresholds, random-init/no-pretrained guarantees and all production jobs unchanged until that authorisation.
