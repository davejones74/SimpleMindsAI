# SimpleMindsAI — Production Readiness and 24-Hour Run Preparation

- Date: 2026-10-25
- Host: `dave-X1PRO` (X1 Pro, Ubuntu, kernel 7.0.0-38)
- Repository: `/home/dave/Repositories/SimpleMindsAI`
- Production install: `/opt/simpleminds`
- Durable state: `/var/lib/simpleminds`
- Decision: **NOT READY**
- Deployment performed: **No**

## 1. Decision

**NOT READY.**

The approved gateway changes exist in the development working tree and pass focused tests, but they are not deployed. Production is running older code than the files currently on disk, the installation contains only a stale partial copy of the gateway, the production environment file cannot be inspected without privilege, there is no durable admission database, and no privileged deployment/restart could be performed.

Additionally, a Python training child has been consuming ~100% CPU for over four days while both server jobs are paused, and the admission cap of 420 has no rollover policy. These must be resolved or explicitly accepted before a 24-hour real-world run.

The smallest next action is a privileged maintenance session (interactive `sudo` or equivalent) to:

1. add the admission directory/configuration to `/etc/simpleminds/simpleminds.env`;
2. stop the service cleanly;
3. deploy the exact candidate set below with the documented rsync procedure;
4. restore the service and verify the gateway;
5. resolve/confirm the orphan training process and the 420-cap trial policy.

## 2. What was deployed

**Nothing was deployed.** No production file, service, database, model, pointer, or configuration was modified.

The exact candidate change set is the current working tree at HEAD `48465b9dc4c558bd362484d5345d8dd857a7e3c3` plus the uncommitted changes:

| File | Candidate SHA-256 |
|---|---|
| `src/config.js` | `9b7a275b67e17a05f3c0c3cfaebc41de382a464802aa13f781038e0a085f4c30` |
| `src/server.js` | `76d7e5affcf1d8128a7fb1bc1c0c81756ab7b302158ac7c1522140e81e378123` |
| `src/frontier.js` | `98e62e4ac025cfde27600039b3919ef8397021acb358ada1fdce98633c13d08c` |
| `src/harness/crawler.js` | `c319ad1545e3d72db60d8d1888fea614627951eed29904057380755edb231544` |
| `src/discovery/discovery-service.js` | `d549347fd5a71ec983b2e29dc54657c31b381c3fc723a8bee9278aad99fee737` |
| `src/gateway/admission-store.js` | `c7841631dfc6bc0d0201cf83fe3bf985c5e183390f05cd91ff9ad1ae123154a9` |
| `src/gateway/acquisition-gateway.js` | `37bf53669372076c6b136c69b7d5c481f3e893bb308addfd2e06fc66f15d6821` |
| `scripts/probe-crawl-sources.mjs` | `b76940115a8a9e7c61612bf1f39125d533f43a8ead0fe7eeb15bd899a7ef9c23` |
| `package.json` | `f4bebcc14230fcc40a584061cdaffe3d11738d568e4973b9aea87d0e8678ec7b` |
| `package-lock.json` | `c81cc4e7dd5552e4b0cee0c595280cfb87f6fded6dd31bdb4d22beab38f92bff` |

The runtime deployment also requires the existing related test/report files only insofar as the documented rsync procedure mirrors the whole tree. No unrelated business logic was changed for this deployment.

## 3. Current production state

### 3.1 Git and working tree

- Branch: `master`
- HEAD: `48465b9dc4c558bd362484d5345d8dd857a7e3c3`
- Uncommitted tracked changes: `package.json`, `package-lock.json`, `src/config.js`, `src/discovery/discovery-service.js`, `src/frontier.js`, `src/harness/crawler.js`, `src/server.js`, `scripts/probe-crawl-sources.mjs`, `src/harness/crawler.js`, `test/fetcher.test.js`, `test/language-filter.test.js`
- Untracked approved work: `src/gateway/`, gateway tests, boundary tests, and the prior compliance reports
- No commit, push, reset, clean, or stash was performed.

### 3.2 Installed code versus repository

`/opt/simpleminds` is a copy, not a Git checkout. Current installed files are **not** the candidate working tree:

- `src/gateway/admission-store.js` exists in production but is a stale 15,507-byte partial copy (candidate is 21,308 bytes).
- `src/gateway/acquisition-gateway.js` is **missing** in production.
- `src/config.js`, `src/server.js`, `src/frontier.js`, `src/harness/crawler.js`, and `src/discovery/discovery-service.js` all differ from the candidate.
- `scripts/probe-crawl-sources.mjs` differs.
- `package.json` / `package-lock.json` still declare Node `>=20` in production; candidate declares `>=22.13`.

