# Working Guard — Metrics, Thresholds and Failure Modes

## 1. Purpose

The working guard decides whether a candidate may become the next **cumulative-learning** checkpoint. It is deliberately separate from stable publication:

- It may accept a candidate that has not beaten the stable model globally.
- It must stop catastrophic per-source regression and cumulative drift.
- It must never move `active.json` or weaken the stable gate.

Implementation: `src/training/working-guard.js` (`working-guard-v1`). Pure function; every decision is recorded on the run, contribution ledger and working pointer.

## 2. Metrics recorded

- candidate / working-parent / stable losses;
- overall regression vs the working reference;
- drift vs the stable baseline;
- number of source groups compared;
- number of groups with a regression larger than the group threshold;
- regressed-group share;
- worst group and its token weight;
- guard decision and human-readable reason.

The source groups come from the paired per-document evaluation already used by the stable gate; no new evaluation metric was introduced.

## 3. Default thresholds

| Threshold | Default | Rationale |
|---|---:|---|
| `WORKING_GUARD_MAX_REGRESSION_NATS` | 0.05 | A small overall regression can be useful learning; a large one should not advance the working parent |
| `WORKING_GUARD_MAX_GROUP_REGRESSION_NATS` | 0.15 | Blocks a catastrophic single-source regression while allowing isolated changes |
| `WORKING_GUARD_MAX_DRIFT_NATS` | 0.25 | Bounds cumulative distance from the stable baseline |
| `WORKING_GUARD_MIN_GROUP_TOKENS` | 100 | Avoids deciding on tiny groups |
| `WORKING_GUARD_MAX_REGRESSED_GROUP_SHARE` | 0.75 | Blocks a broad regression even if the worst group is under the individual threshold |
| `WORKING_GUARD_MIN_GROUPS` | 5 | Requires enough group evidence before applying the share rule |

These are conservative starting values, not validated scientific constants. They are configurable and exposed; the pilot used a slightly wider overall/group allowance (0.10 / 0.20) to test useful rejected-candidate retention, and the difference is recorded in the pilot results.

## 4. Decision order

1. Candidate finite and valid.
2. Stable baseline finite (when supplied).
3. Drift vs stable ≤ `maxDriftNats`.
4. Regression vs working parent ≤ `maxRegressionNats`.
5. Regressed-group share ≤ `maxRegressedGroupShare` (when enough groups).
6. Accept; record isolated regressions even when accepted.

A rejected candidate leaves the previous working checkpoint intact. A working pointer whose recorded drift already exceeds `maxDriftNats` is rolled back to `working-last-good` before the next training run.

## 5. What the guard does not do

- It does not replace the frozen-eval paired-bootstrap gate.
- It does not change `PROMOTE_MIN_LOSS_DELTA`, `PROMOTE_MIN_GROUPS`, CI level, minimum blocks/tokens or finite-loss checks.
- It does not decide serving. `active.json` moves only on strict promotion.
- It does not claim a retained article is remembered by the weights. It preserves the update in a working checkpoint; replay remains a separate retention mechanism.

## 6. Failure modes

| Failure | Guard action | Stable action | Batch |
|---|---|---|---|
| Non-finite candidate | reject | unchanged | deferred |
| Candidate worse than stable by > drift budget | reject | unchanged | deferred |
| Candidate worse than working parent by > regression budget | reject | unchanged | deferred |
| One source group regresses catastrophically | reject | unchanged | deferred |
| Broad group regression | reject | unchanged | deferred |
| Candidate within budgets | accept | stable gate decides independently | consumed into working |
| Working pointer already drifted beyond budget | rollback to last-good, then train | unchanged | previous working retained |

## 7. Pilot evidence

- `pilot-2`: stable gate rejected at **−0.0613 nats**; working guard accepted. Working advanced `v001 → v002`; `active.json` stayed at `v001`.
- `pilot-b-1`: stable gate rejected at **−0.0770 nats**; working guard accepted. Working advanced `v389 → v001`; `active.json` stayed `v389`.
- `pilot-b-2`: stable gate rejected at **−0.3308 nats**; working guard rejected. Working stayed `v001`; 9 fresh articles deferred; `active.json` stayed `v389`.
- `test/working-checkpoint-lifecycle.test.js`: drift above budget triggers rollback to last-known-good; accepted isolated group regression is recorded; broad/catastrophic regression is rejected.
