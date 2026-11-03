# Pilot Results

All pilot runs used isolated stores under `/home/dave/sma-experiments/knowledge-accumulation-pilot-20261102/`. The real 62M lineage was the accessible `v389` from the controlled-experiment parent store; production `v482` weights were not readable by the audit user.

**No production model, article, gateway, pointer, service, timer or job was modified.**

## 1. Scenario matrix

| Scenario | Result | Evidence |
|---|---|---|
| **A — stable rejection, working acceptance** | `pilot-2`: stable rejected at −0.0613 nats; working accepted; `active.json` stayed `v001`; working advanced `v001 → v002`; 13 replay rows | `pilot-2.json` |
| **B — working rejection** | `pilot-b-2`: stable rejected −0.3308; working guard rejected; working stayed `v001`; 9 fresh deferred; `active.json` stayed `v389` | `pilot-b-2.json` |
| **C — interrupted commit** | Controlled commit-boundary recovery test: a `workingAdvanced` manifest with `consumed:false` was re-driven; working pointer restored; consumption committed once; active unchanged | `test/working-checkpoint-lifecycle.test.js`; `test/lifecycle-crash.test.js` |
| **D — replay after retirement** | `pilot-2` snapshot had 13 replay rows: 9 consumed REVIEWED + **4 RETIRED with explicit replay eligibility** | `pilot-2.json`; `pilot-articles/article-events.ndjson` |
| **E — cumulative drift / rollback** | Drift above budget rolls back to last-known-good; a broad/catastrophic regression is rejected. Real working rejection also exercised in B. | `test/working-checkpoint-lifecycle.test.js` |

## 2. Main pilot sequence

### Run 1 — baseline promotion path

| Item | Value |
|---|---|
| Stable parent | `v389` |
| Candidate | `v001` |
| Stable decision | **promoted** (improvement +0.00992; paired CI 0.0077..0.0144) |
| Working decision | accepted |
| Working pointer after | `v001` |
| Active pointer after | `v001` (strict promotion) |
| Snapshot | dataset-20261103-001, 10 rows, 9 fresh, 0 replay, 1 validation |
| Optimizer | fresh |
| Wall time | 22:45:55 → 22:48:10 (~2m15s) |

### Run 2 — stable rejection, working acceptance (Scenario A)

| Item | Value |
|---|---|
| Stable baseline | `v001` |
| Working parent | `v001` |
| Candidate | `v002` |
| Stable decision | **rejected** (improvement −0.0613; paired CI −0.0685..−0.0544) |
| Working decision | **accepted** (overall regression 0.0613; no catastrophic group regression) |
| Working pointer after | `v002` |
| Last-known-good | `v001` |
| Active pointer after | **`v001` unchanged** (byte-identical `active.json`; SHA-256 `784af17c4b3f822b4fb19ed39c8f46313dabe5a454b0fe05159e7da5d4e2f730`) |
| Snapshot | dataset-20261103-002, 30 rows: 15 fresh, 13 replay, 2 validation |
| Measured replay share | 53.85% (configured target 50%; measured, not enforced) |
| Optimizer | carried from `v001` (`carryOptimizerFrom = v001`) |
| Wall time | 22:48:31 → 22:51:40 (~3m09s) |

This is the central result: **the stable brain did not move, but the working learner accumulated the update.**

## 3. Working rejection sequence (Scenario B)

### Run 1 — bootstrap

| Item | Value |
|---|---|
| Stable parent | `v389` |
| Candidate | `v001` |
| Stable decision | rejected −0.0770 |
| Working decision | accepted |
| Working pointer | `v001` |
| Active | `v389` unchanged |
| Snapshot | 16 rows: 15 fresh, 0 replay, 1 validation |
| Wall time | 22:52:03 → 22:56:00 (~3m57s) |

### Run 2 — working rejection

| Item | Value |
|---|---|
| Stable baseline | `v389` |
| Working parent | `v001` |
| Candidate | `v002` |
| Stable decision | rejected −0.3308 (CI −0.3483..−0.2969) |
| Working decision | **rejected** (regression far above working budget) |
| Working pointer after | **`v001` unchanged** |
| Active pointer after | **`v389` unchanged** (SHA-256 `cb7c3344fa614ed3c5b4de351e729a89d9fbd5a644c6d7af2400360202cae28a`) |
| Snapshot | 16 rows: 9 fresh, 5 replay, 2 validation |
| Replay share | 39.85% |
| Optimizer | carried from `v001` |
| Deferred fresh articles | 9 |
| Wall time | 22:56:13 → 23:00:39 (~4m25s) |

The previous working checkpoint and its replay material remained intact.

## 4. Replay after retirement (Scenario D)

The `pilot-2` snapshot contained 13 replay rows. Mapping the replay article ids to the pilot article events gives:

- 9 `REVIEWED` consumed articles;
- **4 `RETIRED` articles with an explicit `replay-eligibility: true` event**.

The retired articles retained their consumption and review history and appeared in the training manifest. This is the direct proof that review retirement no longer implies replay ineligibility.

## 5. Interrupted commit (Scenario C)

The controlled test writes the manifest a process would leave at the working-commit boundary and invokes the real `recoverPendingPromotions()`:

- `workingAdvanced: true`, `consumed: false`, `workingVersion: v777`, `workingLastGoodVersion: v100`;
- recovery publishes if needed, restores last-good, sets `working.json`, consumes `freshArticleIds` once, and settles the manifest;
- `setActive` is never called;
- a second recovery is a no-op;
- a rejected manifest without working advancement is still deferred, never consumed (existing regression test).

This is a commit-boundary simulation, not an OS-level process kill. The code path is the same recovery function the in-process catch uses.

## 6. Cumulative drift and rollback (Scenario E)

`test/working-checkpoint-lifecycle.test.js` covers:

- accepted isolated group regression (working advances);
- drift above `maxDriftNats` → rollback to `working-last-good` before training;
- broad/catastrophic regression → working rejection;
- recovery of a working-advanced manifest without moving active.

Real `pilot-b-2` additionally exercised a working rejection with a large regression while the previous working checkpoint stayed loadable.

## 7. Resource measurements

| Item | Value |
|---|---|
| Pilot 62M CPU run time | 2m15s, 3m09s, 3m57s, 4m25s |
| Presented tokens per run | 5,888; 33,280; 51,200; 64,000 |
| Unique training tokens per run | 1,167; 3,311; 3,026; 3,267 |
| Working checkpoint size | ~708 MB (236 MB weights + 472 MB optimizer) |
| Main pilot store size | 1.7 GB (v389 + v001 + v002 + optimizer states) |
| Scenario B store size | 977 MB |
| Pilot article store size | 1.4 MB each |
| Snapshot size | 104 KB / 316 KB |

The pilot deliberately used small CPU budgets; these are not production throughput estimates. The controlled experiment measured ~1,550 training tokens/s on the ROCm X1 Pro for the same 62M model.

## 8. Test results

Node full suite:

```text
778 tests, 771 passed, 0 failed, 7 skipped
```

Python full suite (CPU-only test venv):

```text
254 passed, 20 skipped, 1 failed
```

The single failure is `tests/test_portability.py::test_rocm_environment_device_is_cuda_but_backend_is_rocm`; it requires a ROCm/CUDA-enabled torch build. The pilot venv is `torch 2.14.1+cpu`. All other Python tests pass, including the new working pointer/optimizer continuity tests.
