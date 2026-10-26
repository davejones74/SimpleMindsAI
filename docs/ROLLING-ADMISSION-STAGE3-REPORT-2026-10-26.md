# Rolling Admission — Stage 3 Production Dry-Run Report

- Date: 2026-10-26
- Host: `dave-X1PRO`
- Source checkout: `/home/dave/Repositories/SimpleMindsAI`
- Production: `/opt/simpleminds`
- Status: **SUPERSEDED — production dry-run and migration later passed**
- Production changes at the time of this report: **none**
- Manifest at the time of this report: **none generated**
- Current report: `ROLLING-ADMISSION-DEPLOYMENT-2026-10-26.md`

## 1. Preflight outcome

A safe production dry-run was not possible. Two independent blockers exist:

1. **The reviewed Stage 1/Stage 2 code is not deployed.** The installed
   `/opt/simpleminds` tree has no:
   - `src/gateway/admission-migration.js`
   - `src/cli/admission-migrate.js`
   - `src/gateway/rolling-admission-store.js`
   - `src/gateway/admission-policy.js`

   The deployed Stage 1-related files also differ from the reviewed checkout.
   Examples:

   | File | Deployed SHA-256 | Reviewed checkout SHA-256 |
   |---|---|---|
   | `src/gateway/admission-store.js` | `c7841631…` | `66212914…` |
   | `src/gateway/acquisition-gateway.js` | `53ae63a2…` | `e364fa04…` |
   | `src/frontier.js` | `9efe8d79…` | `8e4d4410…` |
   | `src/harness/crawler.js` | `e36e5688…` | `dcff30a5…` |
   | `src/server.js` | `b6af3aea…` | `098653f8…` |
   | `src/config.js` | `777c49fa…` | `2fc7bf27…` |

   Therefore the deployed migration tool cannot be verified against the
   reviewed implementation; there is no deployed tool to run.

2. **The production admission source is not readable by the current session.**
   - `/var/lib/simpleminds/data/gateway` is `simpleminds:simpleminds`, mode
     `0750`.
   - `ls`, `find`, and `stat` on the active DB/WAL/SHM return permission denied.
   - `sudo -n true` returns `sudo: interactive authentication is required`.
   - `sudo -n -u simpleminds id` is likewise blocked.

   No permission bypass was attempted.

Additionally, the service is **active** and not quiesced:

```text
simpleminds.service: active (running)
simpleminds-perpetual.timer: inactive
job-32: stopped
job-33: stopped
health: {"ok":true,"articles":11788,
 "admission":{"epoch":"gateway-20261026-01","capLimit":500,"capUsed":500,"source":"pointer"}}
```

A safe migration dry-run requires a quiescent source or a consistent snapshot and
read access to the source DB/WAL. Neither is available. Stopping/checkpointing
the service would require authorization and was not performed.

## 2. What was not run

The following command was **not executed** because preflight failed:

```bash
node src/cli/admission-migrate.js \
  --source-dir /var/lib/simpleminds/data/gateway \
  --target-dir /home/dave/simpleminds-stage3-rolling-dry-run \
  --frontier-dir /var/lib/simpleminds/data/frontier \
  --manifest /home/dave/simpleminds-stage3-rolling-dry-run-manifest.json
```

No `--execute` was used. No target policy store, `ACTIVE_POLICY.json`, epoch, or
manifest was created. No source database, WAL, frontier, environment file,
service, or model was changed.

Consequently these Stage 3 items are **not verified**:

- source store enumeration;
- source SHA-256 hashes;
- source row counts;
- duplicate/conflicting request IDs;
- excluded legacy `reason='cap'` rejections;
- timestamp/scope coverage;
- rolling usage in `(now-24h, now]`;
- remaining/next capacity from actual timestamps;
- target/policy validation.

The existing health value `capLimit=500, capUsed=500` is the **legacy epoch**,
not a rolling-window calculation. It must not be reported as rolling usage.

## 3. Measured storage evidence

Read-only measurements possible without privilege:

```text
Filesystem      Size  Used Avail Use% Mounted on
/dev/nvme0n1p2  1.9T  227G  1.6T  13% /
Inodes: 124,960,768 total; 481,253 used; 124,479,515 free (1% used)
/var/lib/simpleminds/data   576M
/var/lib/simpleminds/store   11G
/opt/simpleminds            6.0G
```

Admission DB/WAL/SHM size and growth could **not** be measured because the
directory is unreadable. No historical growth evidence is available from the
current session; no rate was estimated or guessed.

Expected operational implication: 50,000 admissions/rolling 24h is about
18.25M decisions/year if sustained. The rolling store retains decision rows for
identity/replay, so DB growth must be monitored; deferral metadata is bounded by
retention (default 7 days) and max rows (100,000).

### Threshold recommendation

- `ADMISSION_STORAGE_MIN_FREE_BYTES`: **107374182400 (100 GiB)** is a reasonable
  reserve based on the measured 1.6 TB free and 1% inode use. This is a policy
  reserve, not DB-growth evidence; approval required.
- `ADMISSION_STORAGE_MAX_DB_BYTES`: **no evidence-based value can be
  recommended.** Retain **0 (disabled)** until the admission DB size and a
  measured growth period are available. The previously proposed 20 GiB remains
  unapproved and inactive.

Suggested measurement period after privileged access/activation: sample DB,
WAL, and row growth over a controlled 7–14 day period at the approved admission
rate, including WAL checkpoint behavior and backup size; then set a max DB
threshold with explicit headroom and archival policy.

## 4. Fixture evidence (separate from production)

These are prior Stage 2 fixture results, not production observations:

```text
$ node --test test/admission-migration.test.js
# tests 6, pass 6, fail 0

$ combined migration/rolling/gateway/crawler/jobs suite
# tests 80, pass 80, fail 0

$ timeout 600 npm test
# tests 662, pass 655, fail 0, skipped 7
```

They demonstrate the reviewed tool logic; they do not verify the deployed host.

## 5. Blockers and next approval

Before Stage 3 can be rerun:

1. Decide whether to deploy the reviewed Stage 1/Stage 2 code to
   `/opt/simpleminds` (separate deployment authorization), or explicitly
   authorize running the reviewed checkout tool against production.
2. Provide a privileged or `simpleminds` read-only session with access to:
   - `/var/lib/simpleminds/data/gateway`;
   - the active epoch DB/WAL/SHM;
   - optionally the frontier for scope coverage.
3. Provide a controlled maintenance window or consistent snapshot so the source
   is quiescent. Do not migrate while `simpleminds.service` is actively writing
   a non-empty WAL.
4. After the dry-run, measure DB/WAL/inode growth and approve or replace the
   storage thresholds.

No production migration, dry-run, pointer switch, epoch creation, deployment,
service restart, job start, training, evaluation, promotion, commit, or push was
performed.
