# SimpleMindsAI — Privileged Deployment Result

- Date: 2026-10-25
- Host: `dave-X1PRO`
- Repository: `/home/dave/Repositories/SimpleMindsAI`
- Production install: `/opt/simpleminds`
- Durable state: `/var/lib/simpleminds`
- Environment: `/etc/simpleminds/simpleminds.env`
- **Final decision: NOT READY — deployment blocked by unavailable privileged access.**
- Deployment performed: **No**

## 1. Decision and blocking condition

The candidate working tree has been revalidated and its tests pass, but the deployment could not be performed.

`sudo -n true` still returns `sudo: interactive authentication is required`. No approved privileged maintenance session or passwordless equivalent is available to this process. The following actions are therefore blocked:

- reading or editing `/etc/simpleminds/simpleminds.env`;
- creating/chowning `/var/lib/simpleminds/data/gateway`;
- stopping or starting `simpleminds.service` or any systemd unit;
- stopping the orphan `sma.student` process;
- running `rsync` into `/opt/simpleminds`;
- running `npm ci` as `simpleminds`;
- `systemctl daemon-reload`;
- any post-deployment restart, health verification or rollback test.

No workaround was attempted, no permissions were altered, and no secrets were printed.

## 2. Revalidated starting state

- Branch: `master`
- HEAD: `48465b9dc4c558bd362484d5345d8dd857a7e3c3`
- Working tree unchanged since the readiness report: candidate files still match the recorded hashes.
- `simpleminds.service`: active, running since 2026-10-21 00:55:33 BST.
- `simpleminds-perpetual.service`: inactive.
- `simpleminds-perpetual.timer`: inactive.
- `simpleminds-prune.timer`: active.
- Local health: `{"ok":true,"uptime":414240,"articles":11212}`.
- Active brain: `v199`, fingerprint `7404193f951c`, artifact `simpleminds-62m-20261018-7404193f951c`.
- Evaluation: `eval-002`, JSONL SHA-256 `dd64558c03352175edc098d319ec481e501baeaf8bba24b21f570bafeeb89598`, manifest SHA-256 `de180e5cba4355bd4eae8b12234a139973f613f56759cfc30bba15f3e18d1f9a`.
- No admission database exists under `/opt/simpleminds/data` or `/var/lib/simpleminds/data`.
- Orphan `sma.student` PID 1310234 is still running under the Node server: 4d 19h elapsed, ~99.9% CPU, 75 threads, ~1.5 GB RSS.
- Swap remains fully allocated: 8.0 GiB used, 5.3 MiB free.

## 3. Candidate revision and hashes

Candidate is the uncommitted working tree at HEAD `48465b9`, with no commit/push/reset/clean/stash.

| File | SHA-256 |
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

## 4. Final pre-deployment tests

Focused gateway/acquisition suite:

```text
$ node --test test/gateway-boundary.test.js test/crawler-admission.test.js \
    test/crawler-wiring.test.js test/fetcher.test.js test/language-filter.test.js \
    test/gateway-admission.test.js test/frontier.test.js \
    test/frontier-rediscovery.test.js test/discovery.test.js
# tests 83
# pass 83
# fail 0
# skipped 0
# EXIT=0
```

Checks:

```text
$ git diff --check
DIFF_CHECK_EXIT=0
$ node --check <changed source/test files>
SYNTAX_OK
```

Canonical full suite, attempt 1:

```text
$ timeout 600 npm test
EXIT=124
```

No test reported `not ok`; the suite hung after test 258 and did not complete. This is the same intermittent, unrelated suite-level hang observed previously.

Canonical full suite, attempt 2:

```text
$ timeout 600 npm test
# tests 600
# pass 593
# fail 0
# cancelled 0
# skipped 7
# duration_ms 2506.826819
# EXIT=0
```

The 7 skips are environment-dependent and are not counted as passes. No gateway, acquisition-boundary, crawler, fetcher or language test failed.

## 5. Deployment-plan review

The documented `rsync --delete` command was dry-run reviewed. As written it has two problems:

1. It would delete `/opt/simpleminds/.deploy-backup` because that directory is not excluded.
2. It would copy the development-only `python/.venv_test` tree and caches into production because only `.venv` is excluded.

Corrected dry-run command:

```bash
rsync -a --delete --dry-run --itemize-changes \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.venv' \
  --exclude '.venv_test' \
  --exclude '.pytest_cache' \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  --exclude 'data' \
  --exclude '.deploy-backup' \
  ./ /opt/simpleminds/
```

Result of the corrected dry-run:

- **0 deletion operations**
- 112 expected file updates/creations
- Includes `src/gateway/acquisition-gateway.js`, the updated gateway store, server/config/crawler/discovery/frontier integration, and the probe script.
- Excludes `/opt/simpleminds/data`, `node_modules`, `python/.venv`, and `.deploy-backup`.

