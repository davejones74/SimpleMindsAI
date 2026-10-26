# Rolling-Window Article Admission — Design and Migration Plan

- Date: 2026-10-26
- Host: `dave-X1PRO`
- Source checkout: `/home/dave/Repositories/SimpleMindsAI`
- Production: `/opt/simpleminds`
- Status: **executed on 2026-10-26 — see `ROLLING-ADMISSION-DEPLOYMENT-2026-10-26.md`**
- Policy: 50,000 article admissions in any rolling 24-hour window

## 1. Verified current behaviour

These are confirmed from the current source and live state, not assumptions:

- `AdmissionStore.#capUsed()` counts every `ADMITTED` row in the current store for
  its lifetime; it is not windowed:
  `SELECT COUNT(*) FROM requests WHERE decision='ADMITTED'`.
- Cap exhaustion currently inserts a durable
  `request_rejected(request_id, reason='cap')` (`admission-store.js:559–575`).
- The crawler sees that rejection and calls `Frontier.deferCapRejected()`, which
  returns the URL to `QUEUED`. It does **not** mark the URL terminal.
- However, the durable rejection row remains. A later retry derives the same
  `request_id` from the same URL/generation/capEpoch, so first-decision-wins
  would replay the old cap rejection instead of admitting the request when
  capacity returns. The current comment “a new epoch derives a new request
  identity” only works for a new `capEpoch`; it does not work for a rolling
  window in the same identity scope.
- Request identity includes `config.capEpoch`; changing the identity scope
  changes every derived request ID and risks duplicate logical acquisitions.
- One durable decision per request, first-decision-wins, replay behavior,
  SQLite WAL + `synchronous=FULL`, and `BEGIN IMMEDIATE` cap/decision atomicity
  are implemented and tested.
- `decided_at` is an ISO-8601 UTC string; there is no numeric timestamp index.
- The active epoch pointer and epoch DBs are immutable; the epoch manager can
  create a new store and switch `ACTIVE_EPOCH.json` atomically.
- Live state: active epoch `gateway-20261026-01`, 500/500 used; `job-32` and
  `job-33` stopped; discovery D1 is deployed and healthy.

## 2. Assumptions requiring validation

- The active epoch is the only store containing article admissions; older epoch
  or legacy root databases may exist and must be enumerated.
- The active epoch's 500 admissions are within the new 24-hour window, so the
  new policy would start at `used=500`, `remaining=49,500`.
- The active store's exact cap-rejection/conflict/attempt counts are not known
  until a privileged migration dry-run.
- Legacy rows do not carry a domain/scope column. Per-domain accounting cannot
  be reconstructed reliably for old admissions without a separate backfill.
- The production clock is NTP-synchronised; timestamp/clock behavior must be
  validated during migration.
- `/etc/simpleminds/simpleminds.env` is root-readable only; actual paths and
  limits must be confirmed in the privileged maintenance session.

## 3. Proposed design

### 3.1 New versioned policy store

Do not modify `gateway-20261026-01` and do not create another fixed-cap epoch.
Create a new, explicitly versioned rolling-policy store:

```text
/var/lib/simpleminds/data/gateway/
  policies/
    rolling-v1/
      admission.sqlite
  ACTIVE_POLICY.json
  policies.ndjson
  epochs/...                    # retained legacy audit, unchanged
  ACTIVE_EPOCH.json             # retained legacy pointer, unchanged
```

`ACTIVE_POLICY.json` is the cutover pointer. The server/gateway prefers it when
present; otherwise it continues to open the legacy epoch. The old epoch DB and
pointer remain untouched for audit and rollback.

Proposed sealed policy fields:

```text
policy_version       = rolling-v1
policy_mode          = rolling
quota_window_ms      = 86400000
quota_limit          = 50000
cap_epoch            = gateway-20261026-01   # preserve request identity
ack_required         = false
protocol_version     = baseline-v1
schema_version       = rolling-1
config_hash           = hash of all above
```

