# Gateway Enforcement Boundary Hardening

- Date: 2026-10-25
- Repository: `/home/dave/Repositories/SimpleMindsAI`
- Scope: prevent enabled real-acquisition entry points from bypassing Baseline v1 admission
- Out of scope and untouched: ACKs, evidence ledgers, reconciliation, freeze, cap rollover, cap-epoch ownership

## 1. Confirmed bypasses

These were confirmed by inspecting the actual call paths and by regression tests.

1. **`collectDocuments()` real mode without a gateway.** The function used the global `fetch` by default and performed robots and target I/O with no admission whenever `admissionGateway` was omitted. `scripts/probe-crawl-sources.mjs` called it exactly this way.
2. **`harvest()` real mode without a gateway.** The direct branch fetched every configured URL without admission. The frontier branch also forwarded a `null` gateway into `runCrawlBatches`, so a real frontier crawl could fetch unadmitted.
3. **Learning-job fallback.** When no discovery service was injected, `runLearningCycle` fell back to `collectDocuments` with `config.crawlMode` and `config.crawlUrls`. In `CRAWL_MODE=real` this silently performed real acquisition without admission.
4. **Source-probe script.** `scripts/probe-crawl-sources.mjs` deliberately performed real acquisition but did not construct or require a gateway and did not explain the omission.
5. **Pre-existing latency/crash defect in the guarded harvest path.** `harvest`'s frontier branch referenced `createDomainRegistry` without importing it. The valid-gateway regression test exposed the crash; the import was added so the gateway-enabled CLI path can actually reach admission.

## 2. Files changed and why

| File | Change | Reason |
|---|---|---|
| `src/harness/crawler.js` | Added `requireAdmissionOrMockTransport`; real `collectDocuments`/`harvest` now require a gateway or an explicit injected transport; `collectDocuments` default `fetchImpl` is now `undefined` so the real-network case is distinguishable; imported `createDomainRegistry`. | Enforce admission at the two direct real-acquisition boundaries and make the guarded frontier path usable. |
| `scripts/probe-crawl-sources.mjs` | Documents the policy and prints a clear blocked explanation for `ADMISSION_PATH_DISABLED`. | The probe cannot safely spend the shared admission ledger on exploratory URLs; it now fails closed with an explanation. |
| `test/gateway-boundary.test.js` | New focused tests for both guards, fixture/mock preservation, the learning fallback, and the probe script. | Regression coverage for every confirmed bypass. |
| `test/crawler-admission.test.js` | Added a valid-gateway `harvest` + frontier test. | Proves the guard does not block the intended gateway path and that admission is reached before fetch. |
| `test/fetcher.test.js` | Local mocked/offline `collectDocuments` and `harvest` calls now pass `fetchImpl: fetch`. | Makes the existing offline test seam explicit under the new rule. |
| `test/language-filter.test.js` | Local mocked/offline `collectDocuments` calls now pass `fetchImpl: fetch`. | Same reason; preserves offline language-filter coverage. |
| `docs/GATEWAY-ENFORCEMENT-BOUNDARY-HARDENING.md` | This report. | Completion evidence. |

## 3. Enforced boundary and exemptions

**Enforced:**

- `collectDocuments({ mode: "real" })` requires either:
  - a valid `admissionGateway`, or
  - an explicit caller-supplied `fetchImpl` (offline/mocked transport).
- Without either, it throws `ADMISSION_PATH_DISABLED` before robots, target, or redirect I/O.
- `harvest({ mode: "real" })` follows the same rule before the direct branch and before the frontier branch claims or fetches work.
- The learning-job fallback inherits the guard because it calls `collectDocuments` without an override.
- The source-probe script inherits the guard because it supplies neither a gateway nor a transport, and now explains the block.
- `collectDocuments`/`harvest` with a gateway but no frontier remain explicitly disabled (existing behavior): direct paths are not allowed to fetch with a gateway attached.
- The existing production composition is unchanged and still valid: `src/server.js` creates the gateway in `CRAWL_MODE=real` and injects it into discovery; the crawl CLI creates it before `harvest`.

**Explicitly exempt:**

