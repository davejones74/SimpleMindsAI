# Discovery Regression Report and Bounded Test Plan

- Date: 2026-10-26
- Host: `dave-X1PRO`
- Authoritative source checkout: `/home/dave/Repositories/SimpleMindsAI`
- Repository HEAD: `89b5b9d73fdbd57f63fd8fa759108c5474ccf228`
- Production install: `/opt/simpleminds`
- Durable state: `/var/lib/simpleminds`
- Status: **regression confirmed; no production or code changes made**
- Scope of this document: discovery regression + bounded restoration plan only

## 1. Deployment/source facts

The authoritative source is the development checkout at
`/home/dave/Repositories/SimpleMindsAI`. `/opt/simpleminds` is a deployment copy,
not a Git checkout. The documented deployment workflow is
`docs/PRODUCTION.md` §15.1 (stop service, rsync with exclusions, `npm ci`,
restart, verify). The rsync exclusions used for a real deployment must also
exclude `.deploy-backup` and the development venv/cache directories, as
established in `docs/DEPLOYMENT-RESULT-2026-10-25.md`.

Current source/deployment hashes for the discovery path are identical:

| File | Repository = Production SHA-256 |
|---|---|
| `src/discovery/discovery-service.js` | `4fc2e520ae04afef9ab47af76f862f979cc3db70beb6e633f78cdd3f9a0c3eb6` |
| `src/discovery/adapters/index.js` | `5c2a26b5cffcd771e4321e5552de52a6f3f495fb0593f00339e91c9920549cec` |
| `src/discovery/adapters/sitemap-adapter.js` | `bb6fa1467039be02fce57bdfe0aa6e255d53a43f35a8ab4e9f289e133440ca72` |
| `src/discovery/adapters/feed-adapter.js` | `6f23cbc27689227e317f33303812bbfa666d460ed9660d5a81e6d36db0f6f815` |
| `src/discovery/adapters/search-adapter.js` | `329d76e0aeafb6715a606507e0690361b83b99dc428b5cf11aab1908d5122f91` |
| `src/harness/crawler.js` | `e36e5688d62fddb7748779a11035908488511202db516f3b5a0b5406ba8fe619` |
| `src/config.js` | `948233f927fffe22edd61e21b1c3e5ac381e97e1e462e9a17978d0ab50ffacb7` |

The working tree has unrelated uncommitted changes in
`src/training/lifecycle.js`, `test/metrics.test.js`,
`test/python-trainer.test.js`, and two production scripts. They must be
preserved and are not part of this discovery change.

## 2. Regression confirmed

### Code-level cause

`DiscoveryService` disables all discovery adapters whenever the admission
gateway is present:

- `src/discovery/discovery-service.js:112–117`: if `admissionGateway` is set and
  non-empty adapters are supplied, it throws `ADMISSION_PATH_DISABLED`.
- `src/discovery/discovery-service.js:143–146`: `this.adapters = admissionGateway ? [] : ...`.

The comment says adapters perform network I/O outside the target-acquisition
boundary and are disabled until an explicit admission integration exists. That
was a safe response to the gateway bypass risk, but it removed supported
discovery functionality.

The regression is enshrined in the test suite:

- `test/crawler-admission.test.js:404–446` explicitly asserts that
  `service.adapters` is `[]` when the gateway is enabled and that supplying
  adapters throws.
- The pre-existing adapter tests (`test/discovery-adapters.test.js`,
  `test/discovery-bootstrap.test.js`, `test/discovery.test.js`,
  `test/discovery-language-prior.test.js`) cover adapters without a gateway and
  therefore do not catch the gateway-mode regression.

### Production evidence

Before the gateway was enabled, production discovery used the built-in
sitemap/feed adapters:

```text
job-25, 2026-10-21T20:17:39Z
providerAvailable: true
adapters:
  sitemap: status=ok, found=500, enqueued=495, rootsTried=25, sitemapsFetched=39
  feed:    status=idle, reason=no-feed-candidates

job-32, 2026-10-26T18:03:00Z (after gateway enforcement)
providerAvailable: false
adapters: []
roots: 3364
frontier: 167201 queued, 12628 visited, 1540 deferred
```

