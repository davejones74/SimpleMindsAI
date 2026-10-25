# Acquisition Gateway — Baseline v1 Compliance Audit, Round 2

- Date: 2026-10-25
- Repository: `/home/dave/Repositories/SimpleMindsAI`
- Baseline package: `/home/dave/stage2.4.5.5.9-baseline-v1-20261024T222307Z`
- Baseline state: `DESIGN_BASELINE_CLOSED` (D1–D20 accepted; implementation was not previously verified)
- Audit type: read-only inspection plus bounded fixes, temporary stores, mocked network I/O, and subprocess tests
- External network / production / training / evaluation / promotion / commit / push: **none**

## 1. Overall verdict

**NOT COMPLIANT.**

The admission core is real and its bounded guarantees are substantially implemented: durable one-decision-per-request, atomic cap enforcement, replay/idempotency, restart durability, sealed configuration, and the frontier admission gate all work and are exercised by executable tests.

However, Baseline v1 is more than the admission core. These required protocol layers are absent:

- worker `decision_observed` / `recovery_observed` facts and delivery outcomes;
- ACK identity and `ack_required` enforcement;
- durable evidence ledgers, integrity validation, and sealing;
- reconciliation and freeze eligibility;
- attempt IDs as durable parent-linked facts;
- a single enforced cap-epoch owner across `ADMISSION_DIR` instances.

Because those layers are absent, a clean Baseline v1 freeze cannot be determined and several safety guarantees are unimplemented. The admission subset is usable, but the baseline as a whole is not compliant. A green repository test suite is not evidence of Baseline v1 compliance: most of the missing layers have no executable tests, and the design acceptance tests have not been executed in full.

## 2. Baseline and working-tree verification

The accepted package was inspected and its checksums verified:

```text
$ cd /home/dave/stage2.4.5.5.9-baseline-v1-20261024T222307Z
$ sha256sum -c SHA256SUMS.txt
baseline-v1-spec.md: OK
acceptance-tests.md: OK
finding-disposition.md: OK
open-decisions.md: OK
baseline-v1-closure-report.md: OK
evidence/independent-review.md: OK
MANIFEST.json: OK
```

`MANIFEST.json` confirms cap default 420, D1–D20 accepted, no design blockers, implementation blockers B1–B5, and `tests_executed: false` at closure. The baseline documents were not modified.

Working tree before this audit already contained uncommitted implementation work:

- modified: `package.json`, `package-lock.json`, `src/config.js`, `src/discovery/discovery-service.js`, `src/frontier.js`, `src/harness/crawler.js`, `src/server.js`;
- untracked: `src/gateway/`, `test/crawler-admission.test.js`, `test/gateway-admission.test.js`.

Those changes were preserved. This audit edited only `src/gateway/admission-store.js`, `src/gateway/acquisition-gateway.js`, and `test/gateway-admission.test.js`; it added this report. No production admission directory exists or was touched (`data/gateway` is absent).

## 3. Requirement-by-requirement compliance matrix

