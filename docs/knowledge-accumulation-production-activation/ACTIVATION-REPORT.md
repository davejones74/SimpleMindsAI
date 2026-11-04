# Production Activation Report

## 1. Repository reconciliation

| Item | State |
|---|---|
| Production checkout | `/home/dave/Repositories/SimpleMindsAI` |
| Production HEAD before activation | `79a9f2c` on `knowledge-accumulation-pilot-20261102` |
| Release branch | `knowledge-accumulation-release-readiness-20261103` at `7f49a8f` |
| Relationship | Production HEAD is an ancestor of release (`79a9f2c..7f49a8f`, 4 commits) |
| Rehearsal branch | `knowledge-accumulation-operational-rehearsal-20261103` at `d5b8309` |
| Activation branch | `knowledge-accumulation-production-activation-20261104` |
| Deployed code commit | `15c817b` |
| Production repo branch moved? | No; deployment came from the activation worktree |

The release branch was preserved. No release or pilot commit was rewritten.

## 2. Rehearsal and backup verification

- Operational rehearsal manifest hashes verified: all document/script hashes matched.
- Rehearsal backup archives verified:
  - `model-store.tar` `0309853149a39ba14f78d3a9cdb9cd8e0e34659abe6b8674ed45187be82a38b2`
  - `production-ledgers.tar` `540150ddfca8df69abfec0aa85fdf4de81a116edd37e155a4aff4b320d9c09ca`
- Fresh production backup taken with the service stopped:
  - archive `store-and-data.tar` (23,808,942,080 bytes) `b653c5944fb695a82f69997e098aa880bef9dee90d306c617266aa40964655e8`
  - environment backup `d666fbe492b8e2a678fbd56bff4c003f5c773d049db581fcfd4e8012ae33aca1`
  - pre-apply article snapshot (`articles-before`, 6 files) manifest hash `1daacba8017939b2b5dedeae629d44412a3885d6f77ec1d04a9bd5cffc2b17fb`
- Active checkpoint `v493` before deploy:
  - model SHA-256 `20ca3a77eb8889e2614a893e288b0b3dbe0e745a6fd309e633d720c9c41096a9`
  - init manifest SHA-256 `b65704f110b8a01323e3b4431ee7c21e1b44849fb626279240140b749f310d03`
  - optimizer state SHA-256 `4e5390f24a97b9e49201f425249936d1180f2d034adfb176ca9935899145e13f`

## 3. Deployment

Deployed source commit `15c817b`, based on release `7f49a8f` plus activation tooling. Core release implementation includes:

- `working-guard-v2` defaults `0.05 / 0.15 / 0.10 / 100 / 0.75 / 5`.
- durable working pointer and optimizer carry.
- atomic pointer writes and working/last-good prune protection.
- Python optimizer mode recording.
- replay migration with an explicit production apply flag (not enabled by default).
- fail-closed prospective validation restored after the one-off bootstrap run.

Deployment backup: `/opt/simpleminds/.deploy-backup/deploy-20261104T092218Z`.
Deployed file hashes: `DEPLOYED.sha256` in that directory.

## 4. Replay migration

Applied to `/var/lib/simpleminds/data/articles` using the reviewed dry-run and the pre-apply snapshot.

| Classification | Before | Applied | After |
|---|---:|---:|---:|
| Scanned | 25,612 | 25,612 | 25,612 |
| `ELIGIBLE` | 377 | 377 | 0 |
| `ALREADY_ELIGIBLE` | 7,283 | 7,283 | 7,660 |
| `UNRESOLVED` | 3,878 | 3,878 | 3,878 |
| `INELIGIBLE` | 13,977 | 13,977 | 13,977 |
| `NOT_TARGET` | 97 | 97 | 97 |

The source snapshot and production dry-run matched exactly before apply. The apply restored exactly 377 records. Original article/review/consumption ledgers were preserved in the full backup and pre-apply snapshot; apply appended replay-eligibility events only.

## 5. Working bootstrap and effective configuration

The production root had no working pointer before activation. Working and last-known-good were explicitly bootstrapped to the then-active `v493`, with provenance metadata pointing at the existing optimizer state.