Keeping `cap_epoch` equal to the legacy identity scope is essential: existing
request IDs and deduplication remain stable. `policy_version` identifies the
new policy but must not be part of the logical request ID unless a separate,
explicit identity migration is approved.

### 3.2 Timestamp and window semantics

- Add a durable integer `decided_at_ms` (UTC epoch milliseconds) to decision
  rows, populated from the store clock at commit. Keep `decided_at` ISO for human
  audit.
- Capture `nowMs` once per admission transaction.
- Count:

  ```text
  decision = 'ADMITTED'
  AND decided_at_ms > nowMs - 86_400_000
  AND decided_at_ms <= nowMs
  ```

  This is a half-open window `(now - 24h, now]`: an admission exactly 24 hours
  old is outside; an admission at `now` is inside.
- `quota_used` is derived from durable decision facts. There is no mutable
  counter.
- `remaining = max(0, 50000 - quota_used)`.
- `oldest_counted_at` and `next_capacity_at = oldest_counted_at + 24h` are
  derived for observability/backpressure.
- If the clock moves backwards below the maximum durable `decided_at_ms`, fail
  closed with a clock-regression error rather than silently freeing quota.
- Existing ISO timestamps are parsed as UTC; unparseable timestamps make
  migration fail closed.

Indexes: `(decision, decided_at_ms)`, optionally `(scope, decision, decided_at_ms)`
for per-domain accounting.

### 3.3 Quota exhaustion is a transient deferral, not a durable rejection

This is the most important change from current behavior:

- When the rolling quota or a separate rate/domain/storage limit is full, the
  admission transaction writes **no `requests` decision**.
- Return a transient result:

  ```text
  outcome = DEFERRED
  decision = null
  reason = quota | rate | domain | storage
  retryAfterMs / nextCapacityAt
  quotaUsed / quotaLimit / remaining
  ```

- Record a separate bounded quota-deferral audit event/table (not a `requests`
  decision, not counted toward quota).
- The crawler/frontier returns the URL to `QUEUED`/deferred with
  `nextAttemptAt`, never a terminal rejection.
- When capacity returns, the same request ID has no prior decision and can be
  admitted normally. Replays of an already-admitted request still return the
  original decision.
- Non-quota rejections (protocol/identity/validation) remain durable and
  terminal under the existing rules.

This intentionally supersedes Baseline v1's durable
`request_rejected(reason='cap')` behavior for quota only. It requires a new
accepted policy decision; it is not a silent protocol change. The old cap
rejection rows remain audit history in the legacy store.

### 3.4 Atomicity, concurrency, crash recovery

- One `BEGIN IMMEDIATE` transaction per admission:
  1. load sealed policy;
  2. check existing decision/conflict (first-decision-wins);
  3. compute `nowMs` and quota/rate/domain/storage checks;
  4. on defer, return transient without inserting a decision;
  5. on admission, insert `request_id`, `payload_digest`, `decided_at_ms`,
     `decided_at`, `scope`/domain;
  6. commit before returning.
- SQLite `busy_timeout`, WAL and `synchronous=FULL` remain the cross-process
  serialization boundary.
- A process-level admission semaphore enforces the configured concurrency limit
  within the service; cross-process admission is serialized by SQLite.
- Crash before commit: no decision; retry is safe.
- Crash after commit: durable decision; retry is a replay, no new quota unit.
- Crash during a transient deferral: no quota decision; retry is safe.
- Fault-injection tests at attempt/decision commit and deferral paths.
- No response is sent before a cacheable/durable decision exists.

### 3.5 Identity and idempotency

- Keep the existing URL/generation/protocol/capEpoch identity derivation.
- One durable decision per request; first decision wins.
- Replay returns the original decision and does not consume quota.
- A post-decision payload conflict remains a durable compliance violation.
- A transient quota deferral creates no decision, so the next retry is a fresh
  admission attempt, not a replay of a rejection.