| # | Baseline requirement | Status | Implementation / evidence | Safety consequence |
|---|---|---|---|---|
| 1 | Request identity: immutable ID and payload digest; unique attempt IDs with parent request; retries/replays retain durable decision | **PARTIAL** | `deriveAcquisitionIdentity` (`src/gateway/acquisition-gateway.js:34`) hashes protocol, epoch, URL, generation into `request_id`; payload digest covers request parameters. `requests.request_id` is the primary key (`admission-store.js:239`); `#prepareAttempt`/`#decide` retain the first decision (`:488`, `:529`). Tests: `gateway-admission.test.js:52`, `:90`, `:118`, `:150`. **No durable `attempt_id`; `attempts` is keyed by `(request_id,payload_digest)` (`:247`) and collapses repeated attempts.** | No per-attempt audit trail, so retries cannot be distinguished from replays in evidence. Cap/idempotency itself is retained. |
| 2 | Atomic cap: default 420; at most 420 distinct admitted requests per sealed epoch; concurrent admission cannot overshoot; cap derived from durable facts | **PARTIAL** (admission core PASS; epoch ownership gap) | `#capUsed` counts durable `ADMITTED` rows (`:369`), never a mutable counter. Cap check and insert are in one `BEGIN IMMEDIATE` transaction (`:529`–`:575`). Tests: default 420 (`gateway-admission.test.js:31`), cross-process cap race (`:208`), in-process concurrency (`crawler-admission.test.js:463`). Ad hoc exact boundary: 421 subprocess admissions at cap 420, dispatched in waves of up to 100 concurrent processes, produced exactly 420 admitted + 1 `REJECTED reason=cap`, `cap_used=420`, stable after restart. | Exact cap is safe inside one store. A fresh `ADMISSION_DIR` seals an independent store with the same epoch label; two cap-1 stores admitted one request each (combined 2). The baseline does not define epoch ownership, so this was reported, not redesigned. |
| 3 | Decision durability: no response before durable decision; restart/crash recovery preserve decisions; post-commit errors cannot duplicate admission | **PASS** (decision layer) | SQLite WAL + `synchronous=FULL` (`:225`); attempt commit precedes decision commit; decision commit precedes return (`:596`–`:614`). Tests: restart (`gateway-admission.test.js:344`), pre-decision failure (`:369`, `:396`), post-commit failure then replay (`:444`). | A caller can lose the response but cannot obtain a second decision or a second cap unit. Delivery/evidence durability is separate and absent. |
| 4 | Sealed configuration: `config_sealed(cap_limit, cap_epoch, ack_required, protocol_version)`; integrity; immutable reopen; no admission before valid seal | **PARTIAL** | One-row sealed config with all four fields and SHA-256 config hash (`:231`–`:239`, `:97`). Admission requires sealed config (`:321`). Immutable reopen is checked field-by-field (`:254`); tests `gateway-admission.test.js:498`, `:537`. Tamper check ad hoc: modifying `cap_limit` without updating the hash failed with `CORRUPT_CONFIG`. **`ack_required` is stored/validated but nothing enforces ACK.** | Configuration cannot silently change, but the required ACK policy has no operational effect. |
| 5 | Frontier lifecycle: generation/admission identity persist; retries reuse generation; new generation only after terminal success; rejected/contradictory work cannot re-enter same epoch | **PARTIAL** | Frontier persists `generation`, `requestId`, `payloadDigest` (`src/frontier.js:66`, `:207`, `:375`); `markVisited` advances only when `advanceGeneration` is true (`:276`), used for 200 and 304 (`crawler.js:432`, `:449`). Rejected/quarantined states are terminal for enqueue/claim/markFailed (`frontier.js:126`, `:261`, `:299`). Tests: same-generation retry (`crawler-admission.test.js:127`), crash/recovery (`:182`), 304 rediscovery (`:238`), rejection terminal (`:298`), contradiction terminal (`:344`). | Physical refetch is possible after a crash between successful fetch and frontier advancement; cap is not double-consumed because the same generation replays the decision, but there is no durable delivery/evidence fact to prove the earlier fetch. |
| 6 | Network boundary: admission before robots/target/redirect I/O; disabled adapters/direct paths cannot bypass through enabled caller; identify legacy paths | **PARTIAL** | Crawl gate is before `tryFetch` (`crawler.js:375` vs `:421`); robots and redirects occur inside/after fetch. Server real mode constructs store + gateway and injects it into discovery (`src/server.js:119`–`:138`); CLI crawl does the same (`crawler.js:948`–`:960`). Gateway mode sets discovery adapters to `[]` and rejects injected adapters (`discovery-service.js:112`, `:143`). Tests: fetch ordering (`crawler-admission.test.js:80`), adapter/direct-path guard (`:391`). **Direct `collectDocuments`/`harvest` only throw when a gateway is supplied (`crawler.js:725`, `:881`).** | Production server learning path is guarded. `scripts/probe-crawl-sources.mjs:16` still calls `collectDocuments(..., mode:"real")` with no gateway, and direct callers/`jobs/learning.js:22` can bypass admission if no discovery service is wired. No external network was exercised. |
| 7 | Outcome, delivery, compliance, and evidence separation | **PARTIAL** | Outcome and compliance exist independently (`admission-store.js:28`, `:34`); `ADMITTED` + `VIOLATED` is supported and now survives replay (`:434`). No delivery, recovery, ACK, evidence-validity, or `NOT_ASSESSABLE` dimension exists. | A request can be admitted while delivery is unknown, but the implementation has no stored delivery fact. The separation required for freeze assessment cannot be completed. |
| 8 | Recovery and observation: durable `decision_observed` and `recovery_observed`, distinguishable from the original decision | **NOT IMPLEMENTED** | No tables, APIs, or call sites for worker observation or recovery observation. Frontier stale-claim recovery (`frontier.js:318`) is a crawler retry mechanism, not a `recovery_observed` protocol fact. | Missing response is indistinguishable from an unobserved response; no explicit recovery evidence can be reconciled. |
| 9 | ACK and reconciliation: ACK identity/facts, required ACK handling, cap/delivery reconciliation, contradiction detection, fail closed | **NOT IMPLEMENTED** | No `ack_id`, parent attempt, `ack_sent`, `ack_received`, ACK outcomes, reconciliation sets, or contradiction detection. Only `ack_required` is sealed. | A required ACK can be absent with no durable record and no freeze blocker. Recovered/observed worker sets cannot be compared with gateway sets. |
| 10 | Evidence integrity and sealing: durable required evidence, validation, sealing; missing distinct from malformed/invalid | **NOT IMPLEMENTED** | No append-only evidence ledger, `event_id`/`seq`/`prev_hash`/`payload_hash`, lifecycle (`OPEN`/`QUIESCING`/`SEALED`), validity precedence, or quarantine decision. The config hash is not an evidence ledger. | Absence, malformed evidence, and invalid evidence cannot be distinguished; no sealed evidence exists to assess. |
| 11 | Freeze eligibility: no clean freeze with missing/unsealed/invalid/contradictory ledgers or unresolved outcomes/deliveries/ACKs/recovery/cap | **NOT IMPLEMENTED** | No freeze procedure, reconciliation, or eligibility computation. | Freeze eligibility is unknown; a clean freeze cannot be claimed. |
| 12 | Acceptance tests T1–T10 mapped and executed | **PARTIAL** | See section 5. Several admission/frontier portions are executable and passed; delivery, ACK, evidence, and freeze portions are design-only. | Test names alone do not establish the missing protocol layers. |