| Setting | Effective value |
|---|---|
| `TRAIN_USE_WORKING_CHECKPOINT` | `true` |
| `TRAIN_CARRY_OPTIMIZER` | `true` |
| `WORKING_GUARD_MAX_REGRESSION_NATS` | `0.05` |
| `WORKING_GUARD_MAX_GROUP_REGRESSION_NATS` | `0.15` |
| `WORKING_GUARD_MAX_DRIFT_NATS` | `0.10` |
| `WORKING_GUARD_MIN_GROUP_TOKENS` | `100` |
| `WORKING_GUARD_MAX_REGRESSED_GROUP_SHARE` | `0.75` |
| `WORKING_GUARD_MIN_GROUPS` | `5` |
| `TRAIN_REPLAY_PERCENT` | `20` |
| `TRAIN_MAX_STEPS` | `400` |
| `TRAIN_TARGET_EPOCHS` | `2` |
| `TRAIN_LR` | `1e-4` |
| Stable gate | unchanged `enforce`, paired bootstrap, 20 groups |
| Frozen eval | unchanged `eval-002` |
| Active pointer | unchanged `v493` |

## 6. First real production run

`run-420` was a one-off activation run using the working parent. The run harness was explicitly authorised for a historical-validation bootstrap; the production code was then restored to fail-closed prospective validation. The partition actually selected **prospective** validation (`validationHistoricalArticles: 0`, 75 validation articles), so the fallback was not exercised in the selected cohort.

| Field | Result |
|---|---|
| Run | `run-420` |
| Parent selection | `working` |
| Working parent | `v493` |
| Stable baseline | `v493` |
| Candidate | `v495` |
| Optimizer mode | `carried` (`carryOptimizerFrom=v493`) |
| Stable decision | **rejected** |
| Working decision | **accepted** |
| Working advanced | yes, `v493 → v495` |
| Active after run | `v493` unchanged |
| Dataset | `dataset-20261104-253`, 148 records |
| Training steps | 8, 2 epochs, 4,096 tokens presented |
| Unique training tokens | 2,096 |
| Training wall time | 5.386 s (~760 tokens/s) |
| Fresh docs / tokens | 42 / 767 |
| Replay docs / tokens | 31 / 1,329 |
| Validation docs / tokens | 75 / 2,054 |
| Measured replay share | **63.4%** (configured target 20%) |
| Stable baseline loss | 7.8102399 |
| Candidate loss | 7.8190387 |
| Evaluation delta | -0.0087988 |
| Stable 95% band | ±0.0379; paired CI -0.0135..-0.0060 |
| Working guard | accepted; regression 0.0088 nats; 0 groups over 0.15; 1/60 over 0.05; worst group Compiler -0.0515 |

**Material accounting:** the run consumed 42 new articles, raising unique consumption from 9,711 to 9,753 and replay eligibility from 7,660 to 7,702. It demonstrated a real working-checkpoint update, but **not** a stable serving improvement.

## 7. Safety confirmation

- `active.json` remains `v493`; it was not changed by the working pointer update.
- The stable gate rejected `v495`; no stable promotion occurred.
- Stable thresholds and frozen `eval-002` were not modified.
- No pretrained student weights were loaded.
- `v493` and `v495` are committed and preserved; `v495` has a committed optimizer state.
- The one-off historical-validation allowance was reverted; deployed `lifecycle.js` is fail-closed again.
- `v495` remains the working parent; `v493` remains the last-good rollback anchor.

## 8. Open Findings

1. **Replay share exceeded target in the first run.** The measured share was 63.4% because validation partitioning reduced the fresh training stream after replay selection. The pre-partition estimate was 19.99%. This needs investigation before treating replay-mix behaviour as calibrated.
2. **Training is currently waiting for new prospective validation clusters.** The first run exposed its validation cohort. `job-60` is correctly waiting under fail-closed validation; continuous learning `job-59` is running to acquire new material.
3. **No demonstrated stable improvement yet.** The first working update was accepted, but the stable gate rejected the candidate. Serving remains `v493`.
