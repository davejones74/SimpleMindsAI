# Rolling Admission — Stage 2 Migration Tool

- Date: 2026-10-26
- Source checkout: `/home/dave/Repositories/SimpleMindsAI`
- Status: **Stage 2 implemented and fixture-tested; no production dry-run, migration, or pointer switch executed**
- Baseline: `docs/ROLLING-ADMISSION-PLAN-2026-10-26.md`, `docs/ROLLING-ADMISSION-STAGE1.md`

## 1. Tool

New files:

- `src/gateway/admission-migration.js` — source enumeration, duplicate/conflict
  detection, plan, real migration, verification and manifest.
- `src/cli/admission-migrate.js` — dry-run/execute CLI.
- `test/admission-migration.test.js` — fixture tests.

The tool never creates or modifies `ACTIVE_POLICY.json`, `ACTIVE_EPOCH.json`, a
source database, the frontier, or environment configuration. Real mode writes
only to the explicit `--target-dir` (and optional manifest path); dry-run writes
only an optional manifest and does not create the target.

### Usage

Read-only dry-run:

```bash
node src/cli/admission-migrate.js \
  --source-dir /var/lib/simpleminds/data/gateway \
  --target-dir /var/lib/simpleminds/migration/rolling-v1 \
  --frontier-dir /var/lib/simpleminds/data/frontier \
  --manifest /var/lib/simpleminds/migration/rolling-v1-dry-run.json
```

Real migration (creates the target policy store; still **no pointer switch**):

```bash
node src/cli/admission-migrate.js \
  --source-dir /var/lib/simpleminds/data/gateway \
  --target-dir /var/lib/simpleminds/migration/rolling-v1 \
  --frontier-dir /var/lib/simpleminds/data/frontier \
  --manifest /var/lib/simpleminds/migration/rolling-v1-manifest.json \
  --execute
```

Default is dry-run. `--cap-epoch` defaults to the active epoch pointer, then
`ADMISSION_CAP_EPOCH`. `--quota-limit`, `--quota-window-ms`,
`--per-domain-limit` and `--rate-limit` override the approved config.

### Sources enumerated

- `<ADMISSION_DIR>/admission.sqlite` (legacy root)
- `<ADMISSION_DIR>/epochs/*/admission.sqlite`

`ACTIVE_POLICY.json`, `policies/*` and the target directory are never sources.
Each source is opened read-only; a non-empty `-wal` fails closed with
`SOURCE_NOT_QUIESCENT` (stop/checkpoint the service first). An empty WAL left by
a clean SQLite close is accepted.

### Import rules

- All `ADMITTED` decisions are imported with original `decided_at` and
  `decided_at_ms`; these count toward the rolling window only while inside
  `(now-24h, now]`.
- Genuine non-quota `REJECTED` decisions are imported to preserve
  first-decision-wins.
- Legacy `REJECTED reason='cap'` rows are **not** imported as decisions. They
  remain unchanged in the legacy source; the manifest reports their count,
  source rows and a bounded sample.
- Exact duplicate request IDs across stores are imported once and reported.
- Any request ID with different payload, decision, reason or timestamp across
  stores fails with `MIGRATION_IDENTITY_CONFLICT`.
- A request ID with both a cap rejection and a non-cap decision fails as a
  conflict.
- Attempts and conflict facts for imported decisions are copied; exact
  duplicates are idempotent.
- Malformed timestamps fail with `MALFORMED_TIMESTAMP`.
- A source decision later than the migration clock fails with
  `CLOCK_REGRESSION`.
- Missing sources fail with `SOURCE_MISSING`; an unsealed/corrupt source fails
  closed.
- Target decisions are compared after import. Missing, extra, or mismatched
  decisions fail with `MIGRATION_VERIFICATION_FAILED`.
- The target sealed policy hash must match the planned policy.

### Scope coverage

If `--frontier-dir` is supplied, the tool reads `frontier.ndjson` and maps
`requestId -> URL hostname`. Legacy decisions without a frontier record import
with `scope=null`; the manifest reports `withScope`/`withoutScope`. Per-domain
limits therefore apply to new admissions from cutover; legacy scope is not
invented. Conflicting scope records for one request fail with `SCOPE_CONFLICT`.

### Manifest

The manifest includes:

- tool version, mode (`dry-run`/`migrate`), source/target paths, clock;
- all source paths, kinds/epochs, DB SHA-256, sealed config and row counts;
- total/source decisions, imported admitted/non-cap-rejected counts, duplicate
  count, duplicate request IDs;
- excluded cap rejections: unique IDs, source rows, sample;
- identity conflicts (empty on success);
- scope coverage and frontier hash;
- rolling quota: window, limit, used (computed from timestamps), remaining,
  oldest counted admission, next capacity time, now;
- target policy/sealed config, target decision count, target DB SHA-256, target
  quota;
- verification: source hashes unchanged, target decisions match, quota matches,
  passed;
- `pointerCreated: false`.

Real migration writes the manifest after verification and target close. A rerun
is idempotent: existing target decisions are verified/skipped, `importedNow=0`
and the target DB hash is unchanged.

## 2. Files changed (Stage 2)

- `src/gateway/admission-migration.js` (new) — migration planner/executor,
  source enumeration, duplicate/conflict detection, cap-rejection exclusion,
  timestamp/scope handling, target verification and manifest.