The 3,364 roots are registry/seed roots. The adapters are not probing them. The
large queued frontier is legacy work from before the gateway; it is not evidence
that discovery is currently operating.

The regression is independent of the exhausted admission cap. Even after the
cap is reset, the current code will continue to report `adapters: []` and will
not discover new domains via sitemap/feed/search.

### Intended behaviour

- Discovery should capture domains where discovery/search is possible.
- Discovery operations must remain governed and auditable; they must not become
  an unaudited network bypass.
- Discovery only proposes candidate URLs. Article acquisition must still pass
  URL safety, robots, and article admission through the gateway.
- Discovery-operation budgets must be recorded separately from article
  admission quotas.

## 3. Adapter support/configuration/operability

| Adapter/path | Supported in code | Configured | Historically operational | Current status |
|---|---|---|---|---|
| Landing-page link extraction | Yes (`runCrawlCycle`) | Yes, part of crawling | Yes, when acquisition allowed | Works only when article admission is available; cap currently blocks it |
| Sitemap | Yes (`sitemap-adapter.js`) | Code default includes `sitemap`; production job history shows it active | Yes: 500 candidates/cycle in job-25 | Disabled when gateway enabled |
| Feed | Yes (`feed-adapter.js`) | Code default includes `feed`; production history shows idle with no feed candidates | Yes, but idle in production | Disabled when gateway enabled |
| Search | Yes (`search-adapter.js`) | No provider/endpoint/queries in the deployment template | Not demonstrated in production | Disabled; provider-dependent; defer |

The production environment file is root-readable only and was not inspected.
The job-event reports are the authoritative production observation; the
deployment template and code defaults are supporting evidence, not a substitute
for the live env.

## 4. Impact

- New sitemap/feed/search discovery is stopped. Only existing seeds, registered
  domains, and default seeds can enter the frontier.
- The 167k legacy queued URLs remain claimable, but they cannot be replenished
  as the frontier is consumed.
- The system cannot scale to a perpetual acquisition process if supported
  discovery remains disabled.
- Re-enabling adapters naively would reintroduce the gateway-bypass risk that
  the hardening was designed to prevent. A governed discovery-operation path is
  required.

## 5. Bounded restoration plan (D1)

### Scope

Restore the **smallest safe discovery path**:

1. Verify/retain landing-page link extraction (already gateway-guarded).
2. Restore sitemap discovery under a separate governed discovery-operation
   budget.
3. Restore feed discovery only if configured; production history shows it idle.
4. Defer search until a provider is explicitly configured and a separate
   governed search path is designed.
5. Do not change article admission/quota semantics in this slice.
6. Do not restore adapters by bypassing the gateway.

### Proposed implementation shape

- Add a durable **discovery-operation ledger** (separate from the admission
  ledger) recording operation id, timestamp, adapter, URL/domain, status,
  bytes/limits, candidate count, and error. Use a dedicated directory under the
  durable data tree; do not mix it with article admission counts.
- Add a sealed/simple config block for discovery operations: enabled adapters,
  per-window operation budget, per-domain rate, global concurrency, timeout and
  byte limits. The smallest safe default is sequential operations.
- Wrap the adapter `fetchText`/`fetchJson` path with the governed operation
  budget. No adapter network I/O occurs without a granted operation.
- Keep the existing adapter candidate pipeline unchanged: policy, domain
  registry, language prior, robots/SSRF, and frontier enqueue.
- Article candidates still require the existing admission gateway at fetch
  time. Discovery never fetches the candidate page itself.
- When the discovery-operation budget is exhausted, adapters return a
  `budget-exhausted`/deferred status; no network calls, no silent overflow.
- Record discovery operations separately from article admissions in job events,
  health/metrics, and audit logs.

### Acceptance criteria

- With the gateway enabled and sitemap configured, `DiscoveryService.adapters`
  contains sitemap (and feed when configured); it is not forced to `[]`.
- Every adapter network request is preceded by a durable discovery-operation
  grant and recorded with provenance; robots/SSRF/timeout/byte/redirect checks
  still apply.
- When the discovery-operation budget is exhausted or the domain rate limit is
  hit, no further adapter network call is made; status reports deferral.
