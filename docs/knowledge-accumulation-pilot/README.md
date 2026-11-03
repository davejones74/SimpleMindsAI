# Bounded Knowledge Accumulation Pilot

**Status:** implementation and isolated pilot complete. No production migration, activation, service restart, acquisition or training occurred.  
**Branch:** `knowledge-accumulation-pilot-20261102`  
**Base commit:** `16a04c33e4f284ee6d1d9ca0dd56e2602f55531a`  
**Implementation commit:** `13a0962` (code/tests); documentation/manifest commit follows.

This package implements two changes:

1. **Independent replay eligibility** — an article can remain replay-eligible after review retirement. Historical records are classified by an idempotent migration; production is dry-run only.
2. **Durable working checkpoint** — normal training can start from a committed working checkpoint, with optimizer-state continuity, a separate working guard, and rollback to last-known-good. `active.json` remains the only serving pointer.

## Navigation

| Document | Contents |
|---|---|
| [`BASELINE.md`](./BASELINE.md) | Pre-change production state |
| [`REPLAY-MIGRATION.md`](./REPLAY-MIGRATION.md) | Eligibility rules, dry-run, migration safety |
| [`WORKING-CHECKPOINT-DESIGN.md`](./WORKING-CHECKPOINT-DESIGN.md) | Pointers, lineage, optimizer state, recovery |
| [`WORKING-GUARD.md`](./WORKING-GUARD.md) | Guard metrics, thresholds, pilot calibration |
| [`PILOT-RESULTS.md`](./PILOT-RESULTS.md) | Scenarios A–E and measured outcomes |
| [`IMPLEMENTATION-REPORT.md`](./IMPLEMENTATION-REPORT.md) | Changed files, tests, storage/runtime, risks |
| [`PILOT-MANIFEST.json`](./PILOT-MANIFEST.json) | Reproducibility manifest and hashes |

Machine-readable evidence is in `baseline.json`, `replay-migration-dry-run.json`, `pilot-corpus-manifest.json`, `pilot-b-corpus-manifest.json`, and `pilot-*.json`.

## Key result

- The real 62M lineage (accessible `v389`) was used in isolated stores.
- A stable rejection at `-0.0613` nats still advanced the working checkpoint (`v001` → `v002`) while `active.json` stayed byte-identical at `v001`.
- A working-guard rejection at `-0.3308` nats kept the previous working checkpoint and deferred the batch; `active.json` stayed at `v389`.
- A snapshot included 13 replay rows, including 4 `RETIRED` articles restored with explicit replay eligibility.
- Optimizer moments were carried from the working parent in the second runs (`carryOptimizerFrom` recorded).
- All Node tests pass; Python tests pass except one ROCm-only portability test that requires a CUDA/ROCm build (the pilot venv is CPU-only).

## Safety boundaries observed

No production service, timer, job, environment variable, active pointer, checkpoint, article, review, consumption record or queue was modified. Production article/gateway/model stores were opened read-only. All pilot stores and checkpoints are under `/home/dave/sma-experiments/knowledge-accumulation-pilot-20261102/`.