- A quota-deferred retry may be admitted with a later `decided_at_ms`; the
  logical request ID is unchanged.
- Do not generate a new request ID or increment generation solely because quota
  was full.

### 3.6 Migration from the sealed epoch

Migration is offline and reversible. It must not edit the old epoch.

1. Stop `simpleminds-perpetual.timer` and `simpleminds.service`; keep jobs
   stopped; confirm no admission writer.
2. Take a verified backup of:
   - admission directory (all epoch DBs, pointers, ledgers);
   - the frontier and its deferral/recovery ledger;
   - config/env metadata (not secrets in logs);
   - active model/registry/evaluation-set hashes.
3. Enumerate all existing sealed stores: active epoch, all `epochs/*` DBs, and
   a legacy root `admission.sqlite` if present.
4. Create a new `policies/rolling-v1` store in a temporary path.
5. Import all **non-quota** durable decisions:
   - all `ADMITTED` rows;
   - non-quota `REJECTED` rows (preserve first-decision-wins);
   - copy attempts/conflicts and original timestamps.
   - **Do not import `REJECTED reason='cap'` as a decision.** Keep those rows in
     the legacy DB as audit history; report them in the migration manifest.
   - Preserve the original `cap_epoch` identity scope.
   - Optionally backfill `scope`/domain from frontier records that still carry
     the same request ID; otherwise leave null and report coverage. Old
     admissions count globally; per-domain accounting begins at cutover.
6. Compute `quota_used(now)` in the new store. Expected current value: 500 if
   all legacy admissions are within 24h; report `oldest_counted_at` and
   `next_capacity_at`.
7. Verify:
   - source DB hashes unchanged;
   - target counts/IDs/timestamps;
   - sampled old admissions replay with their original decisions;
   - quota count and oldest timestamp;
   - excluded legacy cap rejections counted in the manifest;
   - target sealed config/hash and policy ID;
   - no writes to the old pointer.
8. Atomically write `ACTIVE_POLICY.json` only after verification.
9. Start the service with jobs/perpetual still disabled; verify health/status.
10. Keep `ACTIVE_EPOCH.json` and all legacy DBs for rollback/audit.

Migration manifest must include source/target paths, hashes, row counts,
admissions in window, oldest/newest timestamps, excluded cap rejections,
conflict/attempt counts, scope coverage, policy config, tool version and
operator identity.

### 3.7 Backpressure and retry

- A full quota returns `DEFERRED` with `nextCapacityAt` = oldest counted
  admission + 24h (bounded by a configurable maximum wait).
- The frontier records deferral metadata and leaves the URL queued, not
  rejected.
- The supervisor uses a `waiting-for-admission-quota` state with
  `quotaUsed`, `quotaLimit`, `retryAfterMs`, `policyVersion`; no no-progress
  budget is consumed while waiting.
- Retry has jitter/backoff bounded by a maximum; when capacity is available the
  same request can be admitted.
- Old frontier records terminally marked `REJECTED` with `lastError='cap'` are
  recovered to `QUEUED` by the existing bounded recovery tool, now labelled
  legacy-cap recovery. Do not recover protocol/quarantine rejects.
- The current per-URL `capDeferrals` array must not grow without bound; the new
  design uses a bounded deferral event/table and retains only a small recent
  history per URL if needed.

### 3.8 Independent safety limits

All limits are independent of the 50k rolling article quota:

- **Per-domain rolling quota**: configurable, e.g. 5,000 admissions per domain
  per 24h. Recorded in new decisions; legacy admissions are global-only unless
  scope backfill is proven.
- **Global request-rate limit**: short rolling window, e.g. 2,000 admissions per
  minute, derived from `decided_at_ms`; prevents bursts inside the 24h quota.
- **Per-domain rate/concurrency**: configurable, enforced at the gateway.
- **Admission concurrency**: process-level semaphore plus SQLite writer
  serialization.