## 4. Targeted safety checks

### 4.1 Low-level caller omitting the gateway

- The enabled production server path is guarded: `CRAWL_MODE=real` creates the gateway and passes it through `DiscoveryService.collect` → `runCrawlBatches` → `runCrawlCycle` (`src/server.js:119`, `src/jobs/supervisor.js:430`, `discovery-service.js:384`, `crawler.js:375`).
- The crawl CLI is guarded (`crawler.js:948`–`:960`).
- Discovery adapters are disabled when the gateway is enabled, and caller-supplied adapters are rejected (`discovery-service.js:112`–`:146`). Test: `crawler-admission.test.js:391`.
- **Remaining reachable alternate path:** `scripts/probe-crawl-sources.mjs:16` performs real direct fetches with no gateway. The exported `collectDocuments`/`harvest` functions remain unguarded when the caller omits `admissionGateway`, and `runLearningCycle` falls back to `collectDocuments` when no discovery service is injected (`src/jobs/learning.js:22`). This is a partial boundary, not a complete one.

### 4.2 Crash points

| Crash point | Evidence / behavior | Status |
|---|---|---|
| Before admission | No decision; retry allowed. Test `gateway-admission.test.js:369` / `:396`. | PASS |
| After admission commit, before fetch | Same generation → same request → replay; no second cap unit. Test `crawler-admission.test.js:182`. | PASS |
| During fetch | Process leaves the URL `in-progress`; stale-claim recovery defers it; the same generation retries and replays the durable decision. No direct test at the kill boundary, but the deterministic identity and recoverable claim cover it. | PARTIAL |
| After successful fetch, before frontier generation advance | The URL is recovered and refetched because the frontier has not observed terminal success. The decision replays (no second cap unit), but the first successful fetch has no durable delivery/outcome fact. No direct test. | PARTIAL |
| After decision commit, before caller receives response | Decision is durable; retry replays. Test `gateway-admission.test.js:444`. | PASS |

### 4.3 304 Not Modified

