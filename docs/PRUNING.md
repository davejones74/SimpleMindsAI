# Safe disk retention and automated pruning

`prune-runs` cleans only `_runs/*.train-state.pt` optimizer-moment blobs for
versions that fall outside the retained window. It is dry-run by default.

- Preserved: active brain, all published version directories, last five
  published versions, all records, manifests, provenance, raw article ledger.
- Candidate pickles: must be outside the retained window (default keep=2 for
  prune-runs), not active, not protected, and not bound to a live run lock.
- Required to run destructively: non-null committed active pointer, writable
  audit log, no live candidate locks.
- Outer whole-version `prune` remains separate and is not used here.

Checks:
  python -m sma.brain prune-runs --out $SMA_STORE  (always dry run)
  python -m sma.brain prune-log --out $SMA_STORE
Verification (analysis): `systemd-analyze verify /path/to/service /path/to/timer`
EOF