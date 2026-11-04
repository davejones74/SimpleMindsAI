# Replay-Mix Correction

## Root cause

Replay was selected **before** document/source-disjoint validation partitioning. The selector sized replay against the pre-validation fresh rows. The partitioner then moved some fresh rows into validation, shrinking the final fresh training stream without re-sizing replay.

Observed production examples:

| Run | Pre-partition estimate | Measured final replay share |
|---|---:|---:|
| `run-420` | 19.99% | **63.4%** |
| `run-421` | 20.00% | **36.5%** |
| `run-422` | 20.04% | **41.3%** |
| `run-423` | ~20.0% | **39.3%** |
| `run-424` | ~20.0% | **67.1%** |
| `run-425` | 20.04% | **36.66%** |

The pre-partition estimate was not a final proportion. The final denominator must exclude validation rows.

## Correction

`src/dataset/snapshot.js` now exports `trimReplayToFreshTarget(rows, { replayPercent })`.

After validation roles are assigned, `src/training/lifecycle.js`:

1. identifies fresh training rows (not replay, not validation);
2. measures fresh training tokens on that final stream;
3. computes the replay target as `fresh × pct / (100 − pct)`;
4. keeps replay rows in deterministic order while the token total stays within that target;
5. drops replay rows that would exceed the target;
6. recalculates `corpusStats` from the final rows before baking the snapshot.

The initial replay selection is still deterministic; this is a post-partition correction, not a random resample.

## Safe behaviour when fresh material is insufficient

- If the final fresh training stream is empty, the target is zero and **all replay rows are dropped**. Excess replay is never substituted for missing fresh material.
- The existing no-eligible-material and minimum-training-data gates still apply after trimming; training may wait or fail closed rather than train on replay-only material.
- `TRAIN_REPLAY_PERCENT=0` removes all replay.
- `SNAPSHOT_INCLUDE_CONSUMED=true` full-backfill behaviour is deliberately not changed by this correction.

## Test evidence

The full Node suite passes: **795 tests, 788 passed, 0 failed, 7 skipped**.

New tests in `test/training-budget.test.js`:

- final fresh tokens, not pre-validation tokens, determine the target;
- exact final ratio is 20% in a 200-fresh / 50-replay fixture;
- validation rows are preserved;
- insufficient fresh material drops replay instead of substituting it;
- target zero removes all replay.

## Frozen run-425 simulation

Using the actual frozen `run-425` snapshot and the real tokenizer:

| Measure | Before correction | After correction |
|---|---:|---:|
| Fresh training tokens (actual) | 1,909 | 1,909 |
| Replay tokens (actual) | 1,105 | **467** |
| Validation tokens (actual) | 212 | 212 |
| Replay documents | 26 | 10 |
| Removed replay documents | — | 16 |
| Final replay share (actual) | **36.66%** | **19.65%** |

Evidence: [`evidence/replay-correction-simulation.json`](./evidence/replay-correction-simulation.json).

The corrected value is slightly below 20% because the selector uses the same deterministic char/4 estimate as the existing pipeline, and no remaining replay row fit without exceeding the target. The trainer-level run record after deployment will be the authoritative actual measurement.