The running service started at **2026-10-21 00:55:33 BST**. Several installed source files have later modification times (including 2026-10-21 21:46 and 2026-10-25 03:18). Therefore the running process is older than the files on disk, and the on-disk install is a partial, non-atomic mix. A restart without a full sync is unsafe.

### 3.3 Environment and gateway configuration

`/etc/simpleminds/simpleminds.env` is `root:simpleminds`, mode `0640`, and is **not readable by the current user**. `sudo -n` requires interactive authentication, and `/proc/<server>/environ` is denied by process ownership.

Consequences:

- The actual `ADMISSION_DIR`, `ADMISSION_CAP_LIMIT`, `ADMISSION_CAP_EPOCH`, `ADMISSION_ACK_REQUIRED`, and `ADMISSION_PROTOCOL_VERSION` values cannot be verified.
- The repository deployment template does **not** define any `ADMISSION_*` variable.
- With the current config default (`data/gateway`) and systemd `WorkingDirectory=/opt/simpleminds`, an unset `ADMISSION_DIR` would place the gateway database at `/opt/simpleminds/data/gateway`, not the durable `/var/lib/simpleminds/data` tree.
- There is currently no admission database at either `/opt/simpleminds/data/gateway` or `/var/lib/simpleminds/data/gateway`.

The minimum required production configuration is therefore not confirmed, and the default location does not satisfy the stated durable-location requirement.

### 3.4 Services

| Unit | State | Evidence |
|---|---|---|
| `simpleminds.service` | **active (running)** since 2026-10-21 00:55:33 BST | PID 1310205; NRestarts=0 |
| `simpleminds-perpetual.service` | inactive (dead) since 2026-10-20 01:25:12 BST | last one-shot cycle exited 0 |
| `simpleminds-perpetual.timer` | inactive (dead) since 2026-10-18 23:38:13 BST | no next elapse |
| `simpleminds-prune.timer` | active; last prune succeeded 2026-10-25 03:27:12 GMT | retention keep=5 |

`systemctl` reports `NeedDaemonReload=yes`. Installed unit file contents match `deploy/systemd/` (diff empty), but a daemon reload is required before any unit operation. No service was restarted or reloaded in this task.

### 3.5 Service health and logs

- `http://127.0.0.1:4000/health` returns `{"ok":true,"uptime":412283,"articles":11212}`.
- `/api/stats` returns HTTP 401 because `SIMPLEMINDS_AUTH_TOKEN` is configured; no token was available or used.
- No recent gateway, SQLite, permission, or startup errors exist in the journal because the gateway is not deployed.
- The last application progress events were on 2026-10-21. Job `job-25` (learning) and `job-26` (training) have both been **paused** since 2026-10-21 20:55–20:59.
- A Python child (`sma.student`, PID 1310234) has been running since 2026-10-21 00:55, using ~99.9% CPU for over four days, with 75 threads and ~1.5 GB RSS, while its parent training job is paused. This is a credible stuck/orphan compute process and must be resolved before a 24-hour run.

### 3.6 Resources

- Disk: 1.9 TB total, 227 GB used, 1.6 TB free (13%).
- Memory: 59 GiB total, 33 GiB used, 25 GiB available.
- Swap: **8 GiB fully used, 5.3 MiB free** — a memory-pressure risk.
- CPU: 24 cores; load average ~1.0.
- Service cgroup memory: ~3.5 GiB, historical peak 8.5 GiB.
- `flm` (unrelated application) is using ~12 GB RSS; the Python training child adds ~1.5 GB and 100% of one CPU.
- Store: 11 GB; durable data: 541 MB; install: 5.9 GB.

### 3.7 Active model, registry and ledgers