A 304 follows the same terminal-success path as a 200 and advances the generation (`crawler.js:432`–`:442`). The rediscovery test confirms a new generation and new admission for a 304 (`crawler-admission.test.js:238`).

### 4.4 Rejected/contradictory work

Rejected and quarantined frontier records cannot be re-enqueued, claimed, marked failed, or marked visited (`frontier.js:126`, `:261`, `:299`, `:322`). Tests: `crawler-admission.test.js:298`, `:344`.

### 4.5 Sealed configuration

All four required fields are present and hashed; field changes fail on reopen. Tamper detection was verified ad hoc by changing `cap_limit` in SQLite without recomputing the hash; open failed with `CORRUPT_CONFIG`. `ack_required` is not consumed by any ACK or freeze logic.

### 4.6 Fresh `ADMISSION_DIR`

Two independent directories sealed with the same `cap_epoch` and `cap_limit=1` each admitted one distinct request, producing a combined two admissions. The baseline does not define epoch ownership or a directory singleton, so this is an unresolved design/protocol gap, not fixed in this round. It can undermine an intended global cap if operators or deployments point at different admission directories.

### 4.7 Cap accounting

`cap_used` is always `SELECT COUNT(*) FROM requests WHERE decision='ADMITTED'` (`admission-store.js:369`); there is no separate increment/decrement counter. The exact 420/421 boundary and replay behavior were verified.

### 4.8 Disabled discovery adapters and direct harvesting

With a gateway, `DiscoveryService.adapters` is empty and injection of non-empty adapters throws `ADMISSION_PATH_DISABLED`. Direct `collectDocuments`/`harvest` calls throw only when the caller supplies the gateway. The production server passes it; the manual probe script does not.

### 4.9 Concurrency and restart

Actual process boundaries were exercised for cap races and simultaneous opens. The full suite and focused suites use temporary directories. No production store or external site was contacted.

## 5. T1–T10 acceptance-test mapping and execution status

Legend: **Executed (partial)** means an executable test covers part of the specified test but not its delivery/ACK/evidence/freeze expectations. **Not executed** means no implementation exists to exercise the specified outcome.

| Test | Baseline intent | Actual executable coverage | Status |
|---|---|---|---|
| T1 | Normal admission, observation, reconciliation, freeze | Admission and cap portions: `gateway-admission.test.js:31`, `crawler-admission.test.js:80`. No delivery observation, ACK, reconciliation, or freeze. | Executed (partial) |
| T2 | Replay does not double-count | Replay/idempotency and cap: `gateway-admission.test.js:52`; same generation retry: `crawler-admission.test.js:127`. No attempt A2 identity or delivery observation. | Executed (partial) |
| T3a | Missing response, optional ACK | No `decision_observed`, `recovery_observed`, delivery state, or freeze. | Not executed |
| T3b | ACK required but missing | `ack_required` is sealed but no ACK tables or handling. | Not executed |
| T4a | Post-decision payload conflict | Decision retained, `VIOLATED`, cap unchanged, durable on replay: `gateway-admission.test.js:90`, `:118`; gateway digest preservation `:150`. No delivery/freeze. | Executed (partial) |
| T4b | Pre-decision payload conflict | `CONTRADICTORY`, no admission, cap 0: `gateway-admission.test.js:174`; frontier quarantine: `crawler-admission.test.js:344`. No validity/freeze. | Executed (partial) |
| T5a | Missing worker observation | No observation/reconciliation layer. | Not executed |
| T5b | Extra worker admission | No observation/reconciliation layer. | Not executed |
| T6a | Unmatched gateway admission | No separate request-identity record / quarantine validity model. | Not executed |
| T6b | Contradictory decisions | Primary-key schema prevents duplicate decisions; no worker rejection facts or reconciliation. | Not executed |
| T6c | Conflicting duplicate event ID | No `event_id` evidence ledger. | Not executed |
| T6d | Orphan ACK | No ACK entities or parent chain. | Not executed |
| T7 | Incomplete evidence cannot prove absence | No evidence lifecycle or validity states. | Not executed |
| T8 | Sealed determinism | Admission workload determinism only: `gateway-admission.test.js:545`. No sealed-fact-set reconciliation or freeze determinism. | Executed (partial) |
| T9 | Post-seal event | No sealing lifecycle. | Not executed |
| T10 | 420 boundary, concurrency, no bypass, delivery observed, freeze eligible | **Admission core independently executed:** 421 subprocess admissions at cap 420, in waves of up to 100 concurrent processes → exactly 420 admitted, 1 cap rejection, `cap_used=420`, stable after restart. Also `gateway-admission.test.js:208`, `crawler-admission.test.js:463`. No ACK/delivery/freeze. | Executed (partial) |