- Fixture mode (`mode: "fixture"`) needs no admission and performs no network I/O.
- An explicit `fetchImpl` is the existing offline/mock seam. Tests and local tooling may inject it; it is not used by the production server/CLI real paths.
- Low-level helpers `runCrawlCycle`, `runCrawlBatches`, `fetchDocument`, and caller-supplied discovery adapters remain unchanged. They are internal/composition seams, not the direct acquisition entry points hardened here. They still can perform network I/O if called directly, as noted in section 5.
- `DiscoveryService` constructed without a gateway in tests/dev keeps its existing adapter behavior; the production server only constructs it with a gateway in real mode.

## 4. Regression tests and exact verification

New focused tests:

```text
$ node --test test/gateway-boundary.test.js
# tests 5
# pass 5
# fail 0
# cancelled 0
# skipped 0
# EXIT=0
```

Covered:

1. `collectDocuments` real mode without gateway/transport rejects before network, with zero global-fetch calls.
2. `harvest` real mode without gateway/transport rejects before fetch and before claiming frontier work.
3. Fixture mode and an explicit mock transport still work offline; the global fetch is never called.
4. The learning-job fallback in `CRAWL_MODE=real` fails with `ADMISSION_PATH_DISABLED` and zero network calls.
5. The source-probe script exits 1 and prints the blocked admission explanation.

Valid-gateway and existing behavior:

```text
$ node --test test/crawler-admission.test.js test/gateway-boundary.test.js \
    test/fetcher.test.js test/language-filter.test.js test/crawler-wiring.test.js
# tests 47
# pass 47
# fail 0
# cancelled 0
# skipped 0
# EXIT=0
```

Manual probe evidence:

```text
$ node scripts/probe-crawl-sources.mjs https://example.test/a
ERR  https://example.test/a
      blocked: direct collectDocuments would perform real network acquisition without Baseline v1 admission. Provide an admissionGateway; an explicit fetchImpl is accepted only for offline/mocked acquisition.
      This probe cannot perform unadmitted real acquisition. Use the gateway-backed crawl/learning path instead.

1 source(s) failed
PROBE_EXIT=1
```

Full suite:

```text
$ timeout 600 npm test
# tests 600
# pass 593
# fail 0
# cancelled 0
# skipped 7
# duration_ms 2635.048279
# EXIT=0
```

The 7 skips are the same environment-dependent tests as the prior round (including tests requiring a working Python compute plane). No skipped test is counted as a pass. Syntax checks passed for the changed crawler, probe, and new test file. `git diff --check` passed.

**Repeated-run note.** One additional stress run of the full suite failed in `test/jobs-resilience.test.js` with `ENOENT: ... job-events.ndjson`, and a later stress run hung and was terminated. That file is untouched by this task, and the canonical run above plus several other runs completed cleanly (600 tests, 593 pass, 7 skip, 0 fail). The transient failures are recorded here rather than counted as passes; no failure was observed in the boundary, crawler-admission, fetcher, language-filter, or discovery tests.

## 5. Remaining bypasses / residual risk

1. **Deliberate explicit-transport exemption.** A caller that explicitly supplies `fetchImpl` (including `globalThis.fetch`) bypasses the gateway. This is intentional for offline/mock workflows, but it remains a convention-based exemption rather than an unforgeable production control. Evidence: `src/harness/crawler.js:30` returns when `fetchImpl !== undefined`.
2. **Low-level internal helpers remain unguarded.** Direct callers of `runCrawlCycle`, `runCrawlBatches`, `fetchDocument`, or a `DiscoveryService` constructed without a gateway can still perform network I/O without admission. These are not enabled production entry points; the production server and crawl CLI supply the gateway. They were left unchanged per the instruction not to require admission in every low-level helper.
3. **Composition risk outside the server.** A future production composition that builds `DiscoveryService` without a gateway, or calls a low-level helper directly, would reintroduce a bypass. There is no current call site doing this.
4. **No external verification.** No live network acquisition was performed, so the guards were verified with mocks and local offline tests only.

No ACK, evidence, reconciliation, freeze, cap-rollover, or epoch-ownership behavior was added or changed.

## 6. Constraints confirmation

- Development repository only; no production configuration or data changes.
- No service restarts, deployments, live acquisition, or external crawling.
- No training, evaluation, or model promotion.
- No commit or push.
- Pre-existing uncommitted work was preserved. This task edited only the crawler boundary, the probe script, the focused tests, and this report.
- No production admission directory or store was touched; tests used temporary/local storage and mocked or loopback HTTP only.