- Sitemap/feed candidates pass policy, domain registry, and language prior, then
  enter the frontier only; no candidate article is fetched by discovery.
- Article admission remains the only path to article fetch; gateway cap
  exhaustion still defers article acquisition without permanently rejecting URLs.
- Discovery-operation counts and article admission counts are reported
  separately and cannot be mistaken for each other.
- Search with no provider remains `unavailable` and makes no network calls.
- Existing discovery behaviour without a gateway remains unchanged.
- Restart preserves the discovery-operation ledger/budget state (or the chosen
  durable design explicitly documents its recovery semantics).

### Test coverage (bounded, mocked/local only)

1. **Regression proof**
   - New test: gateway enabled + sitemap configured => adapters non-empty and
     sitemap runs through the governed fetch (mocked).
   - Remove/replace the old assertion that gateway mode must have zero adapters.
   - Existing adapter unit tests without gateway continue to pass.

2. **Governed discovery budget**
   - Allow/deny at the window boundary; no network when denied.
   - Per-domain rate limit; different domains do not share a per-domain bucket.
   - Global concurrency/sequential limit; timeouts/byte/redirect limits.
   - Durable ledger append + restart recovery; idempotent operation identity.
   - Separate discovery-operation count vs article admission count.

3. **Sitemap/feed integration**
   - Mock robots `Sitemap:` directive → sitemap index → page URLs.
   - `/sitemap.xml` fallback; sitemap URLs never enqueued as documents.
   - Feed advertised link/explicit feed; feed disabled/unavailable is honest.
   - Candidate filtering by policy/domain/blocklist/language prior.
   - Candidate enqueued to frontier; candidate page not fetched by discovery.
   - Gateway article admission tested separately; exhausted cap defers article
     acquisition, not discovery.

4. **Failure/negative paths**
   - Budget exhausted => zero adapter fetch calls, explicit status.
   - Missing provider search => `unavailable`, zero calls.
   - Adapter error/timeout => recorded, bounded, no retry storm.
   - Gateway bypass attempt via caller-supplied adapters => rejected unless the
     adapters are wrapped by the governed path; no direct fetch.

5. **Isolation**
   - All tests use temporary frontier/store/ledger directories and injected
     fetch implementations. No external websites.
   - Run focused discovery tests plus the gateway/crawler boundary tests, then
     the canonical `timeout 600 npm test`.

### Migration / rollback

- This slice should add a new durable discovery data directory and config keys;
  it should not migrate or modify the existing article admission database,
  article store, frontier, models, registry, or evaluation set.
- If an existing discovery ledger is absent, create it empty; do not infer or
  reset any admission state.
- Rollback: disable the new discovery adapters via config (or revert the
  discovery slice) and restart. The existing frontier and all durable data
  remain; the discovery ledger is retained for audit. Do not delete production
  data during rollback.
- Before deployment: stop service, use the corrected rsync exclusions, run the
  focused tests, and verify with an isolated/temporary store first.

## 6. Out of scope for this slice

These remain separate decisions/changes and must not be bundled with D1:

- rolling admission quota/rate protocol
- teacher-authoritative importance
- content/reference/snapshot retention and expiry
- fragment-quality gate
- threshold-based evaluation cadence
- search-provider restoration

The next change after D1 should be chosen independently, with its own plan,
acceptance criteria, migration/rollback and tests.

## 7. Verified vs assumed

**Verified:**

- Code disables adapters when `admissionGateway` is set.
- The old test explicitly requires zero adapters in gateway mode.
- Production job-25 used sitemap/feed adapters with providerAvailable=true.
- Production job-32 reports adapters=[] and providerAvailable=false.
- Source and production discovery files have identical hashes.
- Current cap/epoch is 500/500 and both job-32/job-33 are now stopped.

**Unverified/assumed:**

- The exact contents of `/etc/simpleminds/simpleminds.env` (root-readable only).
- The exact deployed adapter list (the job report is authoritative; the
  deployment template suggests sitemap/feed).
- Whether search was ever configured in production; the template has no search
  endpoint and job-32 reports providerAvailable=false.

No production data, jobs, models, or configuration were changed by this report.