The ten design acceptance tests have **not** been executed in full. No `PASS` is claimed for T1–T10 as specified.

## 6. Fixes made in this round

### Fix 1 — Durable compliance survives replay and restart

**Defect.** After a post-decision payload conflict, a later replay using the original payload returned `COMPLIANT`. The violation was recorded in `conflicts` but not derived on existing-result paths, hiding a freeze-blocking violation. The result also returned the conflicting attempt's digest as if it were the decision payload.

**Change.**

- `src/gateway/admission-store.js:434` now derives compliance from durable `conflicts` on every existing-decision result, returns the immutable decision `payload_digest`, and exposes the current attempt digest separately.
- `src/gateway/acquisition-gateway.js:131` preserves the durable decision digest and surfaces `attemptPayloadDigest`.

**Regression tests.**

- `test/gateway-admission.test.js:118` — post-decision conflict cannot be hidden by replay, and remains violated after reopen.
- `test/gateway-admission.test.js:150` — gateway preserves the decision digest and exposes the conflicting attempt digest.

### Fix 2 — Concurrent store opens no longer fail with `SQLITE_BUSY`

**Defect.** `PRAGMA journal_mode = WAL` ran before `PRAGMA busy_timeout`, so a wave of simultaneous openers could fail with `database is locked`. The exact concurrency boundary test initially failed at high process concurrency.

**Change.**

- `src/gateway/admission-store.js:225` sets `busy_timeout` first, retries lock contention while initializing pragmas/schema, and resolves a simultaneous first-seal race by re-reading the winner and accepting only an identical sealed configuration.
- `src/gateway/admission-store.js:165` classifies busy/locked errors.

**Regression test.**

- `test/gateway-admission.test.js:279` — 48 simultaneous opens of a fresh store seal once, all admit successfully, and preserve `cap_used`/epoch after reopen.

### Fix verification

```text
$ node --test test/gateway-admission.test.js
# tests 17, pass 17, fail 0, cancelled 0, skipped 0
# EXIT=0

$ node --test test/crawler-admission.test.js
# tests 9, pass 9, fail 0, cancelled 0, skipped 0
# EXIT=0

$ node --test <16 relevant crawler/discovery/frontier files>
# tests 135, pass 135, fail 0, cancelled 0, skipped 0
# EXIT=0

$ timeout 600 npm test
# tests 594, pass 587, fail 0, cancelled 0, skipped 7
# duration_ms 2594.544975
# EXIT=0
```

The 7 skips are environment-dependent tests (at least one requires a working Python compute plane with committed `v001`); no skip is counted as a pass.

### Ad hoc boundary and integrity checks

These used temporary stores under `/tmp`; the T10 helper was a temporary audit script, not committed.

```text
$ node /tmp/opencode/t10-concurrent.mjs
{ "total": 421, "admitted": 420, "rejected": 1, "distinctRequestIds": 421 }
{ "capUsed": 420 }
EXIT=0

$ node --input-type=module -e '<sequential 420 admits + 1 reject + replay + reopen>'
admitted=420 rejected=1 capUsed=420 replay=ADMITTED/replayed
afterRestartCapUsed=420 first=ADMITTED last=REJECTED

$ node --input-type=module -e '<tamper sealed_config.cap_limit without updating hash>'
{"tamperRejected":true,"code":"CORRUPT_CONFIG","message":"sealed configuration integrity check failed"}

$ node --input-type=module -e '<two independent ADMISSION_DIRs, cap 1 each, same epoch>'
{"aCap":1,"bCap":1,"combined":2}

$ node --check src/gateway/admission-store.js && ...
SYNTAX_OK
```

Environment: Node `v22.22.1`, npm `9.2.0`. `node:sqlite` emitted its ExperimentalWarning; all admission tests completed normally.