- **Disk/storage hard stop**: before admission, check free bytes on the durable
  volume and admission DB size; below a configured hard threshold, return
  `DEFERRED reason=storage` and alert. Do not admit when storage is unsafe.
- **Frontier/queue budget**: existing frontier size and discovery budgets remain
  separate; do not let admission backpressure grow unbounded frontier/queue
  storage.
- Proposed defaults are examples for approval; no values are fixed by this
  plan.

### 3.9 Observability

Expose read-only status in `/health` and admin metrics:

- policy ID/version and source (`ACTIVE_POLICY.json` vs legacy epoch);
- window ms, quota limit, used, remaining;
- oldest counted admission and next capacity time;
- rate-limit usage and next rate slot;
- per-domain usage for the top configured domains;
- deferral count/last reason/next retry;
- storage guard state (free bytes, DB size, hard-stop threshold);
- migration manifest ID/status;
- errors (clock regression, policy corruption, missing target).

Job events/logs use `waiting-for-admission-quota`, not a generic cap message.
No secrets are logged.

## 4. Migration risks

1. **Identity drift** if `cap_epoch` changes during migration. Keep the same
   identity scope; validate request-ID replay in the dry-run.
2. **Legacy cap-rejection poisoning** if `reason='cap'` rows are imported as
   decisions. Exclude them; retain the old DB for audit. This is the current
   bug that would otherwise make retries permanently rejected.
3. **Timestamp/clock errors** could free or consume quota incorrectly. Use
   integer UTC milliseconds, fail closed on unparseable/inverted timestamps, and
   require a validated clock.
4. **Offline cutover** is required to avoid admissions during copy. An online
   migration needs a lock and a freeze protocol; not proposed for v1.
5. **Multiple legacy stores** may contain duplicate/overlapping request IDs.
   Dry-run must count and fail on conflicts.
6. **Per-domain scope is absent from legacy rows.** Global quota is exact;
   per-domain limits start at cutover unless a validated backfill exists.
7. **Old frontier cap rejects** must be recovered without touching real
   protocol/quarantine rejects.
8. **Disk/storage growth** from retaining all decisions requires a storage
   budget and later archival strategy; do not silently delete identity facts.
9. **Pointer/code ordering**: switch the policy pointer only after target
   verification; deploy code that understands both legacy and rolling stores;
   never let old code read an unknown policy pointer.
10. **Rollback** must restore the old pointer/code without deleting the new
    policy store or legacy DBs.
11. **Policy semantics supersede Baseline v1** for quota deferral; record this
    as an accepted decision before implementation.

## 5. Staged implementation plan

### Stage 0 — approval and dry-run design (this document)

- Approve the rolling policy semantics and the transient quota deferral.
- Approve the per-domain/rate/storage defaults.
- Approve the new policy store/pointer naming.

### Stage 1 — rolling store and deferral (isolated)

- Add rolling policy schema/status/accounting.
- Add transient `DEFERRED` outcomes.
- Add gateway/frontier/supervisor backpressure handling.
- Add tests for boundaries, concurrency, replay, deferral and crash recovery.
- No migration or production changes.

### Stage 2 — migration tool (fixtures only)

- Add dry-run/real migration with source/target verification.
- Add legacy cap-rejection exclusion and audit manifest.
- Test on constructed legacy stores, including multiple stores and conflicts.
- No production writes.

### Stage 3 — privileged dry-run against production

- Stop jobs/service only for the maintenance window.
- Back up and enumerate actual stores.
- Run migration dry-run, inspect counts/timestamps/identity samples.
- Do not switch the pointer in this stage.

### Stage 4 — cutover and deployment

- Stop service/perpetual timer; verify jobs stopped.
- Back up admission/frontier/config/eval/model pointers.
- Run migration, verify, atomically switch `ACTIVE_POLICY.json`.
- Deploy rolling-aware code with the corrected `npm ci` command
  (`HOME=/var/lib/simpleminds`), start only `simpleminds.service`.
- Verify health, policy status, quota used/remaining, discovery ledger unrelated.
- Leave jobs/perpetual disabled until separately authorized.