- Active pointer: `version = v199`, artifact `simpleminds-62m-20261018-7404193f951c`, weight fingerprint `7404193f951c`, activated `2026-10-21T19:20:56Z`.
- `v199/COMMITTED`: parent `v176`, 28 steps completed.
- `v199/provenance.json`: trained weights, parent `v176`, tokens seen 14,336, dataset hash `a2c507df...`.
- Latest model events: `model-199` rejected; active brain remains `v199`.
- Latest run record: `run-207`; `models.ndjson` has 201 lines, `runs.ndjson` 210 lines, `evaluations.ndjson` 402 lines.
- Article store: 11,212 articles; `PENDING_REVIEW` 76, `REVIEWED` 7,061, `REJECTED` 2,693, `RETIRED` 1,381, `INGESTED` 1, `QUARANTINED` 0.
- Review ledger: 69,747 reviews; trainable 3; recoverable 77; unique consumed 7,076; total training appearances 7,160.
- Raw sources ledger: 3,010 entries; distinct source URLs 2,256.
- Frontier: 181,369 URLs total — 168,121 queued, 11,759 visited, 1,489 deferred.
- Evaluation set: `eval-002`, datasetVersion `69e276fcfb84`, 60 documents, estimated 58,776 tokens.
  - `eval-002.jsonl` SHA-256: `dd64558c03352175edc098d319ec481e501baeaf8bba24b21f570bafeeb89598`
  - `eval-002.manifest.json` SHA-256: `de180e5cba4355bd4eae8b12234a139973f613f56759cfc30bba15f3e18d1f9a`

## 4. Real acquisition entry points

The production application entry points are:

- `simpleminds.service` → `npm start` → `src/server.js` (active).
- Server-hosted learning job → `DiscoveryService.collect()` → `runCrawlBatches()` / `runCrawlCycle()` (job-25 paused).
- Server-hosted training job → training lifecycle / evaluation / promotion (job-26 paused).
- `simpleminds-perpetual.service` → `src/cli/perpetual.js` (inactive; no timer).
- Manual CLI `npm run crawl` → `src/harness/crawler.js` main (guarded in candidate).
- `scripts/probe-crawl-sources.mjs` (candidate fails closed without admission).

No duplicate acquisition worker is currently running. The server's Python training child is the only unexpected process.

## 5. Gateway verification status

**Not verified in production.** The candidate integration is present only in the repository:

- `src/server.js` constructs `AdmissionStore` + `AcquisitionGateway` when `CRAWL_MODE=real` and injects it into `DiscoveryService`.
- `src/harness/crawler.js` places admission before robots/target/redirect I/O and fails closed on direct real acquisition without a gateway or explicit mock transport.
- `scripts/probe-crawl-sources.mjs` refuses unadmitted real acquisition.
- `src/discovery/discovery-service.js` disables discovery adapters when the gateway is enabled.

Production still has the old server/config/crawler and only a stale `admission-store.js`; it cannot be running the candidate gateway.

Because no deployment or privileged restart was possible, no production smoke test was performed. No admission database was created, no cap was consumed, and no production admission decision was written.

## 6. Pre-deployment tests

Focused suite (gateway boundary, crawler admission, crawler wiring, fetcher, language filter, gateway admission, frontier, rediscovery, discovery):

```text
$ node --test test/gateway-boundary.test.js test/crawler-admission.test.js \
    test/crawler-wiring.test.js test/fetcher.test.js test/language-filter.test.js \
    test/gateway-admission.test.js test/frontier.test.js \
    test/frontier-rediscovery.test.js test/discovery.test.js
# tests 83
# pass 83
# fail 0
# cancelled 0
# skipped 0
# EXIT=0
```

Syntax and diff checks:

```text
$ node --check <changed source/test files>
SYNTAX_OK
$ git diff --check
DIFF_CHECK_EXIT=0
```

Canonical full suite, attempt 1:

```text
$ timeout 600 npm test
EXIT=124
not ok 262 - continuous learning treats the article target as a milestone, not a stop
error: ENOENT: .../job-events.ndjson
```

That failing test is in `test/jobs-resilience.test.js`, which is untouched by the gateway change. It passed when run alone (7 tests, 7 pass, exit 0). The timeout/hang did not complete the suite.

Canonical full suite, attempt 2:

```text
$ timeout 600 npm test
# tests 600
# pass 593
# fail 0
# cancelled 0
# skipped 7
# duration_ms 2473
# EXIT=0
```

The 7 skips are environment-dependent (including Python compute-plane prerequisites) and are not counted as passes. No gateway/crawler/fetcher/language test failed.

## 7. Recovery point

A non-destructive user-space recovery snapshot was created and verified:

```text
/home/dave/simpleminds-pre-gateway-deploy-20261025T184919Z/
  opt-simpleminds-code-20261025T184919Z.tar.gz
  CODE_ARCHIVE.sha256
  state/active.json
  state/eval-002.manifest.json
  state/jobs.ndjson
  state/v199-COMMITTED
  state/v199-provenance.json
  state/SHA256SUMS.txt
```

