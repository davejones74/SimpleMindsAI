# D1 Discovery Restoration — Implementation and Validation

- Date: 2026-10-26
- Host: `dave-X1PRO`
- Authoritative source checkout: `/home/dave/Repositories/SimpleMindsAI`
- Baseline commit: `89b5b9d73fdbd57f63fd8fa759108c5474ccf228`
- Production install: `/opt/simpleminds`
- Durable state: `/var/lib/simpleminds`
- Status: **D1 implemented and validated in source; NOT deployed because privileged access is unavailable**
- Scope: sitemap/feed discovery governance only; search remains unavailable; article admission/quota unchanged

## 1. What changed

| File | Change |
|---|---|
| `src/discovery/discovery-operations.js` (new) | Durable per-window discovery-operation ledger, global/per-domain budgets, sequential/global concurrency semaphore, grant-before-network ordering, completion/error audit records, governed `fetchText` wrapper. |
| `src/discovery/discovery-service.js` | Gateway mode now builds governed sitemap/feed adapters instead of forcing `adapters: []`; caller-supplied custom adapters remain rejected; search is filtered out in gateway mode; durable ledger/status exposed in descriptor and discovery report. |
| `src/discovery/adapters/index.js` | Binds adapter identity (`sitemap`/`feed`) into the fetch seam so each governed operation is attributable. |
| `src/discovery/adapters/sitemap-adapter.js` | Stops cleanly on `DISCOVERY_BUDGET_EXHAUSTED`, returns `budget-exhausted`, and records the condition. |
| `src/discovery/adapters/feed-adapter.js` | Same budget-exhaustion handling for root/feed fetches. |
| `src/config.js` | Adds `paths.discovery` (defaults under `FRONTIER_DIR/discovery`, override with `DISCOVERY_DIR`) and the `discoveryOperations` config block. |
| `.env.example`, `deploy/etc/x1pro.simpleminds.env` | Documents the new discovery-operation settings and their defaults. |
| `test/discovery-operations.test.js` (new) | Governor, budget, per-domain, concurrency, restart, corrupt-ledger, governed sitemap/feed integration, budget exhaustion, disabled-operations and search-unavailable tests. |
| `test/crawler-admission.test.js` | Replaces the old “gateway mode must have no adapters” assertion with governed sitemap/feed expectations; the custom-adapter rejection remains. |

The existing unrelated uncommitted changes in `src/training/lifecycle.js`,
`test/metrics.test.js`, `test/python-trainer.test.js`, and the two production
scripts are preserved untouched.

### Effective defaults

- Ledger: `FRONTIER_DIR/discovery` (override `DISCOVERY_DIR`); one append-only
  NDJSON file per rolling window.
- Window: 24 hours.
- Global discovery-operation budget: 50,000 per window.
- Per-domain budget: 1,000 per window.
- Concurrency: 1 (sequential).
- Timeout/byte/redirect limits: inherited from `CRAWL_TIMEOUT_MS`,
  `CRAWL_MAX_BYTES`, `CRAWL_MAX_REDIRECTS` and recorded in each grant.
- `DISCOVERY_OPERATIONS_ENABLED=false` disables adapters (tested rollback path).

These defaults are configuration, not article-admission policy. Article
admission remains on the existing gateway and its exhausted 500/500 epoch.

## 2. Governance behaviour

- In gateway mode, supported configured adapters are built as `sitemap` and
  `feed`; `search` is filtered out even if named in config.
- Every adapter network request goes through `createGovernedFetchText`, which:
  1. acquires a concurrency slot;
  2. checks the global and per-domain budget;
  3. appends a durable `grant` record and fsyncs it;
  4. performs the network call;
  5. appends a completion/error audit record.
- On budget exhaustion the grant fails before any network call; adapters stop
  and report `budget-exhausted`/`discovery-budget-exhausted`.
- The discovery ledger is separate from the article admission SQLite store and
  from `capUsed`; discovery grants do not consume article admission units.
- Adapter output is still candidate-only. `DiscoveryService` applies the existing
  policy, domain registry, language prior, URL safety/robots and frontier
  enqueue; article fetching still requires the existing admission gateway.
