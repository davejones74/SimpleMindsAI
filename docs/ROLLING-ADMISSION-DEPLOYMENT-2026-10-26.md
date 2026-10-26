# Rolling Admission — Production Deployment and Real Migration

- Date: 2026-10-26
- Host: `dave-X1PRO`
- Source checkout: `/home/dave/Repositories/SimpleMindsAI`
- Repository HEAD: `89b5b9d73fdbd57f63fd8fa759108c5474ccf228`
- Production: `/opt/simpleminds`
- Durable state: `/var/lib/simpleminds`
- Maintenance window: approximately `22:16:47–22:20:01` GMT
- Status: **COMPLETE — code deployed, history migrated, rolling policy activated, service healthy**

This report supersedes the earlier BLOCKED deployment/Stage 3 status. The
reviewed changes remain uncommitted and unpushed.

## 1. Outcome

- Reviewed Stage 1/Stage 2 code is deployed to `/opt/simpleminds`; `npm ci`
  completed successfully.
- Production admission history was migrated from a quiescent snapshot into
  `/var/lib/simpleminds/data/gateway/policies/rolling-v1`.
- The target store verified with **920 imported admissions**, **2,881 legacy
  cap rejections excluded**, no duplicates, and no identity conflicts.
- `ACTIVE_POLICY.json` now selects `rolling-v1`; the service restarted on the
  policy path.
- Live health reports `source="policy"`, `policyId="rolling-v1"`,
  `capLimit=50000`, `capUsed=500`, `remaining=49500`.
- `simpleminds-perpetual.timer` remains inactive; `job-32` and `job-33` remain
  stopped.
- No training, evaluation, promotion, model change, epoch creation, or
  commit/push occurred.
- Storage guard thresholds remain **disabled at 0/0**. The proposed 100 GiB
  minimum-free and 20 GiB maximum-DB values are not activated.

## 2. Activated policy

| Field | Value |
|---|---|
| Policy | `rolling-v1` |
| Mode | rolling |
| Window | 86,400,000 ms (24 h) |
| Global quota | 50,000 |
| Cap epoch | `gateway-20261026-01` |
| Per-domain | 5,000 / 24 h |
| Rate | 2,000 / 60 s |
| Max concurrent | 1 |
| Storage minimum free | 0 (disabled) |
| Storage maximum DB | 0 (disabled) |
| Deferral retention | 604,800,000 ms (7 d) |
| Deferral maximum rows | 100,000 |
| Ack required | false |
| Protocol | `baseline-v1` |
| Config hash | `8f640cf2d16df7dbf982077520db966b5c6ffa002ab3ebcd814c02ec0dd530fb` |
| Sealed at | `2026-10-26T22:19:15.160Z` |
| Activated at | `2026-10-26T22:19:51.888Z` |

Quota exhaustion is represented as a transient `DEFERRED` result, not a durable
`reason='cap'` rejection. Legacy cap rejections remain in the legacy stores but
were intentionally excluded from the rolling policy.

## 3. Backup, snapshot, and code deployment

### Pre-change backup

`/var/lib/simpleminds/backups/pre-rolling-20261026T221839Z`

The backup contains:

- admission stores, WAL/SHM, `ACTIVE_EPOCH.json`, and epoch metadata;
- frontier and discovery frontier data;
- active model pointer, eval-002 files, jobs and models ledgers;
- the pre-change production code archive `opt-code.tar.gz`;
- `SHA256SUMS.txt`, `STAMP.txt`.

Selected hashes in `SHA256SUMS.txt` were reverified after the change:
`active.json`, both eval-002 files, `opt-code.tar.gz`, and both admission DBs all
report `OK`.

### Quiescent migration snapshot

`/var/lib/simpleminds/migration/source-snapshot-20261026T221839Z`

The snapshot was copied from the gateway after the service was stopped. Both
legacy source WAL files were zero at snapshot time. Production source DB hashes
still match the backup after activation:

```text
43a47d488c0b45725187292e805b5523c4fc1f7e15fbbd95ac161951414848b4  gateway/admission.sqlite
bb4d531ddabc97f8df9041fccc31b4a7a842590c1d52e26d4aec7d2e4d62d24f  gateway/epochs/gateway-20261026-01/admission.sqlite
```

