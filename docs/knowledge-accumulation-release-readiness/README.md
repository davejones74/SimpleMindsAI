# Knowledge Accumulation — Release Readiness

**Status:** release-readiness validation complete; production rollout not authorised and not performed.  
**Recommendation:** **READY WITH CONDITIONS** — see the conditions in the final section.

| Item | Value |
|---|---|
| Pilot branch preserved | `knowledge-accumulation-pilot-20261102` |
| Pilot implementation | `13a0962` |
| Pilot docs/manifest | `79a9f2c` |
| Release-readiness branch | `knowledge-accumulation-release-readiness-20261103` |
| Release-readiness base | `79a9f2c` |
| Release-readiness code commit | `00f338d` |
| Release docs/manifest commit | recorded in `RELEASE-MANIFEST.json` |
| Worktree | `/home/dave/sma-experiments/worktrees/knowledge-accumulation-release-readiness-20261103` |
| Isolated release stores | `/home/dave/sma-experiments/knowledge-accumulation-release-readiness-20261103/` |

## Navigation

| Document | Purpose |
|---|---|
| [`GUARD-CALIBRATION.md`](./GUARD-CALIBRATION.md) | Defaults, discrepancy, real default run, threshold recommendation |
| [`ROCM-VALIDATION.md`](./ROCM-VALIDATION.md) | Actual ROCm environment, focused/full suite results, optimizer/device checks |
| [`CRASH-RECOVERY.md`](./CRASH-RECOVERY.md) | Six actual-subprocess SIGKILL scenarios and recovery results |
| [`OPTIMIZER-COMPATIBILITY.md`](./OPTIMIZER-COMPATIBILITY.md) | Fresh/reset/carried/restored states, incompatible and corrupt state |
| [`CHECKPOINT-RETENTION.md`](./CHECKPOINT-RETENTION.md) | Protected pointers, prune safety, storage estimates |
| [`REPLAY-RECONCILIATION.md`](./REPLAY-RECONCILIATION.md) | Dry-run reconciliation and unresolved-record plan |
| [`PRODUCTION-ROLLOUT.md`](./PRODUCTION-ROLLOUT.md) | Pre-deployment, deployment, rollback and sequencing |
| [`IMPLEMENTATION-REPORT.md`](./IMPLEMENTATION-REPORT.md) | Changed files, tests, risks and readiness conclusion |
| [`RELEASE-MANIFEST.json`](./RELEASE-MANIFEST.json) | Commits, hashes and machine-readable evidence |

## Headline findings

1. **The pilot's widened guard was not the default.** Defaults are `0.05` overall regression, `0.15` individual group, and now `0.10` cumulative drift. The pilot Scenario A used `0.10/0.20/0.25`; its `0.0613` candidate **fails the defaults**. A real ROCm candidate at `0.0472` passes the defaults.
2. **The default guard was hardened, not weakened.** The release branch adds a hard per-group catastrophic check, a broad-regression share based on the per-run tolerance, and reduces the cumulative drift budget from `0.25` to `0.10`.
3. **ROCm works.** The supported ROCm venv is Python 3.14.4 / torch `2.12.0+rocm7.14.0` / HIP `7.14.60850` on the Radeon 890M. The full Python suite passes under ROCm: 260 passed, 19 skipped, 0 failed.
4. **Actual subprocess termination is covered.** Six SIGKILL scenarios pass: partial checkpoint, weights-before-optimizer, complete staged pair, pointer write, post-pointer/pre-consumption, and crash during recovery.
5. **Optimizer bootstrap is explicit.** Real ROCm runs recorded `reset-no-parent-state` and `carried` modes; incompatible state fails closed.
6. **Retention now protects working and last-good pointers.** `plan_prune` and `plan_prune_runs` cannot propose them for deletion; pointer writes are atomic.
7. **Replay migration remains conservative and auditable.** Production dry run: 377 eligible, 3,875 unresolved (1,054 licence-uncertain, 1,312 licence-unknown, 1,509 no decisive review), 13,892 ineligible. No production migration applied.
8. **No production state was changed.** No production store, active pointer, job, timer, service, corpus or configuration was modified.

## Conditions for a controlled production rollout

1. ROCm full suite is complete: 260 passed, 19 skipped, 0 failed.
2. Review and approve the release guard defaults (`0.05 / 0.15 / 0.10`) and the v2 broad/catastrophic group rules.
3. Rehearse the replay migration on a verified snapshot copy and resolve the 1,054 licence-uncertain / 1,312 licence-unknown / 1,509 no-decision records progressively.
4. Enable working-checkpoint training in a separately authorised, bounded production-adjacent pilot before normal production learning uses it.
5. Keep `active.json`, the frozen eval set and stable promotion thresholds unchanged until that authorisation.

Do not deploy code, apply the migration and enable working training as one action. They are separate decisions.