- A manually supplied custom adapter is still rejected in gateway mode because
  it could bypass the governed fetch seam.

## 3. Code-level verification

Focused discovery/gateway suite:

```text
$ node --test test/discovery-operations.test.js test/crawler-admission.test.js \
    test/discovery.test.js test/discovery-bootstrap.test.js \
    test/discovery-adapters.test.js test/discovery-language-prior.test.js \
    test/mission-queries.test.js test/gateway-boundary.test.js \
    test/fetcher.test.js test/language-filter.test.js
# tests 100
# pass 100
# fail 0
# cancelled 0
# skipped 0
# EXIT=0
```

New D1 test file alone:

```text
$ node --test test/discovery-operations.test.js
# tests 8
# pass 8
# fail 0
# skipped 0
# EXIT=0
```

Canonical suite attempt 1:

```text
$ timeout 600 npm test
# tests 641
# pass 633
# fail 1
# skipped 7
# EXIT=1
```

The single failure was the pre-existing `test/recovery-progress.test.js:57`
`getStats` expectation (`ingested` 0 vs 1), caused by a random article ID
crossing the deterministic review-sample threshold. It passes when run alone
(4/4) and is unrelated to discovery. It was not modified.

Canonical suite attempt 2:

```text
$ timeout 600 npm test
# tests 641
# pass 634
# fail 0
# cancelled 0
# skipped 7
# EXIT=0
```

`git diff --check` passed; syntax checks passed for all changed source/test files.
All tests used temporary stores/fixtures; no external website was contacted.

## 4. Deployment status

**Not deployed.** `sudo -n true` still returns
`sudo: interactive authentication is required`. The following actions remain
blocked:

- stopping/starting `simpleminds.service`;
- rsync into `/opt/simpleminds`;
- `npm ci` as `simpleminds`;
- creating/chowning the discovery ledger directory;
- editing the production environment file;
- any post-deployment restart/health verification.

No partial copy was made into `/opt/simpleminds`. The installed production
discovery files are still pre-D1:

| Production file | Installed SHA-256 |
|---|---|
| `src/discovery/discovery-service.js` | `4fc2e520ae04afef9ab47af76f862f979cc3db70beb6e633f78cdd3f9a0c3eb6` |
| `src/discovery/adapters/index.js` | `5c2a26b5cffcd771e4321e5552de52a6f3f495fb0593f00339e91c9920549cec` |
| `src/discovery/adapters/sitemap-adapter.js` | `bb6fa1467039be02fce57bdfe0aa6e255d53a43f35a8ab4e9f289e133440ca72` |
| `src/discovery/adapters/feed-adapter.js` | `6f23cbc27689227e317f33303812bbfa666d460ed9660d5a81e6d36db0f6f815` |
| `src/config.js` | `948233f927fffe22edd61e21b1c3e5ac381e97e1e462e9a17978d0ab50ffacb7` |

Current production observation remains: `adapters: []`, `providerAvailable:
false`, no `/var/lib/simpleminds/data/frontier/discovery` ledger, `job-32` and
`job-33` stopped, article admission epoch `gateway-20261026-01` at **500/500**.

The candidate source hashes are:

| Candidate file | SHA-256 |
|---|---|
| `src/config.js` | `777c49face022a342e69952a3beaf43c17fe8e842cd51bed4245387ae58ea733` |
| `src/discovery/discovery-operations.js` | `eda68be677aaaa146b123ae3e810543e0557e4c936d485bbcd5e486aa3acff02` |
| `src/discovery/discovery-service.js` | `dfffd0b31ac4052a1867cb03afb4205b22a7906e3cbee0a49c207d0213254178` |
| `src/discovery/adapters/index.js` | `8a347167582b012d11fe4b8686546fc6fa1f97598b04fe052747a906796a9742` |
| `src/discovery/adapters/sitemap-adapter.js` | `030fe0a611613d510cbbcb3af53afea1b4adc8ed28dabaa8e4990932972e76ed` |
| `src/discovery/adapters/feed-adapter.js` | `6b301dca831d8b97420bac4f6aa93da900cbaa5d74d901a372d04a1c3b3fbec1` |
| `test/discovery-operations.test.js` | `edcbf3b109d0b3a676cd9602491bd8c1c076f692e2d998dcae3c6ab51592c6b9` |
| `test/crawler-admission.test.js` | `7f6d7db268e9f08d2a6f6914bd6935887589272427e21bb3c2a2c04debd70c4d` |
| `.env.example` | `3b1115159c344359cdf0aeced082e6038ab48398c70c32c2ef2c961bbd28aecb` |
| `deploy/etc/x1pro.simpleminds.env` | `0e0e41f9775d7bc41ef65fc6a25fb6106cbe32335049aceca9dfe793b6db58ce` |