This corrected command is the one to use; the documented procedure should be amended before execution.

## 6. Admission configuration status

**Not configured. No admission database exists and no epoch has been sealed.**

Required production values (not applied):

```text
ADMISSION_DIR=/var/lib/simpleminds/data/gateway
ADMISSION_CAP_LIMIT=420
ADMISSION_CAP_EPOCH=gateway-20261025-01
ADMISSION_ACK_REQUIRED=false
ADMISSION_PROTOCOL_VERSION=baseline-v1
```

`gateway-20261025-01` is the proposed explicit epoch identifier for this deployment. It has not been written anywhere or approved in the host environment; the operator must confirm it or supply another explicit identifier. No rollover or automatic new epoch was implemented or proposed.

The gateway directory must be created under `/var/lib/simpleminds/data/gateway`, owned `simpleminds:simpleminds`, with service-account read/write access. The application install path must not contain the gateway database.

The existing production environment file could not be inspected, so a pre-existing conflicting epoch/database cannot be ruled out. No database was created or overwritten.

## 7. Orphan training process

- PID: 1310234
- Parent: `node src/server.js` PID 1310222
- Command: `/opt/simpleminds/python/.venv/bin/python -m sma.student --out /var/lib/simpleminds/store --device auto`
- Age: 4d 19h
- State: sleeping, 75 threads, ~1.5 GB RSS, ~99.9% CPU
- Related jobs: `job-25` learning paused and `job-26` training paused; no active intended training workload is running.

The process is very likely an abandoned training child, but it cannot be safely terminated without privileged access or the server's authenticated job/service control. It remains running. CPU, memory and swap did not recover. This is an unresolved blocker to the 24-hour run.

## 8. Recovery and rollback

Recovery snapshot re-verified:

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
- `tar -tzf` succeeded.
- All `state/SHA256SUMS.txt` entries verified `OK`.

The snapshot covers code rollback and small state manifests; it is not a copy of the 11 GB model store or the 541 MB mutable data tree. Deployment must preserve `/var/lib/simpleminds` and any admission database.

Rollback procedure after a future deployment:

```bash
rm -rf /tmp/sma-rollback && mkdir -p /tmp/sma-rollback
tar -xzf /home/dave/simpleminds-pre-gateway-deploy-20261025T184919Z/opt-simpleminds-code-20261025T184919Z.tar.gz -C /tmp/sma-rollback
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

Do not remove `/var/lib/simpleminds`, the active model, articles, reviews, registry, snapshots, evaluation set, or any admission database during rollback.

## 9. Post-deployment verification

**Not performed.** No files, services, environment, gateway state, dependency installation or processes were changed. No production smoke test was possible.

## 10. Before/after production preservation

| Item | Before | After |
|---|---|---|
| Active brain | `v199` / `7404193f951c` | unchanged (no deployment) |
| Articles | 11,212 | unchanged |
| Pending review | 76 | unchanged |
| Trainable | 3 | unchanged |
| Unique consumed | 7,076 | unchanged |
| Evaluation set | `eval-002` / `dd64558c...` / `de180e5c...` | unchanged |
| Admission DB | absent | still absent |
| Services | Node active; perpetual inactive | unchanged |
| Orphan Python | PID 1310234 running | still running |
| Swap | 8 GiB full | unchanged |

No production data was modified or deleted.

## 11. Remaining limitations and blockers

1. **No privileged access** — deployment, env changes, service control, gateway directory creation, dependency install and orphan cleanup remain blocked.
2. **Orphan training process** — still consuming ~100% CPU; must be stopped safely under privilege before any 24-hour run.
3. **Swap fully exhausted** — resource pressure remains.
4. **Admission policy not applied** — directory, cap, epoch, ack and protocol values are still only proposed; no sealed config exists.
5. **Production partial/stale install** — running code predates on-disk files and the gateway is incomplete. A stopped, atomic corrected-rsync deployment is mandatory.
6. **Cap 420 has no rollover** — the first trial must respect one explicit epoch and stop/pause if exhausted; no automatic reset exists.
7. **Protocol gaps remain** — attempt identity, observation/recovery, ACK, evidence sealing, reconciliation/freeze and multi-directory epoch ownership are still outstanding. This report does not claim D1–D20 or T1–T10 compliance.
8. **Corrected rsync exclusions required** — the documented command would delete `.deploy-backup` and copy `.venv_test`; use the corrected dry-run-reviewed command.

## 12. Actions not taken

- No production code was deployed.
- No service was stopped, started, restarted or reloaded.
- No systemd unit or environment-file change was made.
- No admission directory or database was created; no cap unit was consumed.
- No training, evaluation, promotion or active-brain change was performed.
- No 24-hour acquisition/training run was started.
- No external site was probed or crawled.
- No production data was deleted or reset.
- No commit, push, reset, clean or stash was performed.
- No secrets were printed or exposed.
