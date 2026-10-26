# Rolling Admission — Stage 1 Implementation

- Date: 2026-10-26
- Source checkout: `/home/dave/Repositories/SimpleMindsAI`
- Status: **Stage 1 implemented and tested in source; not deployed; no production policy pointer installed**
- Scope: rolling-policy store, transient quota deferral, backpressure integration, tests; no migration/deployment

## 1. Implemented semantics

### Rolling policy store

- New store: `policies/rolling-v1/admission.sqlite`, selected by `ACTIVE_POLICY.json`.
- Legacy `epochs/*` stores and `ACTIVE_EPOCH.json` are never modified or migrated by Stage 1.
- When no policy pointer exists, the service continues to use the legacy sealed epoch.
- Sealed policy fields include: policy version/mode, `cap_epoch` identity scope, quota
  window/limit, per-domain limit/window, short rate window/limit, max concurrency,
  storage thresholds, deferral retention/max rows, ACK and protocol fields, and a
  policy hash.
- Malformed sealed policy, pointer mismatch, missing target and clock regression
  fail closed.

Approved starting values:

```text
quota window       24h (86,400,000 ms)
global quota       50,000 admissions / rolling 24h
per-domain quota   5,000 admissions / domain / rolling 24h
short rate         2,000 admissions / rolling minute
concurrency        1 admission operation at a time
```

### Timestamp semantics

- Every decision stores `decided_at_ms` (UTC epoch milliseconds) and ISO
  `decided_at` for audit.
- Count: `decision='ADMITTED' AND decided_at_ms > now - 86,400,000 AND decided_at_ms <= now`.
- Window is half-open `(now-24h, now]`: exactly 24h old is outside.
- Quota is derived from durable decisions; no mutable counter.
- A clock regression (now before the latest durable decision) throws
  `CLOCK_REGRESSION` and writes no decision.

### Transient deferral

- Quota, per-domain, rate and storage exhaustion return `DEFERRED`.
- Quota deferral writes **no `requests` decision**. The same request ID can be
  retried and admitted when capacity returns.
- Deferrals are recorded in a separate bounded `deferrals` table (one row per
  request, pruned by retention/max rows); they never count as decisions or cap.
- Non-quota/identity/conflict decisions remain durable and first-decision-wins.
- This intentionally supersedes the legacy `request_rejected(reason='cap')`
  behavior for rolling quota; the legacy epoch path is unchanged.

### Backpressure integration

- `AcquisitionGateway` passes the target host as `scope` and handles `DEFERRED`
  without an epoch retry.
- `runCrawlCycle` calls `Frontier.deferAdmission()`, records the transient reason,
  retry time and quota status, and stops the cycle before any article fetch.
- `Frontier.deferAdmission()` stores one bounded `admissionDeferral` summary per
  URL; it does not append an unbounded per-URL array.
- `runCrawlBatches` aggregates `quotaExhausted`, `admissionQuotaDeferred`, usage,
  retry time and policy version.
- `learning.js`/supervisor surface `waiting-for-admission-quota` with
  used/limit/retry/policy fields and wait using the retry hint (bounded to 1h).
- Legacy cap deferral/recovery remains available for old epoch records.

### Safety limits

- Per-domain quota is independent of the global 24h quota.
- Short-window admission rate is independent of both.
- Concurrency is one operation in-process plus SQLite `BEGIN IMMEDIATE` for
  cross-process serialization.
- Storage guard supports independent `ADMISSION_STORAGE_MIN_FREE_BYTES` and
  `ADMISSION_STORAGE_MAX_DB_BYTES` hard stops; below threshold returns
  `DEFERRED reason=storage` and no decision.
- **Storage thresholds default to 0 (disabled).** No production threshold was
  invented. Production must set both values from measured disk usage and reserve
  requirements before activating the policy.
- Deferral rows are bounded by retention (default 7 days) and max rows (100,000).

### Policy status

- `/health` reports the active manager status (legacy or policy), including quota
  used/limit/remaining, oldest counted admission, next capacity, rate usage,
  top domains, deferrals, storage status and clock-regression flag for the
  rolling store.
- `src/cli/admission.js policy-status` reports the active policy/legacy status.
- Existing admission status/recovery commands remain.

## 2. Files changed

- `src/gateway/rolling-admission-store.js` (new) — rolling policy store,
  `decided_at_ms`, quota/rate/domain/storage guards, transient deferral,
  bounded deferral metadata, clock regression, status.
- `src/gateway/admission-policy.js` (new) — policy pointer, validation,
  rolling/legacy manager, status.
