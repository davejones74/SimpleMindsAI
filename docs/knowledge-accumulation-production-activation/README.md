# Knowledge Accumulation — Production Activation

**Status: ACTIVATED.** Code deployed, replay migration applied, production working checkpoint bootstrapped, working-checkpoint training enabled, and the first real production run completed using the working parent.

| Item | Value |
|---|---|
| Deployed source branch | `knowledge-accumulation-production-activation-20261104` |
| Deployed code commit | `15c817b` |
| Release base | `knowledge-accumulation-release-readiness-20261103` at `7f49a8f` |
| Production repo HEAD before deploy | `79a9f2c` (pilot; ancestor of release) |
| Production service | `simpleminds.service`, active |
| Stable active | `v493`, artifact `simpleminds-62m-20261018-edf63f7283b3` |
| Working checkpoint | `v495`, artifact `simpleminds-62m-20261018-a05f5e1dec4e` |
| Working last-good | `v493` |
| First run | `run-420` — stable **rejected**, working **accepted**, `active.json` unchanged |
| Optimizer mode | **carried** from `v493` |
| Replay migration | 377 eligible restored; 7,283 → 7,660 already eligible |
| Production backup | `/var/lib/simpleminds/backups/knowledge-accumulation-activation-20261104T072518Z` |
| Migration snapshot | `/var/lib/simpleminds/migration/knowledge-accumulation-20261104T072518Z/articles-before` |

## Operational documents

- [`ACTIVATION-REPORT.md`](./ACTIVATION-REPORT.md) — deployed commits, migration reconciliation, working identity, optimizer mode, first results, stable-gate confirmation.
- [`MONITORING.md`](./MONITORING.md) — current production monitoring fields, definitions and open findings.
- [`reports/monitoring.json`](./reports/monitoring.json) — machine-readable monitoring snapshot.
- [`reports/first-run-420.json`](./reports/first-run-420.json) — full first-run evidence.
- [`reports/post-activation-state.json`](./reports/post-activation-state.json) — pointers, checkpoint hashes, jobs, disk.
- [`reports/migration-reconciliation.json`](./reports/migration-reconciliation.json) — replay migration before/apply/after.
- [`reports/backup-manifest.json`](./reports/backup-manifest.json) — production backup and rehearsal backup hashes.
- [`reports/effective-config.json`](./reports/effective-config.json) — effective guard, replay, training and stable-gate configuration.

## Headline result

`run-420` selected the working parent `v493`, carried AdamW state from `v493`, trained `v495`, and advanced the working pointer to `v495` under `working-guard-v2`. The candidate was **rejected by the unchanged stable gate** (paired improvement `-0.0098`, 95% CI `-0.0135..-0.0060`, noise band `0.0379`), so `active.json` remains `v493`.

## Open finding

The first run's measured replay share was **63.4%** of training tokens, above the configured `TRAIN_REPLAY_PERCENT=20`. The pre-partition estimate was 19.99%; validation partitioning reduced the fresh training stream after replay selection. This is recorded as an open production issue. It did not move the stable pointer, and no further training is running until new prospective validation material exists.
