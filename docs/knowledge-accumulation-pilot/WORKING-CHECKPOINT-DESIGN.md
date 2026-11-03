# Durable Working Checkpoint — Design and Implementation

## 1. Pointers and identities

| Object | Path | Mutability | Serving? |
|---|---|---|---|
| Stable active | `$SMA_STORE/active.json` | moves only on strict promotion | **yes, only pointer** |
| Working | `$SMA_STORE/working.json` | moves on working acceptance/rollback | never |
| Last-known-good | `$SMA_STORE/working-last-good.json` | rollback anchor | never |
| Working version | `$SMA_STORE/vNNN/` + `COMMITTED` | immutable | not implicitly |
| Optimizer state | `$SMA_STORE/_runs/vNNN.train-state.pt` | per retained version | never |

Implemented in `python/sma/store.py`:

- `working_pointer_path`, `working_last_good_pointer_path`
- `set_working`, `set_working_last_good`
- `working_version`, `working_last_good_version`, `working_pointer`, `working_last_good_pointer`

A working version is a normal committed `vNNN`. It is not a separate artifact format and it is never read by serving code. `active.json` remains the only deployment pointer (`python/sma/store.py:1640`, `python/sma/brain.py:294`).

CLI:

```bash
python -m sma.brain working --out <store>
python -m sma.brain working --out <store> --set v123 --meta '{"runId":"run-1"}'
python -m sma.brain working --out <store> --set-last-good v122 --meta '{"reason":"rollback anchor"}'
```

Node adapter: `src/training/python-trainer.js` exposes `resolveWorking`, `setWorking`, `setWorkingLastGood`, and `resolveBaseline` (stable only).

## 2. Parent selection

`executeFullRun` now distinguishes:

- `stableBaselineVersion` — what the unchanged publication gate compares against;
- `workingParentVersion` / `trainingBaselineVersion` — what the candidate is trained from;
- `parentSelection` — `stable`, `stable-bootstrap-working`, `working`, `explicit`, `stable-fallback-working-error`, or `working-rollback-last-good`.

Normal Python runs (`TRAIN_USE_WORKING_CHECKPOINT=true`, default) resolve the working pointer first. If absent, they bootstrap from stable without moving `active.json`. If a working pointer exists but cannot be loaded, the run reports a deliberate fallback/error path rather than silently pretending the working checkpoint does not exist. An explicit dashboard parent still uses that parent for both training and comparison, preserving existing CLI/dashboard semantics.

## 3. Training and optimizer continuity

The trainer already stages a candidate as `vNNN.tmp`. The working path uses the same staging mechanism:

1. Load the working parent.
2. Train a staged candidate.
3. Evaluate candidate on the frozen eval set.
4. Run the working guard and the unchanged stable promotion gate.
5. Publish the candidate only if either decision accepts it.
6. Set the working pointer (and last-good anchor) on acceptance.
7. Never move `active.json` unless the stable gate promotes.

Optimizer moments are carried with `--carry-optimizer`:

- `python/sma/train.py:648` loads `carry_optimizer_state` after constructing AdamW, validates parameter/optimizer shape compatibility, and reapplies the current run's learning rate/betas/eps/weight-decay.
- `python/sma/brain.py:571` loads `_runs/<parent>.train-state.pt` when the parent is a working checkpoint.
- The run records `carryOptimizerFrom` in `train-state.json` and the Python result.
- Node records `optimizerState: "carried"` and `carryOptimizerFrom` in the training budget.

This is distinct from `--resume-from`: exact resume restores the sample order/RNG and requires an identical dataset hash; working carry restores only AdamW moments and permits a new corpus. Weights and optimizer state are committed together in the same staged checkpoint.

## 4. Commit and discard

- Stable promotion: publish staged candidate → set `active.json` → set working pointer → manifest complete → consume.
- Working-only acceptance: publish staged candidate as committed working version → set last-good to previous working/stable → set `working.json` → manifest complete → consume as `checkpointRole: "working"`.
- Working rejection: discard staged candidate (small record retained) → defer fresh batch → previous working and `active.json` unchanged.
- A stable rejection does **not** automatically delete the candidate when the working guard accepts it.

`ArticleStore.markConsumed` now records optional `checkpointRole` and `version`, while remaining exactly-once for the same article.

## 5. Crash recovery

The existing stable commit tail remains idempotent. A new `completeWorkingAdvancement()` re-drives a crashed working commit:

1. publish staged candidate if not already published;
2. restore the working last-good anchor;
3. set `working.json`;
4. commit consumption for `freshArticleIds` with `checkpointRole: "working"`;
5. settle the manifest.

`recoverPendingPromotions()` handles:

- `workingAdvanced: true` + `consumed: false` → working recovery, never active;
- `promoted` → existing stable publication/activation/consumption recovery;
- rejected/inconclusive without working advancement → defer, never consume.

No recovery step touches `active.json` unless the manifest decision is `promoted`.

## 6. Retention

For the 62M model a working checkpoint is ~236 MB of weights plus ~472 MB of AdamW moments (~708 MB). The pilot retained:

- stable active;
- working;
- last-known-good;
- committed versions needed for provenance.

The implementation does **not** prune working/last-good checkpoints automatically in this pilot. Retention policy remains explicit: never prune the current working, last-known-good or stable checkpoints; prune older working versions only with an explicit, audited operation. For 3B, a working checkpoint with optimizer state is ~30 GB or more and is not assumed affordable on the X1 Pro.