### Stage 5 — rollback rehearsal

- Restore the previous code snapshot and `ACTIVE_EPOCH.json`; old DBs remain.
- Verify old replay decisions and service health.
- Retain the rolling store/ledger for audit.

## 6. Files expected to change

- `src/gateway/admission-store.js` — rolling window, `decided_at_ms`, scope,
  transient deferral, status, schema/config hash.
- `src/gateway/admission-policy.js` (new) — policy pointer/store manager,
  legacy fallback, sealed policy.
- `src/gateway/admission-migration.js` (new) — dry-run/real migration,
  manifests, verification, legacy cap-rejection exclusion.
- `src/gateway/admission-epochs.js` — legacy integration/status, no destructive
  changes.
- `src/gateway/admission-backup.js` — include rolling policy/pointer.
- `src/gateway/acquisition-gateway.js` — domain/scope, `DEFERRED`, retryAfter,
  quota status.
- `src/harness/crawler.js` — quota deferral, no terminal rejection, retry hints.
- `src/frontier.js` — bounded deferral metadata, legacy cap recovery, retry.
- `src/jobs/supervisor.js`, `src/jobs/learning.js` — quota wait state/observability.
- `src/server.js` — open policy-aware manager; health/metrics.
- `src/cli/admission.js` — status/dry-run/migrate/rollback commands.
- `src/config.js`, `.env.example`, `deploy/etc/x1pro.simpleminds.env` —
  policy/limits config.
- `test/admission-rolling.test.js`, `test/admission-migration.test.js` (new);
  update `test/gateway-admission.test.js`, `test/crawler-admission.test.js`,
  `test/admission-*` as needed.
- `docs/ROLLING-ADMISSION.md` (new), `docs/PRODUCTION.md`,
  `docs/DEPLOYMENT.md` — migration/rollback/operating procedure.

## 7. Acceptance criteria

1. In any rolling 24h window, at most 50,000 `ADMITTED` decisions; exactly
   50,000 succeeds and the next request is transiently deferred.
2. A request admitted at exactly `now - 24h` is outside the window; at
   `now - 24h + 1ms` it is inside. Tests use a fixed clock.
3. Quota exhaustion writes **no** `requests` decision and does not permanently
   reject the URL; a retry after capacity is admitted with the same request ID.
4. Replays and duplicates return the original decision and consume no quota.
5. Concurrent processes at the quota boundary produce exactly 50,000 admissions
   and no overshoot; SQLite transaction/restart behavior is tested.
6. Migration copies all admitted/non-quota decisions with original timestamps;
   old DB hashes are unchanged; legacy cap rejections remain only in legacy
   audit and are excluded from new decisions; existing admissions inside the
   window count (expected 500 in the current state).
7. Old admitted requests replay their original decisions in the new store;
   sampled IDs/timestamps verify.
8. Per-domain/rate/storage limits are independent, observable and fail closed.
9. Observability reports used/limit/remaining/oldest counted/next capacity/
   deferrals/errors.
10. Rollback restores the legacy pointer/code without deleting either store and
    preserves all audit history.
11. No perpetual timer, learning/training/evaluation/promotion job is started
    by the migration or deployment.

## 8. Open decisions for approval

- Confirm the per-domain quota (e.g., 5,000/24h), short-window rate (e.g.,
  2,000/minute), storage hard-stop thresholds and concurrency limit.
- Confirm the policy identifier/path (`rolling-v1`,
  `policies/rolling-v1`, `ACTIVE_POLICY.json`).
- Confirm the transient `DEFERRED` semantics as the accepted replacement for
  durable quota rejections (new policy decision).
- Confirm whether per-domain limits start at cutover (legacy scope unavailable)
  or a frontier-based scope backfill is required.
- Confirm the migration window and rollback/backup procedure.

No implementation, migration, epoch creation, production state change, job
start, training, evaluation, promotion, commit or push was performed.
