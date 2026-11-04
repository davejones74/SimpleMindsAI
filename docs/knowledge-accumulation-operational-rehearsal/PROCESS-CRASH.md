# Full 62M Training-Process Interruption and Recovery

All runs used the real 62M `v389`/`v001` lineage, ROCm (`torch 2.12.0+rocm7.14.0`, Radeon 890M), isolated stores and a fresh 32-article pilot corpus. No production process or store was touched.

## 1. Mid-training process kill

Method: start the real Node lifecycle; it spawns the real Python `sma.brain train` child. The rehearsal killed the Python child with `SIGKILL` while training was in progress (step 10/120).

Result:

| Check | Result |
|---|---|
| Training child terminated | yes (`python exited null`) |
| Candidate checkpoint created | no |
| Staged `.tmp` candidate | none |
| Active `v389` | unchanged (same SHA-256) |
| Working `v001` | unchanged (same SHA-256) |
| Last-good `v389` | unchanged (same SHA-256) |
| Consumption | 6 before / 6 after |
| Existing weights/optimizer | unchanged |
| Recovery | `recoverPendingPromotions` returned no pending work |

Evidence: `proc-mid-run.json`, `proc-mid-before.json`, `proc-mid-after.json`, `proc-mid-recovery.json`.

**Conclusion:** a killed in-flight training process cannot publish or consume. The previous working state remains intact.

## 2. Real training completed, killed after working pointer before consumption

Method: run the real 62M training to completion; the working guard accepted `v002`; the process was killed after `working.json` advanced to `v002` and before the consumption commit.

| Check | Result |
|---|---|
| Stable decision | rejected |
| Working decision | accepted |
| Working pointer | `v002` |
| Last-good | `v001` |
| Active | `v389` **unchanged** |
| Consumption before recovery | 6 (seed only) |
| Recovery | consumed the fresh batch |
| Consumption after recovery | 28 lines, 28 unique `(runId, articleId)` pairs |
| Second recovery | no additional recovery, no duplicate consumption |
| `v002/model.safetensors` | present (247,367,192 bytes) |
| `_runs/v002.train-state.pt` | present (494,800,839 bytes) |
| `v002/COMMITTED` | present |
| Replay eligibility | base 6 replay/retired; after recovery 28 replay-eligible; no existing eligibility lost |

Evidence: `proc-after-run-manifest.json`, `proc-after-recovery-1.json`, `proc-after-recovery-2.json`, `proc-after-baseline.json`, `process-crash-summary.json`.

**Conclusion:** the recovery path re-drives pointer/consumption state exactly once, keeps weights and optimizer paired, preserves replay eligibility and does not move `active.json`.

## 3. Disabling working-checkpoint training

Method: copy a store with active `v389`, working `v002`, last-good `v001`; run a bounded 62M training with `TRAIN_USE_WORKING_CHECKPOINT=false`; kill after training before candidate evaluation to avoid changing stable state.

Result:

| Check | Result |
|---|---|
| `parentSelection` | `stable` |
| Parent version | `v389` |
| Working pointer | `v002` unchanged |
| Last-good | `v001` unchanged |
| Active | `v389` unchanged |
| Consumption | 6 unchanged |
| Working history | v001/v002 retained |
| Staged candidate | `v003.tmp` retained for inspection |

Evidence: `proc-disabled-run-manifest.json`.

**Conclusion:** disabling working-checkpoint training restores stable-parent behaviour without deleting working history.

## 4. Limitations

- The mid-training kill targets the actual Python training child. The after-pointer/disabled tests target the Node orchestrator at the commit boundary after real training has completed.
- The corpus is a small bounded pilot subset (~7.7k estimated tokens), not the full 7.75M-token corpus.
- Stable `active.json` was never changed; no stable promotion occurred in these crash scenarios.