### Service quiesce

`systemctl stop simpleminds-perpetual.timer simpleminds.service` was issued at
`22:16:47`. The service stop timed out after 90 seconds and systemd killed the
node/python process tree at `22:18:17` (`Result: timeout`). Verification showed
no remaining gateway process, port 4000 closed, and zero source WAL. The timeout
did not corrupt or alter the source DBs.

### Deployed code

The reviewed tree was synchronized into `/opt/simpleminds` with the corrected
rsync exclusions, ownership was set to `simpleminds:simpleminds`, and
`npm ci --omit=dev` completed successfully. Key deployed hashes match the
reviewed checkout:

```text
admission-migration.js       1591ec538b706a98e8510ecbeb354c66286bd88c414b7a50ac772a7a860bc31b
admission-migrate.js         7c5a87091b9285d7e9a175453f1a2157d5e500386dc83f3307ce951f87d782f7
rolling-admission-store.js   d613ab68529bb3795c8db3b851db5c8657d79d5736ba02e03841fc21fa08b123
admission-policy.js          6034b94d3192ad0e211be16ee447ce028e3528a1778fba417e40a85c6f59dc8f
```

## 4. Source inventory

| Source | Epoch | Cap | Admitted | Cap rejected | Attempts | Conflicts |
|---|---|---:|---:|---:|---:|---:|
| Root legacy store | `gateway-20261025-01` | 420 | 420 | 2,880 | 3,300 | 0 |
| Active legacy epoch | `gateway-20261026-01` | 500 | 500 | 1 | 501 | 0 |
| **Total** | | | **920** | **2,881** | **3,801** | **0** |

The 420 root admissions were outside the 24-hour rolling window at migration
time; the 500 active-epoch admissions were counted. The target still contains
all 920 admitted decisions for identity replay.

## 5. Migration results

Both the dry-run and real migration used the deployed CLI and
`SMA_SKIP_ENV_FILE=1`, targeting
`/var/lib/simpleminds/data/gateway/policies/rolling-v1`. The pointer was not
created by the migration.

### Dry-run

- 2 sources; 920 imported; 2,881 cap rejections excluded.
- Rolling usage 500; remaining 49,500.
- Oldest counted: `2026-10-26T01:10:27.636Z`.
- Next capacity: `2026-10-27T01:10:27.636Z`.
- Target and pointer absent; verification passed.

### Real `--execute`

| Result | Value |
|---|---|
| Source decisions | 3,801 |
| Imported | 920 |
| Admitted | 920 |
| Non-cap rejected | 0 |
| Cap rejections excluded | 2,881 |
| Duplicate decisions | 0 |
| Duplicate request IDs | 0 |
| Identity conflicts | 0 |
| Scope present / absent | 51 / 869 |
| Frontier records | 51 |
| Rolling used / limit | 500 / 50,000 |
| Remaining | 49,500 |
| Target decisions | 920 |
| Target DB SHA-256 | `d0b1d143a146905727f87cdb79db92d08519f0e923f75197d5297df85a2c37b8` |
| Verification | source hashes unchanged; target decisions match; quota matches; passed |

### Idempotent rerun

A second real `--execute` over the same source and target reported:

- `importedNow=0`, `skippedExisting=920`;
- same target DB hash;
- same quota (500 used / 49,500 remaining);
- verification passed, pointer still absent.

## 6. Activation and live service

`ACTIVE_POLICY.json` was written only after target verification, using the sealed
target policy. `ACTIVE_EPOCH.json` and both legacy stores remain present.

The service was started at `22:20:01`. Startup logs show:

```text
[admission] active policy=rolling-v1 capEpoch=gateway-20261026-01 quota=50000/86400000ms source=policy
[admission] source=policy policy=rolling-v1 epoch=gateway-20261026-01 cap=50000 capUsed=500
```

Live health:

```text
ok=true
admission.mode=policy
admission.source=policy
admission.policyId=rolling-v1
admission.epoch=gateway-20261026-01
admission.capLimit=50000
admission.capUsed=500
admission.policy.quotaUsed=500
admission.policy.remaining=49500
admission.policy.deferrals.count=0
admission.policy.storage.ok=true
```

