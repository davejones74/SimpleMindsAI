# Safe disk retention and automated pruning

`SimpleMindsAI` publishes an immutable brain version (`$SMA_STORE/vNNN/`) on
promotion and, alongside it, a resumable optimizer-moment blob
(`$SMA_STORE/_runs/vNNN.train-state.pt`, roughly 472 MB for the 62M model). The
blobs — not the published versions — are the part of the store that grows
without bound, so retention targets them first. Whole-version deletion is a
separate, deliberately narrower operation and is **not** part of the automated
job.

## What is eligible, and what is protected

Eligible for `prune-runs` (and nothing else):

- `$SMA_STORE/_runs/*.train-state.pt` resume-state blobs whose version falls
  outside the retained window, or whose version no longer exists ("orphan").

Permanently protected — never removed by `prune-runs`:

- The active brain named by `$SMA_STORE/active.json`.
- Every published version directory (`vNNN/`), its weights and its records.
- The `--keep` most recent published versions' resume state (default `5`, so
  every version inside the five-version retention floor stays resumable).
- Any version whose run lock is live, and any resume state bound to a live run.
- Manifests, provenance, `train-state.json`, parameter diffs, `COMMITTED`
  markers, hash records, the `_pruned/` tombstone history and the textual
  `models/` mirror.
- The article ledger, review decisions, consumption records, snapshots,
  dataset records, registry history and discovery/frontier state. This document
  does **not** authorise general article-ledger pruning.

## The dry-run / confirmation contract

The CLI is **dry run by default**. A deletion requires `--confirm` and a plan
that passed every fail-closed check. `--confirm` cannot bypass retention, path
containment, locking or integrity checks.

```bash
# Dry run: report only, deletes nothing.
python -m sma.brain prune-runs --out $SMA_STORE

# Actually delete the eligible blobs.
python -m sma.brain prune-runs --out $SMA_STORE --confirm

# Keep a different window, or protect a version explicitly.
python -m sma.brain prune-runs --out $SMA_STORE --keep 5 --protect v007

# Read-only retention/disk report (never deletes).
python -m sma.brain prune-status --out $SMA_STORE
```

## Retention policy and configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `SMA_PRUNE_KEEP` / `--keep` | `5` | Most recent published versions whose resume state is kept. |
| `SMA_RUN_LOCK` / `--run-lock` | unset | External trainer lock (Node registry `RUN.lock`); a live lock refuses pruning. |
| `SMA_DISK_WARN_PCT` | `80` | `prune-status` warning threshold (filesystem used %). |
| `SMA_DISK_CRIT_PCT` | `90` | `prune-status` critical threshold. |

The five-version floor matches the whole-version retention window
(`PRUNE_DEFAULT_KEEP = 5`): every published version that survives whole-version
retention keeps its resume state by default.

## Concurrency and resume-state safety

Deleting a resume blob while a trainer is writing it would corrupt a run, so
coordination is enforced from both sides:

- **Trainer side.** `sma.brain train` holds an exclusive `_runs/<version>.lock`
  for the version it writes (and the version it resumes from) for the whole run.
- **Pruner side.** `prune-runs` acquires a single-writer `.prune.lock`, then
  refuses if any candidate holds a live `_runs/<version>.lock` **or** if the
  external trainer lock (`SMA_RUN_LOCK`, i.e. `RUN.lock`) is live. The external
  check is what makes it safe against the Node orchestrator, whose `RUN.lock` is
  the authoritative "a lifecycle is running" signal.
- Locks older than the stale window whose owner is provably gone are treated as
  abandoned and reclaimed; an unparseable-but-recent lock fails closed.

The prune is recomputed from live state on every call, so it is idempotent and
safe to interrupt: whatever was already removed is simply no longer in the plan.

## Audit log

Every destructive run appends a durable **intent** line (planned candidates and
`plannedBytes`) *before* any unlink, then an **outcome** line with
`reclaimedBytes`, to `$SMA_STORE/_prune-runs-log.ndjson`. If the log cannot be
written, the run refuses and deletes nothing. Planned bytes are never reported
as reclaimed bytes.

## systemd service and timer

A dedicated oneshot service plus timer run the same audited CLI; no deletion
logic lives in a shell script. Files: `scripts/systemd/simpleminds-prune.service`
and `scripts/systemd/simpleminds-prune.timer`.

Install (as root):

```bash
sudo install -m 0644 scripts/systemd/simpleminds-prune.service /etc/systemd/system/
sudo install -m 0644 scripts/systemd/simpleminds-prune.timer   /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/simpleminds-prune.service \
                            /etc/systemd/system/simpleminds-prune.timer
sudo systemctl daemon-reload
sudo systemctl enable --now simpleminds-prune.timer
```

The unit ships in **confirmed** (destructive) mode: `ExecStart` carries
`--confirm`, and the unit sets `SMA_PRUNE_KEEP=5` and
`SMA_RUN_LOCK=/var/lib/simpleminds/data/registry/RUN.lock`. This was enabled on
2026-10-17 only after a reviewed dry-run report and a verified controlled
confirmed run. `sma` is not pip-installed into the venv, so the unit sets
`Environment=PYTHONPATH=/opt/simpleminds/python`; without it the module import
fails. To revert to reporting-only, remove `--confirm` from `ExecStart` and
`systemctl daemon-reload`.

Inspect and diagnose:

```bash
systemctl list-timers simpleminds-prune.timer
systemctl status simpleminds-prune.service
journalctl -u simpleminds-prune.service -n 50
python -m sma.brain prune-log --out $SMA_STORE
python -m sma.brain prune-status --out $SMA_STORE
```

Disable and remove:

```bash
sudo systemctl disable --now simpleminds-prune.timer
sudo rm /etc/systemd/system/simpleminds-prune.service /etc/systemd/system/simpleminds-prune.timer
sudo systemctl daemon-reload
```

## Estimating reclaimed space and recovering from a failed run

- `prune-runs` (dry run) reports `plannedBytes`; `prune-status` reports
  `eligibleBytes`, store size and the last successful prune.
- If a run is interrupted, simply run it again: the plan is recomputed and
  already-removed files are skipped. The intent line remains in the audit log.
- If the audit log is unwritable, fix permissions/space first; the run refuses
  rather than deleting unlogged.
- If disk warnings recur after pruning, the growth driver has moved beyond
  resume state. Do **not** improvise deletion: record the dry-run report, then
  follow the operational escalation in `PRODUCTION.md`.

## Verification

```bash
python -m pytest tests/test_retention.py           # from python/
systemd-analyze verify /etc/systemd/system/simpleminds-prune.service
```