- `src/gateway/admission-store.js` — shared `DEFERRED` enum outcomes.
- `src/gateway/acquisition-gateway.js` — domain scope and deferred handling.
- `src/frontier.js` — bounded `admissionDeferral` metadata, persistence.
- `src/harness/crawler.js` — deferred path, quota summaries, policy manager in CLI.
- `src/jobs/learning.js`, `src/jobs/supervisor.js` — quota wait/backpressure fields.
- `src/discovery/discovery-service.js` — pass through quota fields.
- `src/server.js` — policy-aware admission manager and status.
- `src/cli/admission.js` — `policy-status` and policy pointer in status.
- `src/config.js`, `.env.example`, `deploy/etc/x1pro.simpleminds.env` — approved
  policy config and disabled-until-measured storage thresholds.
- `test/rolling-admission.test.js` (new), `test/rolling-admission-integration.test.js`
  (new), `test/jobs.test.js` (quota supervisor test).
- `docs/ROLLING-ADMISSION-STAGE1.md` (this document).

Existing unrelated uncommitted changes in `src/training/lifecycle.js`,
`test/metrics.test.js`, `test/python-trainer.test.js`, and the two production
scripts were preserved.

## 3. Tests

Focused rolling admission tests:

```text
$ node --test test/rolling-admission.test.js
# tests 13
# pass 13
# fail 0
# skipped 0
# EXIT=0
```

Crawler/frontier integration:

```text
$ node --test test/rolling-admission-integration.test.js
# tests 1
# pass 1
# fail 0
# EXIT=0
```

Combined admission/crawler/jobs/discovery/frontier suite:

```text
$ node --test test/rolling-admission.test.js test/rolling-admission-integration.test.js \
    test/jobs.test.js test/gateway-admission.test.js test/crawler-admission.test.js \
    test/admission-epochs.test.js test/discovery-operations.test.js \
    test/frontier-cap-recovery.test.js test/frontier.test.js test/frontier-rediscovery.test.js
# tests 97
# pass 97
# fail 0
# skipped 0
# EXIT=0
```

Canonical suite:

```text
$ timeout 600 npm test
# tests 656
# pass 649
# fail 0
# cancelled 0
# skipped 7
# duration_ms 3006.786523
# EXIT=0
```

`git diff --check` passed; syntax checks passed for all changed files. All tests
use temporary stores and mocks; no production data or external sites.

### Evidence highlights

- **No durable decision on quota exhaustion:** rolling tests assert
  `getDecision()` is `null` for deferred requests and that no `REJECTED` decision
  is written.
- **Same request ID succeeds later:** quota test and crawler integration retry the
  deferred request ID after the window advances and receive `ADMITTED`.
- **Window boundaries:** at `T0+999` the first admission still blocks; at
  `T0+1000` it is outside the half-open window and the deferred request is admitted.
- **No concurrency overshoot:** in-process and cross-process tests at quota 1/2
  produce exactly the allowed admissions and defer the rest.
- **Restart/crash:** fault injection before decision commit leaves no decision;
  retry succeeds. A decision committed before a fault replays after reopen.
- **Bounded deferrals/storage:** deferral rows stay within the configured max;
  injected and configured storage guards defer without a decision.

## 4. Deviations / unresolved risks

1. **No production activation.** `ACTIVE_POLICY.json` was not created and the
   legacy epoch remains active. This is required by Stage 1 boundaries.
2. **Storage thresholds default disabled.** The guard is implemented and tested,
   but no production threshold was invented. Values must be set from measured
   disk usage/reserve before activation.
3. **Migration is not implemented.** Stage 2 must copy admitted/non-quota
   decisions, exclude legacy `reason='cap'` rows from decisions, preserve request
   identity, and count every legacy store. The rolling store is designed for this
   but no migration tool exists yet.
4. **Legacy cap deferral remains.** `deferCapRejected` and recovery remain for old
   epoch records; the rolling path uses `deferAdmission`. This is intentional.
5. **Per-domain scope for legacy admissions is not backfilled.** Per-domain limits
   apply to new rolling admissions after cutover, as approved; legacy admissions
   count globally.
6. **The config/source changes are not deployed.** Production remains on the
   previously deployed D1/admission code until a separate privileged deployment.

## 5. Production state

No production policy pointer, admission database, epoch, frontier, job, model,
registry, evaluation evidence, or environment file was changed. No service was
restarted or deployed; no perpetual timer or continuous job was started. No
training, evaluation, promotion, commit or push occurred.