`systemctl` reports `ActiveState=active`, `SubState=running`, `Result=success`,
`NRestarts=0`; no journal error entries were recorded after the start.
`simpleminds-perpetual.timer` is inactive and both jobs remain stopped.

## 7. Deferred/retry evidence

The production quota was **not** intentionally exhausted. Forcing 50,000
production admissions would consume real quota and violate the migration
boundary. Production health currently shows zero deferrals.

An isolated proof using the deployed rolling store and a temporary quota of 1
confirmed the required behavior:

1. first request: `ADMITTED`;
2. second request while exhausted: `DEFERRED`, reason `quota`;
3. `getDecision()` for the deferred request: `null` (no durable rejection);
4. retry after the window advanced: `ADMITTED`;
5. final quota used: 1.

This proves the deployed code path is transient and recoverable. It is not a
claim that the production quota was exercised.

## 8. Measured storage

| Path / metric | Size |
|---|---:|
| Target `policies/rolling-v1/admission.sqlite` | 679,936 bytes |
| Target WAL | 0 bytes |
| Target SHM | 32,768 bytes |
| Root legacy DB | 1,994,752 bytes |
| Active epoch legacy DB | 335,872 bytes |
| Gateway admission tree | 3.0 MiB |
| Frontier data | 116 MiB |
| Migration evidence | 4.5 MiB |
| Pre-change backup | 122 MiB |
| Filesystem free | 1.6 TiB (13% used) |
| Inodes | 1% used |

The target policy explicitly seals `storageMinFreeBytes=0` and
`storageMaxDbBytes=0`. No unapproved storage reserve or database cap was
activated. The next step is to measure growth over a representative period
before proposing any threshold with explicit approval.

## 9. What remained unchanged

- Active model remains `v199`, fingerprint `7404193f951c`, artifact
  `simpleminds-62m-20261018-7404193f951c`.
- Eval-002 hashes remain:
  `dd64558c03352175edc098d319ec481e501baeaf8bba24b21f570bafeeb89598`
  (JSONL) and
  `de180e5cba4355bd4eae8b12234a139973f613f56759cfc30bba15f3e18d1f9a`
  (manifest).
- Legacy `ACTIVE_EPOCH.json`, root DB, and active epoch DB are intact.
- Source DB hashes match the pre-change backup.
- Production environment file was not modified.
- No job or perpetual timer was started.
- No training/evaluation/promotion was run.
- No git commit or push was made.

## 10. Rollback

Rollback is non-destructive and retains the migrated target:

1. Remove `/var/lib/simpleminds/data/gateway/ACTIVE_POLICY.json`.
2. Restart only `simpleminds.service`; the existing legacy `ACTIVE_EPOCH.json`
   selects the legacy path again.
3. If code rollback is required, restore the pre-change tree from
   `/var/lib/simpleminds/backups/pre-rolling-20261026T221839Z/opt-code.tar.gz`
   and restart the service.
4. Keep the rolling target and manifests for investigation; do not delete the
   legacy stores.

The backup's selected hashes were verified. No rollback was required.

## 11. Evidence

- Dry-run manifest:
  `/var/lib/simpleminds/migration/rolling-v1-dry-run-20261026T221839Z.json`
- Real migration manifest:
  `/var/lib/simpleminds/migration/rolling-v1-manifest-20261026T221839Z.json`
- Idempotent rerun manifest:
  `/var/lib/simpleminds/migration/rolling-v1-rerun-20261026T221839Z.json`
- Deferral proof:
  `/var/lib/simpleminds/migration/deferral-proof-20261026T221839Z/`
- Pre-change backup:
  `/var/lib/simpleminds/backups/pre-rolling-20261026T221839Z/`
- Source snapshot:
  `/var/lib/simpleminds/migration/source-snapshot-20261026T221839Z/`

The migration directory is mode `0750` owned by `simpleminds`; read the
manifests with privileged access if needed.

## 12. Follow-up

- Keep continuous learning/jobs and the perpetual timer stopped until separately
  authorized.
- Monitor `/health` admission policy status and deferral counts.
- Measure target DB/WAL growth before proposing storage thresholds.
- The reviewed changes remain uncommitted; commit/push only on explicit request.