## 7. Remaining safety-critical gaps

1. **No delivery/observation layer (critical).** There is no durable `decision_observed` or `recovery_observed`; an admitted request cannot be distinguished as delivered, lost, or merely unobserved.
2. **No ACK layer (critical).** `ack_required` has no enforcement, no ACK identity/parent facts, and no unresolved/contradictory ACK outcome. A required missing ACK cannot block freeze.
3. **No evidence ledger or sealing (critical).** No append-only hash/sequence evidence, lifecycle, validity precedence, or missing-versus-invalid distinction. Evidence integrity and seal guarantees are unimplemented.
4. **No reconciliation or freeze (critical).** Gateway/worker admitted/rejected/recovered sets are never compared; freeze eligibility is not computed.
5. **No durable attempt IDs (high).** Retries/replays are collapsed by `(request_id, payload_digest)` into one attempt row. The baseline requires unique attempt IDs with parent requests.
6. **Cap-epoch ownership unresolved (critical, design gap).** A fresh `ADMISSION_DIR` creates an independent sealed store with its own cap. The accepted baseline does not define ownership; two stores can each admit up to the cap. Reported, not redesigned.
7. **Direct-fetch boundary is partial (high).** `scripts/probe-crawl-sources.mjs` and direct callers omitting a gateway can still perform real network acquisition. The production server path is guarded, but the low-level API is not fail-closed by configuration alone.
8. **Crash-after-fetch-before-advance is not directly tested (medium).** The same admission replays and cap is not duplicated, but the successful fetch is repeated and no durable delivery/outcome fact survives.
9. **Cap lifecycle has no rollover (medium, design gap).** The sealed database counts admissions for its lifetime; rediscoveries consume new requests. Once 420 admissions exist, further work is rejected permanently unless an operator provisions a new store. The baseline does not define epoch rollover.
10. **Frontier rejection is permanent across epochs (medium, design gap).** A cap-rejected URL is terminal and cannot be re-enqueued even under a future epoch, because rejection state is not epoch-scoped.

## 8. Explicit separation of verified, partial, and unimplemented work

**Verified implementation (executable evidence):**

- durable one-decision-per-request and replay idempotency;
- atomic cap enforcement inside one store, including exact 420/421 cross-process behavior;
- decision durability across restart and injected pre/post-commit failures;
- sealed config fields, hash integrity, immutable reopen, and no-admission-before-seal;
- frontier generation/request persistence, retry reuse, 304 advancement, and terminal rejection/quarantine;
- admission-before-robots/target/redirect ordering in the production crawl path;
- discovery adapter disablement and direct-path guard when the gateway is supplied.

**Partial coverage:**

- request identity (no durable attempt IDs);
- cap epoch (local cap verified, ownership unresolved);
- sealed config (`ack_required` stored but unenforced);
- frontier lifecycle (no delivery/evidence fact after fetch);
- network boundary (manual/direct callers can omit the gateway);
- outcome/compliance separation (delivery/evidence dimensions absent);
- acceptance tests T1, T2, T4a, T4b, T8, T10 (admission portions only).

**Unimplemented protocol layers:**

- worker observation and explicit recovery facts;
- ACK entities, required-ACK behavior, delivery reconciliation, contradiction detection;
- append-only evidence, integrity validation, sealing, quarantine validity;
- freeze eligibility and the clean-freeze decision.

## 9. Constraints confirmation

- No production changes, service restarts, deployment, live acquisition, external crawling, training, evaluation, or model promotion were performed.
- No external websites were contacted for this audit. Network behavior was tested with mocked fetch implementations and temporary stores.
- No data was deleted, no store was reset, and the production admission directory was not created or modified.
- The accepted baseline document and D1–D20 were not modified.
- No commit or push was made.
- Unrelated pre-existing uncommitted changes were preserved. The only files edited for fixes are the gateway implementation and its focused test file; this report was added.

**Final verdict: NOT COMPLIANT.** The admission core is a verified, bounded foundation, but Baseline v1 cannot be declared compliant until the delivery/recovery, ACK, evidence/sealing, reconciliation/freeze, and epoch-ownership guarantees are implemented or explicitly re-scoped by the accepted design.
