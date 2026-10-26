# D1 Post-Deploy Verification — Blocker Report

- Date: 2026-10-26
- Host: `dave-X1PRO`
- Status: **D1 code is installed, but the service is down; discovery proof and admission work are stopped**
- No production repair was attempted (privileged access unavailable)

## 1. Step 1 result: FAIL

D1 source hashes **do** match the authoritative checkout:

| File | Installed = Repository SHA-256 |
|---|---|
| `src/discovery/discovery-service.js` | `dfffd0b31ac4052a1867cb03afb4205b22a7906e3cbee0a49c207d0213254178` |
| `src/discovery/discovery-operations.js` | `eda68be677aaaa146b123ae3e810543e0557e4c936d485bbcd5e486aa3acff02` |
| `src/discovery/adapters/index.js` | `8a347167582b012d11fe4b8686546fc6fa1f97598b04fe052747a906796a9742` |
| `src/discovery/adapters/sitemap-adapter.js` | `030fe0a611613d510cbbcb3af53afea1b4adc8ed28dabaa8e4990932972e76ed` |
| `src/discovery/adapters/feed-adapter.js` | `6b301dca831d8b97420bac4f6aa93da900cbaa5d74d901a372d04a1c3b3fbec1` |
| `src/config.js` | `777c49face022a342e69952a3beaf43c17fe8e842cd51bed4245387ae58ea733` |

However, the service is **not healthy**:

```text
simpleminds.service: activating (auto-restart), Result: exit-code
NRestarts: 41
http://127.0.0.1:4000/health -> connection refused
```

Journal:

```text
Error: Cannot find package '/opt/simpleminds/node_modules/express/index.js'
imported from /opt/simpleminds/src/server.js
code: 'ERR_MODULE_NOT_FOUND'
```

`/opt/simpleminds/node_modules/express` is an empty directory. `npm ls --omit=dev`
reports missing/invalid/extraneous dependency errors. The discovery ledger does
not exist (`/var/lib/simpleminds/data/frontier/discovery` absent), so adapters
cannot be active and no discovery operation has been recorded.

`job-32` and `job-33` remain stopped. Article admission is still 500/500.

## 2. Root cause

The D1 source sync completed, but the production dependency installation did not
produce a usable `node_modules`. The package directory tree exists (138
top-level entries) but required package contents are missing, starting with
`express`. This is consistent with an interrupted/incomplete `npm ci` or a
node_modules replacement, not with a D1 code defect.

The deployment procedure's `npm ci --omit=dev` step must complete successfully
before the service can start. The service has been crash-looping since the
failed start.

The repeated `EBADENGINE` warnings are non-fatal: Node v22.22.1 is one patch below
the optional engine range declared by jsdom 30.1.3. The actual stop was `EACCES`
while npm tried to create `/home/simpleminds` because the manual `sudo -u
simpleminds` command did not set `HOME`. The systemd unit already uses
`HOME=/var/lib/simpleminds`. Do not upgrade Node unless the corrected install
succeeds and the service still fails at runtime for an engine-specific reason.

## 3. Exactly what is blocked

`sudo -n` still requires interactive authentication. Without privilege:

- `npm ci --omit=dev` as `simpleminds` cannot be run;
- `simpleminds.service` cannot be stopped/restarted;
- `/opt/simpleminds/node_modules` cannot be repaired;
- the production health check and discovery adapter proof cannot proceed;
- the discovery ledger cannot be created/verified in production.

Per the requested order, steps 2–4 are **not started**:
- no live discovery job;
- no admission bottleneck change;
- no rolling-window admission implementation;
- no new epoch.

## 4. Smallest safe recovery

With privileged access, restore dependencies using the established workflow:

```bash
cd /opt/simpleminds
sudo -u simpleminds env HOME=/var/lib/simpleminds npm ci --omit=dev
sudo systemctl restart simpleminds.service
systemctl is-active simpleminds.service
curl -sS http://127.0.0.1:4000/health
```

Do not start `simpleminds-perpetual.timer`. Do not resume `job-32`/`job-33`.
After the service is healthy, verify the discovery ledger and adapters before
running a bounded discovery job.

A code rollback alone will **not** fix the missing dependencies; the pre-D1
snapshot excludes `node_modules`. The dependency tree must be reinstalled or the
previous node_modules must be restored from a known-good copy.

Recovery snapshots remain available:

- `/home/dave/simpleminds-pre-d1-20261026T193940Z/` (code archive
  `44eda117c60821a5ebca66cee101546a8a3a5d5b239d03df34c0f23c3695cd33`,
  state checksums verified)
- `/home/dave/simpleminds-pre-gateway-deploy-20261025T184919Z/`

## 5. Evidence classification

**Verified:**

- D1 source hashes match.
- Service is crash-looping and health is down.
- Missing `express` is the immediate startup failure.
- `node_modules` is structurally present but invalid.
- Discovery ledger absent; adapters not proven operational.
- Jobs stopped; cap 500/500.

**Not yet verified:**

- D1 discovery adapters in a running production process.
- Real sitemap/feed requests, grants and outcomes in the production ledger.
- Service recovery after dependency repair.

No production repair, discovery job, training, evaluation, promotion, data
change, commit, or push was performed.