- Code archive SHA-256: `b0ac19fec2a0fdeaeddc6cf1f9f83a36461ccc45b35d5c7bdf67b4639526dd22`
- `sha256sum -c state/SHA256SUMS.txt` → all OK.
- `tar -tzf` → archive readable.

The snapshot excludes `node_modules`, `data`, `python/.venv`, `.deploy-backup`, and `.git`. It is a code rollback snapshot, not a copy of the 11 GB model store or the 541 MB mutable data tree. The deployment procedure is not intended to touch durable data.

## 8. Required deployment procedure (not executed)

The documented production procedure is in `docs/PRODUCTION.md` §15.1. The exact sequence for a privileged operator is:

```bash
# 0. Confirm the env file includes these before starting:
#    ADMISSION_DIR=/var/lib/simpleminds/data/gateway
#    ADMISSION_CAP_LIMIT=420
#    ADMISSION_CAP_EPOCH=<operator-approved epoch>
#    ADMISSION_ACK_REQUIRED=false
#    ADMISSION_PROTOCOL_VERSION=baseline-v1
#    and that /var/lib/simpleminds/data is owned simpleminds:simpleminds.

# 1. Stop acquisition/training workers without deleting data.
sudo systemctl stop simpleminds-perpetual.timer simpleminds.service

# 2. Sync the candidate tree; data/node_modules/.venv are excluded.
cd /home/dave/Repositories/SimpleMindsAI
sudo rsync -a --delete \
  --exclude '.git' --exclude 'node_modules' --exclude '.venv' --exclude 'data' \
  ./ /opt/simpleminds/
sudo chown -R simpleminds:simpleminds /opt/simpleminds

# 3. Refresh production dependencies.
cd /opt/simpleminds
sudo -u simpleminds npm ci --omit=dev

# 4. Reload units only if unit definitions changed.
sudo systemctl daemon-reload

# 5. Start one Node data plane; leave perpetual timer inactive unless that
#    worker is the explicitly chosen single acquisition worker.
sudo systemctl start simpleminds.service

# 6. Verify before any 24h run.
systemctl is-active simpleminds.service
curl -sS http://127.0.0.1:4000/health
sudo journalctl -u simpleminds -n 100 --no-pager
```

The gateway database must be created under `/var/lib/simpleminds/data/gateway`, owned by `simpleminds:simpleminds`. A fresh directory creates a fresh sealed epoch; that is an operator policy decision, not something this task may silently choose.

## 9. Rollback

The verified code snapshot can be restored with:

```bash
rm -rf /tmp/sma-rollback
mkdir -p /tmp/sma-rollback
tar -xzf /home/dave/simpleminds-pre-gateway-deploy-20261025T184919Z/opt-simpleminds-code-20261025T184919Z.tar.gz \
  -C /tmp/sma-rollback

sudo systemctl stop simpleminds-perpetual.timer simpleminds.service
sudo rsync -a --delete \
  --exclude 'node_modules' --exclude 'data' --exclude 'python/.venv' \
  --exclude '.deploy-backup' --exclude '.git' \
  /tmp/sma-rollback/ /opt/simpleminds/
sudo chown -R simpleminds:simpleminds /opt/simpleminds
cd /opt/simpleminds && sudo -u simpleminds npm ci --omit=dev
sudo systemctl daemon-reload
sudo systemctl start simpleminds.service
```

Do not delete `/var/lib/simpleminds`, the active pointer, the admission database, articles, reviews, registry, snapshots, evaluation set, or model versions during rollback. If a gateway database was created under `/var/lib/simpleminds/data/gateway`, retain it unless a separate, explicit epoch decision authorises its removal.

## 10. 24-hour trial readiness

**GO/NO-GO: NO-GO.**

Baseline that would be used before a trial (current values):

| Metric | Current value |
|---|---|
| Active brain | `v199` (`7404193f951c`), activated 2026-10-21T19:20:56Z |
| Articles | 11,212 |
| Pending review | 76 |
| Reviewed / rejected / retired | 7,061 / 2,693 / 1,381 |
| Trainable | 3 |
| Recoverable | 77 |
| Unique consumed / appearances | 7,076 / 7,160 |
| Raw sources / distinct source URLs | 3,010 / 2,256 |
| Frontier | 181,369 total: 168,121 queued, 11,759 visited, 1,489 deferred |
| Evaluation set | `eval-002`, version `69e276fcfb84`, 60 docs, JSONL SHA-256 `dd64558c...`, manifest `de180e5c...` |
| Runs / models | 210 run records / 201 model records; latest run-207 |
| Disk | 1.6 TB free (13% used) |
| Memory | 25 GiB available; swap 8 GiB full |
| Services | Node active; perpetual inactive; learning/training jobs paused |
| Gateway | Not deployed/verified; no admission DB |