- `src/cli/admission-migrate.js` (new) — dry-run/execute CLI; no pointer switch.
- `test/admission-migration.test.js` (new) — fixture coverage.
- `src/gateway/rolling-admission-store.js` — `importDecision`/`listDecisions`
  migration interface, idempotent target import and unique conflict identity
  index.
- `src/gateway/admission-store.js` — exported legacy config-hash helper used to
  validate sources.
- `docs/ROLLING-ADMISSION-MIGRATION.md` (this document).

Stage 1 files remain as implemented; the existing unrelated uncommitted changes
in `src/training/lifecycle.js`, `test/metrics.test.js`,
`test/python-trainer.test.js` and the production scripts are preserved.

## 3. Future production dry-run and cutover

Stage 2 does not execute these steps. The future privileged procedure is:

1. Stop `simpleminds-perpetual.timer` and `simpleminds.service`; verify jobs are
   stopped. Do not start training/learning.
2. Record/verify backups of the admission directory, `ACTIVE_EPOCH.json`, epoch
   DBs, frontier, relevant env/config metadata, active model pointer and
   evaluation-set hashes.
3. Confirm the source WAL is empty or checkpointed. Do not migrate a live,
   non-quiescent source.
4. Run the dry-run as `simpleminds` (with `HOME=/var/lib/simpleminds`) into a
   non-production staging target/manifest. Inspect source list, duplicate/
   conflict counts, excluded cap rejections, scope coverage, timestamps and
   computed rolling usage. Do not assume usage is 500; verify the value.
5. If and only if the dry-run is clean, run `--execute` to create the target
   policy store in the staging path and write the manifest. Verify:
   - source hashes unchanged;
   - target decisions/replay samples;
   - `quota.used` and oldest/next capacity;
   - target sealed policy hash;
   - `pointerCreated: false`.
6. Do **not** create `ACTIVE_POLICY.json` as part of this tool. A separate,
   explicitly approved cutover step would atomically install it after review,
   leave the legacy pointer/DBs intact, restart only `simpleminds.service`, and
   keep jobs/perpetual off.
7. Rollback: remove/restore the pointer (the legacy `ACTIVE_EPOCH.json` and all
   epoch DBs remain), restore the previous code snapshot if needed, and retain
   the rolling target/manifest for audit. Do not delete the target or legacy
   databases.

## 4. Storage-threshold assessment

Read-only measurements available without privilege:

```text
Filesystem      Size  Used Avail Use% Mounted on
/dev/nvme0n1p2  1.9T  227G  1.6T  13% /
/var/lib/simpleminds/data   576M
/var/lib/simpleminds/store   11G
/opt/simpleminds            6.0G
```

The admission directory is `simpleminds:simpleminds` mode `0750`; the current
user cannot read it:

```text
/var/lib/simpleminds/data/gateway  drwxr-x--- simpleminds simpleminds
admission.sqlite                   NOT_READABLE (permission denied)
```

Therefore the current **admission database size, WAL size and growth rate could
not be measured**. Obtaining them requires read access as `simpleminds` or a
privileged session; no privilege bypass was attempted. The service is healthy
and reports the legacy epoch 500/500.

Provisional values for approval (not measured, not activated):

```text
ADMISSION_STORAGE_MIN_FREE_BYTES=107374182400   # 100 GiB free-space reserve
ADMISSION_STORAGE_MAX_DB_BYTES=21474836480      # 20 GiB admission DB hard stop
```

Rationale: the host currently has 1.6 TB free, so a 100 GiB reserve leaves ample
headroom for the OS, SQLite WAL, backups and other state. A 20 GiB admission DB
cap is intended to cover a long operational period at 50,000 admissions/day
(about 18.25M decisions/year) while forcing an explicit review before unbounded
ledger growth. **These values are provisional and must be replaced by measured
values after privileged DB-size/growth sampling; do not activate them solely on
this estimate.** The storage guard remains implemented and tested in Stage 1.

## 5. Fixture test results

```text
$ node --test test/admission-migration.test.js
# tests 6
# pass 6
# fail 0
# skipped 0
# EXIT=0
```

Fixtures cover multiple source stores, exact duplicate and conflicting IDs,
legacy cap-rejection exclusion, original timestamps, replay, dry-run no-target,
exact window boundaries, clock regression, malformed timestamps, missing
sources, source hash preservation, target verification, no pointer creation and
idempotent rerun.

Combined migration/rolling/gateway/crawler/jobs suite:

```text
$ node --test test/admission-migration.test.js test/rolling-admission.test.js \
    test/rolling-admission-integration.test.js test/jobs.test.js \
    test/gateway-admission.test.js test/crawler-admission.test.js test/admission-epochs.test.js
# tests 80
# pass 80
# fail 0
# skipped 0
# EXIT=0
```

Canonical suite:

```text
$ timeout 600 npm test
# tests 662
# pass 655
# fail 0
# cancelled 0
# skipped 7
# duration_ms 2801.683174
# EXIT=0
```

`git diff --check` and syntax checks passed. All fixture tests use temporary
stores; no production data, service, pointer or external site was touched. One
earlier canonical run hit the known unrelated `recovery-progress` random-sample
flake and one hit the known suite hang; the final run above completed cleanly.

## 6. Production state

No production migration or dry-run was executed. No `ACTIVE_POLICY.json`, target
policy store, epoch, admission DB, frontier, environment file or service was
created/modified. No service was restarted; no perpetual timer, continuous job,
training, evaluation or promotion was started. No commit or push was performed.
