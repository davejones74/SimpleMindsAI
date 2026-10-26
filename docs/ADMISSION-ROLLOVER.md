# Admission epoch rollover and cap-rejected recovery

This document covers the durable admission lifecycle introduced after the
`gateway-20261025-01` epoch exhausted its 420-request cap and the learner was
stopped with 2,880 frontier URLs marked `state=rejected`, `lastError=cap`.

## Design

The original Baseline v1 database stays exactly where it is:

```text
/var/lib/simpleminds/data/gateway/admission.sqlite          # legacy epoch
/var/lib/simpleminds/data/gateway/ACTIVE_EPOCH.json         # active pointer
/var/lib/simpleminds/data/gateway/epochs.ndjson             # append-only audit
/var/lib/simpleminds/data/gateway/epochs/<epoch>/admission.sqlite
```

A rollover **never edits** an existing sealed database. It:

1. Seals a new isolated store under `epochs/<epoch>/admission.sqlite` with the
   requested cap, ACK policy and protocol version.
2. Appends an `epoch` record to `epochs.ndjson`.
3. Atomically replaces `ACTIVE_EPOCH.json` with the new epoch identifier and
   appends an `active` record.
4. Leaves every prior epoch and every prior decision untouched.

`ACTIVE_EPOCH.json` is authoritative. On startup the service opens the active
pointer; the `ADMISSION_*` environment values are only the bootstrap
configuration used when no pointer exists. While running, the acquisition
gateway re-reads the pointer (throttled, and immediately after a cap rejection)
so a CLI rollover is adopted without a service restart.

Epoch identifiers are explicit and unique. The CLI can allocate the next
identifier as `gateway-YYYYMMDD-NN`, or the operator can supply one.

## A full epoch is not a URL rejection

When an epoch is full, the admission store returns `REJECTED reason=cap`. The
crawler now:

- leaves the URL in the frontier as `queued` (with an audit entry in
  `capDeferrals`), instead of marking it `rejected`;
- stops that crawl cycle (`capExhausted=true`); and
- the learning supervisor parks at `waiting-for-admission-cap`.

Once a new epoch is activated, the gateway adopts it and the same URL is
admitted under a new epoch-scoped request identity. No manual frontier repair is
needed for future cap exhaustion.

## Commands

Run as the service account (or root with `sudo -u simpleminds`):

```bash
cd /opt/simpleminds
export ADMISSION_DIR=/var/lib/simpleminds/data/gateway
export FRONTIER_DIR=/var/lib/simpleminds/data/frontier

node src/cli/admission.js status
node src/cli/admission.js backup --backup-root /var/lib/simpleminds/backups
node src/cli/admission.js rollover --next-epoch --cap 500 --recover-cap-rejected \
  --backup-root /var/lib/simpleminds/backups
node src/cli/admission.js recover --dry-run
```

For the next cap exhaustion, the same migration script can allocate a fresh
epoch explicitly:

```bash
sudo bash /home/dave/production-admission-rollover.sh --next-epoch --cap 500
```

It repeats backup, rollover, optional recovery, env update, restart and
validation. `--epoch <id> --cap <n>` is available when an exact identifier is
required.

`status` reports the active epoch, its sealed cap and usage, the legacy epoch,
the number of cap-rejected frontier rows, and the next proposed epoch.

`backup` uses SQLite's backup API for each database and copies the frontier,
pointer and epoch ledger into a timestamped directory with a `MANIFEST.json`
containing SHA-256 hashes.

`rollover` supports `--dry-run`. `--recover-cap-rejected` invokes the
selective recovery after the pointer switch. Recovery touches **only** records
with `state=rejected` and `lastError=cap`; quarantined rows and every other
rejection reason are left terminal.

## Recovery audit

Frontier recovery preserves, on each recovered record and in
`<FRONTIER_DIR>/cap-recovery.ndjson`:

- previous state and `lastError`, timestamp, completion time;
- previous request ID, payload digest and generation; and
- the new epoch that authorises the retry.

Recovery is idempotent. A crash before the single `Frontier.persist()` leaves
the durable file unchanged; re-running selects the same rows. A crash after the
audit append but before the rewrite leaves a duplicate audit batch, never a
lost or half-recovered record.

## Production procedure

1. Stop learning/training jobs and keep them stopped.
2. Stop `simpleminds.service` (so the in-memory frontier cannot race the
   recovery rewrite).
3. Deploy the source revision.
4. Run `backup`.
5. Run `rollover --epoch <new> --cap 500 --recover-cap-rejected`.
6. Update `/etc/simpleminds/simpleminds.env`:
   `ADMISSION_CAP_LIMIT=500` and `ADMISSION_CAP_EPOCH=<new>`.
7. Start `simpleminds.service`.
8. Verify `/health`, the admission log line, `status`, frontier counts and a
   bounded acquisition pass.
9. Resume the appropriate jobs.

The service log line confirming the active epoch is:

```text
[admission] active epoch=<epoch> cap=500 capUsed=<n> source=pointer dir=...
```

## Rollback

- The legacy database, new epoch databases, frontier copy and metadata are all
  retained in the backup directory.
- Code rollback: restore the previous source archive, restore the backup
  database/frontier only if required, and restart the service.
- Epoch rollback is only safe before the new epoch admits work. Once it has
  admitted requests, do not reactivate an older epoch; roll forward to a *new*
  unique epoch instead. The CLI refuses to reactivate an epoch that has already
  admitted work.

## Limitations

Rollover is deliberately **explicit and bounded**: no process creates epochs in
a loop. A full epoch parks acquisition safely. Continuing beyond 500 requests
requires one operator-run `rollover` command; the running service adopts it
without a restart. This is the sanctioned fallback from the approved outcome:
correctness, auditability and no URL loss take priority over unattended epoch
creation.