Monitoring locations:

- Service: `journalctl -u simpleminds.service`.
- Acquisition/frontier: `/var/lib/simpleminds/data/frontier/` and job events in `/var/lib/simpleminds/data/registry/job-events.ndjson`.
- Review/consumption: `/var/lib/simpleminds/data/articles/reviews.ndjson`, `consumption.ndjson`, `raw-sources.ndjson`.
- Training/evaluation/promotion: `/var/lib/simpleminds/data/registry/runs.ndjson`, `run-events.ndjson`, `models.ndjson`, `model-events.ndjson`, `evaluations.ndjson`.
- Active brain: `/var/lib/simpleminds/store/active.json`.
- Admin API/portal: `127.0.0.1:4000` (auth token required; `/api/stats` is 401 without it).
- Prune: weekly `simpleminds-prune.timer`; last run succeeded, keep=5.

Trial stop/pause:

- Pause/stop server jobs through `/api/admin/jobs/:jobId/pause` or `/stop` (auth required).
- Stop the service with `sudo systemctl stop simpleminds.service`.
- The perpetual timer is currently inactive; leave it inactive unless the operator explicitly chooses it as the single worker.
- Preserve logs, ledgers, active pointer, and any admission database.

### Blockers to starting the 24-hour run

1. **No privileged deployment path in this session.** `sudo -n` requires interaction; the service, `/etc` env, and `/var/lib` cannot be changed or restarted. Smallest fix: provide an interactive privileged maintenance session or execute the documented commands.
2. **Production is a partial/stale install.** The running process predates on-disk source changes; the gateway is incomplete (no `acquisition-gateway.js`). A stopped, atomic sync is mandatory before restart.
3. **Admission configuration/location is unverified.** The env file is unreadable and the deployment template lacks `ADMISSION_DIR`. Without an explicit durable path under `/var/lib/simpleminds/data/gateway`, the default would place the DB under `/opt/simpleminds/data`.
4. **Orphan Python training process.** PID 1310234 has consumed ~100% CPU for >4 days while job-26 is paused. It must be stopped/cleared and the service restarted cleanly before measuring a 24-hour run.
5. **Swap is full.** 8 GiB swap is fully used (5 MiB free). This is a credible memory-pressure risk for a long run.
6. **Cap 420 has no rollover.** Baseline v1 permits at most 420 admitted logical requests per sealed epoch, and rediscovery creates new requests. A real 24-hour acquisition run will exhaust the cap unless the operator explicitly chooses a fresh admission epoch/store. Epoch ownership/rollover is not implemented and was not changed.
7. **Protocol gaps remain.** Attempt identity, observation/recovery facts, ACK handling, evidence-ledger sealing, reconciliation/freeze eligibility, and multi-directory epoch ownership remain outstanding. This deployment does not claim D1–D20 or T1–T10 compliance.

## 11. Limitations that are not release blockers by themselves

- Lower-level helpers (`runCrawlCycle`, `runCrawlBatches`, direct `fetchDocument`, caller-supplied discovery adapters) remain callable without a gateway in composition/test contexts. The enabled production server path injects the gateway, and the direct `collectDocuments`/`harvest` entry points now fail closed without a gateway or explicit mock transport. This known composition limitation is documented, not rewritten.
- `CRAWL_HOST_CONCURRENCY` is defined but not enforced by the current crawler; acquisition is effectively sequential per cycle with per-cycle page limits and retry/rediscovery scheduling. Do not assume strict per-host rate limiting.
- The 7 skipped tests are environment-dependent and were not run.

## 12. Actions not taken

- No production code was deployed.
- No service was stopped, started, restarted, reloaded, or reconfigured.
- No systemd unit or `/etc/simpleminds/simpleminds.env` change was made.
- No admission database was created; no admission decision or cap unit was consumed.
- No training, evaluation, promotion, or active-brain change was performed.
- No external website was probed or crawled.
- No article, review, frontier, registry, model, snapshot, evaluation, or consumption data was deleted or reset.
- No commit, push, reset, clean, or stash was performed.
- Only read-only inspection, temporary local tests, and the user-space recovery snapshot were performed.
