# Knowledge Accumulation — Operational Rehearsal

**Status:** rehearsal complete. No production activation, migration, training, acquisition or pointer change.  
**Conclusion:** **READY FOR SEPARATELY AUTHORISED BOUNDED PILOT.**

| Item | Value |
|---|---|
| Pilot branch preserved | `knowledge-accumulation-pilot-20261102` at `79a9f2c` |
| Release branch preserved | `knowledge-accumulation-release-readiness-20261103` at `7f49a8f` |
| Rehearsal branch | `knowledge-accumulation-operational-rehearsal-20261103` |
| Rehearsal base | `7f49a8f` |
| Rehearsal code/docs commit | recorded in `REHEARSAL-MANIFEST.json` |
| Worktree | `/home/dave/sma-experiments/worktrees/knowledge-accumulation-operational-rehearsal-20261103` |
| Isolated rehearsal data | `/home/dave/sma-experiments/knowledge-accumulation-operational-rehearsal-20261103/` |

## Navigation

| Document | Contents |
|---|---|
| [`SNAPSHOT.md`](./SNAPSHOT.md) | Read-only production snapshot manifest and consistency |
| [`MIGRATION-RECONCILIATION.md`](./MIGRATION-RECONCILIATION.md) | Before/apply/after replay migration on the snapshot |
| [`BACKUP-RESTORE.md`](./BACKUP-RESTORE.md) | Model/ledger backup, restore and hash verification |
| [`PROCESS-CRASH.md`](./PROCESS-CRASH.md) | Real 62M training process interruption and recovery |
| [`STORAGE-RETENTION.md`](./STORAGE-RETENTION.md) | Storage headroom and retention under normal/interrupted/rollback |
| [`CONFIGURATION.md`](./CONFIGURATION.md) | Approved guard defaults, ROCm count reconciliation, proposed pilot config |
| [`FINAL-ASSESSMENT.md`](./FINAL-ASSESSMENT.md) | Go/no-go, bounded pilot proposal and required authorisation |
| [`REHEARSAL-MANIFEST.json`](./REHEARSAL-MANIFEST.json) | Commits, file hashes and machine-readable evidence |

## Headline results

1. **Snapshot:** 1.3 GB, 19,022 files, SHA-256 manifest recorded. Source production stores were not modified. Snapshot active pointer `v493`; production model bytes for `v493` were not readable by the rehearsal user, so training used the accessible 62M `v389`/`v001` lineage.
2. **Replay migration:** snapshot before/after exactly reconciled: 377 eligible before, 377 restored, 0 eligible after, already-eligible 7,283 → 7,660, unresolved 3,875 and ineligible 13,950 unchanged. Source snapshot article files changed: 0.
3. **Backup/restore:** model store (36 files) and ledgers/manifests (19,022 files) restored with zero missing/extra/hash mismatches; single-file working-pointer restore drill passed.
4. **Full-process crash:** actual Python training child SIGKILL mid-training left active/working/last-good, optimizer, consumption and replay pool intact. A real 62M run killed after working-pointer advancement/before consumption recovered exactly once: active `v389` unchanged, working `v002`, weights + optimizer committed, consumption 6 → 28 with 28/28 unique pairs, second recovery added nothing.
5. **Disable path:** `TRAIN_USE_WORKING_CHECKPOINT=false` trained from stable `v389` (`parentSelection=stable`), left working `v002`, last-good `v001`, active `v389`, consumption 6, and preserved v003.tmp for inspection. Working history was not deleted.
6. **Retention:** normal, interrupted and rollback states all protect active/working/last-good. Rollback to last-good `v001` left active `v389`; `v002` became prune-eligible only by explicit plan, not automatically. Disk headroom is ~1.5 TB.
7. **ROCm count reconciliation:** the release report's stale `47 passed` line is corrected to **48** (5 working-checkpoint + 43 retention tests); full ROCm suite is **260 passed, 19 skipped, 0 failed**.

## Safety boundaries

No production store, active pointer, working pointer, model, article, review, consumption record, frozen evaluation set, service, timer, job or environment was modified. No production replay migration was applied. Working-checkpoint training was not enabled in production. All work used the isolated snapshot/stores and rehearsal branch.