### Deployment dry-run

The corrected rsync exclusions were used
(`.git`, `node_modules`, `.venv`, `.venv_test`, caches, `data`, `.deploy-backup`).
The dry-run reported **0 deletions** and 28 expected file updates/creations,
including the D1 discovery files. No production data path was included.

A future deployment remains a stopped-service operation:

```bash
sudo systemctl stop simpleminds-perpetual.timer simpleminds.service
cd /home/dave/Repositories/SimpleMindsAI
sudo rsync -a --delete \
  --exclude '.git' --exclude 'node_modules' --exclude '.venv' \
  --exclude '.venv_test' --exclude '.pytest_cache' --exclude '__pycache__' \
  --exclude '*.pyc' --exclude 'data' --exclude '.deploy-backup' \
  ./ /opt/simpleminds/
sudo chown -R simpleminds:simpleminds /opt/simpleminds
cd /opt/simpleminds && sudo -u simpleminds env HOME=/var/lib/simpleminds npm ci --omit=dev
sudo systemctl daemon-reload
sudo systemctl start simpleminds.service
```

Do not start the perpetual timer. The article admission epoch is still
500/500; D1 does not unblock acquisition.

## 5. Recovery and rollback

Pre-D1 recovery snapshot:

```text
/home/dave/simpleminds-pre-d1-20261026T193940Z/
  opt-simpleminds-code-20261026T193940Z.tar.gz
  CODE_ARCHIVE.sha256
  state/active.json
  state/eval-002.manifest.json
  state/jobs.ndjson
  state/SHA256SUMS.txt
```

- Code archive SHA-256: `44eda117c60821a5ebca66cee101546a8a3a5d5b239d03df34c0f23c3695cd33`
- Archive readability and all state checksums verified.
- Previous broader snapshot remains at
  `/home/dave/simpleminds-pre-gateway-deploy-20261025T184919Z/`.

Rollback after a future deployment:

1. Stop `simpleminds-perpetual.timer` and `simpleminds.service`.
2. Restore the pre-D1 code archive with `rsync --delete` and the same data/venv
   exclusions; chown to `simpleminds:simpleminds`.
3. `npm ci --omit=dev` as simpleminds, daemon-reload, start `simpleminds.service`.
4. Alternatively, for a config-only rollback, set
   `DISCOVERY_OPERATIONS_ENABLED=false` and restart; the tested flag disables
   adapters and makes no network calls. Retain the discovery ledger for audit.
5. Never delete `/var/lib/simpleminds`, the article admission database, frontier,
   articles, reviews, registry, snapshots, evaluation set, or models.

## 6. Remaining blockers/limitations

1. **Privileged access unavailable** — no deployment, restart, env edit, or
   dependency install was possible.
2. **Article admission remains 500/500** — D1 intentionally does not create an
   epoch or change quota semantics; acquisition cannot resume until the operator
   resolves that separately.
3. **Production still runs pre-D1 discovery** — the current `adapters: []`
   regression remains live until deployment.
4. The discovery-operation ledger is append-only per window; retention/rotation
   of old discovery ledgers is a later retention concern, not part of D1.
5. Search remains intentionally unavailable; no provider is configured and no
   separately governed search budget exists.

## 7. Actions not taken

No production code was deployed; no service was restarted; no article admission
state, frontier, article store, model, registry, evaluation set, job, or
configuration was changed. No training, evaluation, promotion, external
acquisition, commit, or push was performed. The only writes were the D1 source
and test changes in the authoritative checkout, the documentation updates, and
the verified user-space pre-D1 recovery snapshot.
