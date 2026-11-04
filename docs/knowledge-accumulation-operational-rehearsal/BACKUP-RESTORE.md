# Backup and Restore Rehearsal

## 1. What was backed up

Model store source: isolated pilot store `knowledge-accumulation-pilot-20261102/pilot-store` containing:

- stable active `v001` (`active.json`);
- working `v002` (`working.json`);
- last-known-good `v001` (`working-last-good.json`);
- committed `v001`, `v002`, `v389` weights and records;
- optimizer state `_runs/v001.train-state.pt`, `_runs/v002.train-state.pt`;
- allocation ledger and provenance/manifests.

Ledger source: the read-only production snapshot containing articles, reviews, events, consumption, raw sources, contributions, registry/evaluations, snapshots, plans and the active pointer metadata.

Archives:

| Archive | Contents |
|---|---|
| `backups/model-store.tar` | complete isolated model store |
| `backups/production-ledgers.tar` | snapshot article/registry/evaluation/snapshot/plan data + active pointer |

Archive hashes are in `reports/backup-archive-hashes.txt` and `backup-restore-manifest.json`.

## 2. Restore result

| Tree | Source files | Restored files | Missing | Extra | Hash mismatches |
|---|---:|---:|---:|---:|---:|
| Model store | 36 | 36 | 0 | 0 | 0 |
| Ledgers/manifests | 19,022 | 19,022 | 0 | 0 | 0 |

Restored pointers:

```text
active:      v001  (simpleminds-62m-20261018-d93e2c643988)
working:     v002  (simpleminds-62m-20261018-6ae5111af363)
last-good:   v001  (simpleminds-62m-20261018-d93e2c643988)
```

## 3. Single-file restore drill

The restored `working.json` was deliberately corrupted, then restored from `model-store.tar`:

- restored working version: `v002`;
- active unchanged: `v001`;
- last-good unchanged: `v001`;
- the corrupted pointer was never used as a valid working pointer.

## 4. Conclusion

The backup/restore rehearsal preserves stable, working and last-good identities, optimizer state, model records, article/review/consumption/replay ledgers, manifests and recovery metadata with zero hash mismatches. Production was not modified.
