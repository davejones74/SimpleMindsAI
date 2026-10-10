# SimpleMindsAI Production Deployment (X1 Pro)

## Planned hosting of the SimpleMindsAI data plane alongside CompanionAI

This document captures the **planned** deployment of SimpleMindsAI onto the Minisforum X1 Pro
HX-370 Ubuntu server (`dave-X1PRO`), the same host that already runs CompanionAI and FastFlowLM.
It is a preparation document, not a record of a completed deployment.

The deployment is expected to reuse the **existing** Nginx virtual host
(`x1pro.runningcode.dev`) that already serves CompanionAI, run the Node data plane with
`npm start`, and run the autonomous cycle `npm run perpetual` on a timer (provisionally **every
minute**, to be re-assessed once the loop is measured in situ).

This is a companion to
[X1Pro-Home-Hosting-Architecture.md](../../CompanionAI/docs/X1Pro-Home-Hosting-Architecture.md)
in the CompanionAI repository, which owns the shared DNS, TLS, DDNS and Nginx infrastructure.
Nothing in that document changes. SimpleMindsAI is an *additional* application behind the same
reverse proxy.

### Status legend

| Marker | Meaning |
|---|---|
| `[CURRENT]` | Already true on the X1 Pro, or read directly from the working tree / host |
| `[PLANNED]` | Decision taken, **not yet installed or verified** |
| `[VALIDATED]` | Confirmed by measurement on this hardware |
| `[TBD]` | Unknown or unmeasured. Settled during the deployment test session |

**No Node version, npm path, port, timer cadence, ROCm pin, learning rate or model tag is
assumed anywhere in this document unless it is explicitly marked.**

---

## 1. Scope

Two planes, two very different deployment stories:

| Plane | What it is | Deployment mode here |
|---|---|---|
| **Node data plane** (`src/`) | harvest → curate → score → snapshot → plan → eval → train-stub → promote → registry | Long-running service (`npm start`) + scheduled job (`npm run perpetual`) |
| **Python compute plane** (`python/`) | random init, real training, eval, generation, checkpoint store | Operator-invoked CLI for now; **not yet wired to the Node plane** |

The Python plane is out of scope for the initial scheduled deployment because the Node plane
currently calls the **stub trainer** (`src/training/trainer-interface.js::stubTrainer`), which
performs no backpropagation and never spawns Python. `npm run train` and `npm run perpetual`
exercise the lifecycle, provenance and promotion machinery only. This document therefore deploys
the Node plane and describes the Python plane as a separate, manual operator step to be wired in
later.

> **The honest caveat, repeated from the README:** `npm run train` does not train a neural
> network yet. Scheduling `npm run perpetual` every minute schedules the *pipeline*, not learning.

---

## 2. Target host and current state

Host:

```text
dave-X1PRO  (Minisforum X1 Pro HX-370, Ubuntu, AMD Ryzen AI HX 370 / 890M, XDNA2 NPU)
```

`[CURRENT]` Probed on 2026-10-10:

| Item | State |
|---|---|
| Nginx | `[CURRENT]` installed, enabled, serving `x1pro.runningcode.dev` |
| TLS certificate | `[CURRENT]` Let's Encrypt cert for `x1pro.runningcode.dev`, managed by Certbot |
| Shared vhost | `[CURRENT]` `/etc/nginx/sites-available/x1pro` (HTTPS block + Certbot HTTP→HTTPS redirect) |
| CompanionAI | `[CURRENT]` `companionai.service` enabled, listening on `127.0.0.1:8080` |
| FastFlowLM | `[CURRENT]` `fastflowlm.service` enabled, `flm v1.0.7`, loopback `127.0.0.1:52625` |
| CompanionAI Nginx snippet | `[CURRENT]` `/etc/nginx/snippets/companionai-locations.conf`, included in the x1pro vhost |
| Ollama | `[CURRENT]` `ollama` v0.40.1 installed, `active`, `http://127.0.0.1:11434` |
| DDNS timer | `[CURRENT]` `godaddy-ddns.timer` active, updates the GoDaddy A record |
| ROCm | `[CURRENT]` `rocminfo` present; reports **`gfx1150`** |
| Python | `[CURRENT]` `python3` 3.14.4 |
| **Node.js / npm** | **`[CURRENT]` ABSENT — not installed on the host** |
| SimpleMindsAI checkout | `[CURRENT]` `/home/dave/Repositories/SimpleMindsAI` (developer working tree, owned by `dave`) |

Two consequences worth stating plainly:

1. **Node.js is a prerequisite, not a detail.** Nothing in this deployment runs until
   `node` and `npm` are installed system-wide. See §14 step 1.
2. **The checkout is a developer working tree, not a deployment target.** Following the
   CompanionAI precedent, the application is installed to `/opt/simpleminds` and its mutable data
   lives in `/var/lib/simpleminds`, so a `git pull` or redeploy cannot clobber the buffer,
   registry, snapshots or brain store.

### 2.1 The ROCm arch mismatch `[TBD]`

`python/requirements-rocm.txt` pins the AMD multi-arch wheel
`torch[device-gfx1151]==2.12.0+rocm7.14.0`, but this host reports **`gfx1150`** from `rocminfo`.
That is exactly the trap the requirements file warns about: the ROCm wheel set is tied to the
driver/kernel and the gfx target, and a mismatched pin imports but can report no device or
mis-target. **Do not trust the pin as written; verify against the host's ROCm/kernel before the
Python plane is used.** The `gfx1151` pin in the requirements file is the value to change and
commit once the host's supported target is confirmed, not an assumption to deploy on.

---

## 3. Architecture

The only new ingress into the existing stack is a second `location` fragment on the same vhost.
DNS, TLS, Certbot and DDNS are untouched.

```text
                              INTERNET
                                  |
                         Public IPv4 (DDNS)
                                  |
                             Sky Hub :80/:443
                                  |
                         Nginx  x1pro.runningcode.dev
                         (TLS termination + reverse proxy)
                                  |
              +-------------------+-----------------------+
              |                   |                       |
     location /companionAI/   location /simpleminds/   location /  (placeholder)
     location /api/           (prefix stripped)
     location /upload
              |                       |
     127.0.0.1:8080           127.0.0.1:4000
              |                       |
      +-------v-------+       +-------v---------------------+
      |  CompanionAI  |       |  SimpleMindsAI Node plane   |
      |  Java/Tomcat  |       |  npm start (GraphQL + REST) |
      +-------+-------+       +-------+---------------------+
              |                       |
      loopback:52625          loopback:11434 (teacher only)
              |                       |
      +-------v-------+       +-------v---------+
      |  FastFlowLM   |       |    Ollama       |
      |  NPU (XDNA2)  |       |  deepseek-r1    |
      +---------------+       +-----------------+

  Scheduled, no ingress:
      simpleminds-perpetual.timer  ->  npm run perpetual
                       |
          writes registry + buffer files under /var/lib/simpleminds
                       |
          (future) invokes the Python ROCm compute plane, SMA_STORE=/var/lib/simpleminds/store
```

Key separation, mirroring the CompanionAI document's §21 principle: **Nginx is the only public
application entry point.** The Node GraphQL port, the chat port, Ollama's `11434` and
FastFlowLM's `52625` are never forwarded and are not public.

### The teacher is not the brain

`[CURRENT]` On this host the local LLM runtime is split by role:

- **FastFlowLM (NPU)** is CompanionAI's runtime.
- **Ollama (GPU/CPU)** is SimpleMindsAI's **teacher** — the curator, critic, planner and the
  `BRAIN_MODE=ollama` fallback. It supplies *text*, which becomes corpus; it is never merged into
  the student's weights. `OllamaClient` is the single file that talks to it
  (`src/services/ollama-client.js`), and the whole pipeline can be stubbed with
  `OLLAMA_FIXTURE=true`.

Ollama remaining installed and active is a **positive dependency**, not legacy to remove. It
does not conflict with FastFlowLM: the teacher runs on the GPU/CPU, the student's compute plane
runs on ROCm, and CompanionAI's runtime runs on the NPU. Three roles, three backends.

---

## 4. Components and ports

| Component | Process | Port | Exposed? |
|---|---|---|---|
| SimpleMindsAI GraphQL + REST | `npm start` (`src/server.js`) | `4000` (`API_PORT`) | Via Nginx `/simpleminds/` only |
| SimpleMindsAI chat UI (optional) | `npm run chat` (`src/chat/chat-server.js`) | `8787` (`CHAT_PORT`) | **Not exposed initially** `[PLANNED]` |
| SimpleMindsAI perpetual cycle | `npm run perpetual` on a timer | none | Never; file I/O only |
| Python compute plane | `python -m sma.brain …` | none | Never; subprocess/file I/O |
| Ollama teacher | `ollama.service` | `11434` | Loopback only `[CURRENT]` |
| FastFlowLM | `fastflowlm.service` | `52625` | Loopback only `[CURRENT]` |
| CompanionAI | `companionai.service` | `8080` | Via Nginx `/companionAI/` |

`[CURRENT]` Exposed by `src/server.js`: `/graphql` (Apollo), `/health`, `/api/stats`,
`POST /api/ingest`.

`[PLANNED]` The GraphQL port is the only SimpleMindsAI listener to expose. The chat UI is left
internal until it is reviewed; it can be added to the same snippet later.

### 4.1 Bind address `[TBD]`

`[CURRENT]` `src/server.js:48` calls `app.listen(port)` with no host argument, so Node binds
**all interfaces** (`0.0.0.0` / `::`). The same is true of `src/chat/chat-server.js:52`. This is
acceptable only while the port is never forwarded at the Sky Hub — but it is weaker than
CompanionAI's `127.0.0.1` bind and is an SSRF-adjacent exposure if the host is ever multi-homed.

**Recommended before go-live:** add an optional `API_HOST` (and `CHAT_HOST`) to config and bind to
`127.0.0.1` in production, matching `COMPANIONAI_HOST=127.0.0.1`. Until then, rely on the Sky Hub
not forwarding `4000` and verify with `ss -ltnp`.

---

## 5. Nginx integration

`[CURRENT]` The x1pro vhost is a single `server` block. CompanionAI is mounted as a **location
fragment**, not a second `server` block, because two `server` blocks with the same `server_name`
on the same port silently conflict. SimpleMindsAI follows the **exact same pattern**: one more
snippet, one more `include` line.

### 5.1 Prefix choice and the `/api/` collision

`[CURRENT]` CompanionAI's snippet already claims these paths at the domain root:
`/companionAI/`, `/api/`, `/upload`, `/v1/`. SimpleMindsAI also serves `/api/stats` and
`/api/ingest` — **so it must not be mounted at the root `/api/`.** It is mounted under a single
dedicated prefix instead:

```text
https://x1pro.runningcode.dev/simpleminds/graphql
https://x1pro.runningcode.dev/simpleminds/health
https://x1pro.runningcode.dev/simpleminds/api/stats
```

The trailing slash on `proxy_pass http://127.0.0.1:4000/;` strips the `/simpleminds` prefix, so
the Node app still sees `/graphql`, `/health`, `/api/stats`.

### 5.2 The snippet `[PLANNED]`

File: `/etc/nginx/snippets/simpleminds-locations.conf`

```nginx
# SimpleMindsAI locations for the existing x1pro.runningcode.dev server block.
#
#   sudo mkdir -p /etc/nginx/snippets
#   sudo cp deploy/nginx/simpleminds-locations.conf /etc/nginx/snippets/
#   # add this ONE line inside the HTTPS server { } block of sites-enabled/x1pro:
#   include /etc/nginx/snippets/simpleminds-locations.conf;
#
# A location fragment, not a server block -- same reason as companionai-locations.conf.

location = /simpleminds {
    return 301 /simpleminds/;
}

location /simpleminds/ {
    # Trailing slash strips the /simpleminds prefix before upstream.
    proxy_pass http://127.0.0.1:4000/;

    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    proxy_read_timeout 120s;
    proxy_connect_timeout 5s;

    # The /api/ingest shunts up to 25 MB JSON (express.json limit in src/server.js).
    client_max_body_size 25m;
}
```

`[PLANNED]` It is intentionally a **new snippet file**, not an edit to
`companionai-locations.conf`. Two applications, two fragments, so either can be removed without
touching the other.

### 5.3 Alternative: a dedicated subdomain

A separate hostname (`simpleminds.runningcode.dev`) with its own `server` block and certificate
would remove prefix-stripping entirely. It is **not** the chosen approach, because the requirement
is to fit into the existing configuration, and because it forces a second A record into the DDNS
strategy. The path-prefix fragment is the primary design; the subdomain is the fallback if the
GraphQL client tooling proves awkward under a path prefix.

---

## 6. Filesystem layout

The X1 Pro is a Linux deployment host, and the README's own warning applies to Node data as much
as to weights: **the checkout is not durable storage.** `data/` is gitignored and is wiped by a
re-clone or redeploy.

```text
/opt/simpleminds/                     [PLANNED] installed code (NOT a git working tree)
  src/  python/  package.json  node_modules/
  deploy/nginx/simpleminds-locations.conf
  deploy/systemd/simpleminds.service
  deploy/systemd/simpleminds-perpetual.service
  deploy/systemd/simpleminds-perpetual.timer

/var/lib/simpleminds/                 [PLANNED] durable state, owned by simpleminds:simpleminds
  data/
    buffer/                           BUFFER_DIR
    registry/                         REGISTRY_DIR (append-only ledger, RUN.lock)
    snapshots/                        SNAPSHOT_DIR
    evaluation/                       EVALUATION_DIR
    plans/                            PLAN_DIR
    models/                           MODEL_DIR
  store/                              SMA_STORE for the Python compute plane (vNNN, _runs, active.json)

/etc/simpleminds/
  simpleminds.env                     [PLANNED] root:root 0600, systemd EnvironmentFile
```

`[CURRENT]` `src/config.js` resolves every path from an environment variable with a **relative**
`data/...` default (`BUFFER_DIR`, `REGISTRY_DIR`, `SNAPSHOT_DIR`, `EVALUATION_DIR`, `PLAN_DIR`,
`MODEL_DIR`). Left unset, those paths land inside the working directory. Production must set all
six explicitly to absolute paths under `/var/lib/simpleminds/data`, exactly as the CompanionAI
`COMPANIONAI_DATA_DIR` precedent does.

---

## 7. Environment file `[PLANNED]`

File: `/etc/simpleminds/simpleminds.env` — `root:root`, mode `0600`, read by systemd as root
before dropping to `User=simpleminds`. Modelled on `deploy/companionai.env.example`.

```bash
# --- Servers ---------------------------------------------------------------------
API_PORT=4000
CHAT_PORT=8787
# Recommended once API_HOST support exists (see 4.1):
# API_HOST=127.0.0.1

# --- Storage (absolute; never inside the checkout) -------------------------------
BUFFER_DIR=/var/lib/simpleminds/data/buffer
REGISTRY_DIR=/var/lib/simpleminds/data/registry
SNAPSHOT_DIR=/var/lib/simpleminds/data/snapshots
EVALUATION_DIR=/var/lib/simpleminds/data/evaluation
PLAN_DIR=/var/lib/simpleminds/data/plans
MODEL_DIR=/var/lib/simpleminds/data/models
GRAPHQL_URL=http://127.0.0.1:4000/graphql

# --- Teacher (Ollama). Text only; never the brain. -------------------------------
OLLAMA_ENDPOINT=http://127.0.0.1:11434
OLLAMA_MODEL=deepseek-r1:latest
OLLAMA_FIXTURE=false
BRAIN_MODE=ollama

# --- Python compute plane store ---------------------------------------------------
SMA_STORE=/var/lib/simpleminds/store

# --- Perpetual loop ---------------------------------------------------------------
PERPETUAL_CYCLES=1
PERPETUAL_IDLE_MS=10000
```

`[CURRENT]` There is **no auth token in SimpleMindsAI** today. The GraphQL and REST surfaces are
unauthenticated. Once published at `/simpleminds/` they are reachable by anyone who can reach the
hostname. See §10.

---

## 8. systemd units

Three units, mirroring the CompanionAI `deploy/systemd/` pattern. Stage-1 hardening is
conservative; stage-2 directives are commented with the reason each might fail.

### 8.1 `simpleminds.service` — `npm start` `[PLANNED]`

File: `/etc/systemd/system/simpleminds.service`

```ini
[Unit]
Description=SimpleMindsAI Node data plane (GraphQL buffer + REST)
After=network-online.target ollama.service
Wants=network-online.target

[Service]
Type=simple
User=simpleminds
Group=simpleminds
WorkingDirectory=/opt/simpleminds
Environment=HOME=/var/lib/simpleminds
EnvironmentFile=/etc/simpleminds/simpleminds.env
ExecStart=/usr/bin/npm start

Restart=on-failure
RestartSec=10

# --- Stage 1: low-risk hardening ---
NoNewPrivileges=yes
PrivateTmp=yes
RestrictSUIDSGID=yes
LockPersonality=yes

# --- Stage 2: verify each before enabling ---
# ProtectSystem=strict
# ReadWritePaths=/var/lib/simpleminds
# ProtectHome=yes

[Install]
WantedBy=multi-user.target
```

`[TBD]` The `ExecStart` path depends on where Node is installed. Confirm with `command -v npm`
(NodeSource places it at `/usr/bin/npm`; nvm would place it under a user home, which a system
service cannot use — install system-wide).

### 8.2 `simpleminds-perpetual.service` — `npm run perpetual` `[PLANNED]`

A `Type=oneshot` unit driven by a timer, not a loop inside a long-running process. This is the
direct analogue of the existing `godaddy-ddns.service` / `godaddy-ddns.timer` pair.

File: `/etc/systemd/system/simpleminds-perpetual.service`

```ini
[Unit]
Description=SimpleMindsAI perpetual cycle (one shot)
After=network-online.target simpleminds.service
Wants=network-online.target

[Service]
Type=oneshot
User=simpleminds
Group=simpleminds
WorkingDirectory=/opt/simpleminds
Environment=HOME=/var/lib/simpleminds
EnvironmentFile=/etc/simpleminds/simpleminds.env
ExecStart=/usr/bin/npm run perpetual

# A run may legitimately take minutes; do not kill it mid-cycle.
TimeoutStartSec=1800

NoNewPrivileges=yes
PrivateTmp=yes
RestrictSUIDSGID=yes
LockPersonality=yes
```

### 8.3 `simpleminds-perpetual.timer` — every minute `[PLANNED]`

File: `/etc/systemd/system/simpleminds-perpetual.timer`

```ini
[Unit]
Description=Run the SimpleMindsAI perpetual cycle every minute

[Timer]
OnBootSec=5min
OnUnitActiveSec=1min
Persistent=true

[Install]
WantedBy=timers.target
```

**Why a timer and not an internal loop:** `src/cli/perpetual.js` already supports
`PERPETUAL_CYCLES=n` and exits. Driving it from systemd gives scheduled execution, journald
logging, restart-on-failure and a single-instance guarantee. A long-running `PERPETUAL_CYCLES=0`
process would duplicate all four.

**Overlap is handled by systemd, by design.** A `Type=oneshot` service cannot have two active
invocations; if a run is still going when the timer fires, systemd does not start a second copy.
The training step additionally takes the registry's `RUN.lock` (`registry-store.js`), which is a
second, independent guard. So a slow minute does not stack runs.

**The one-minute cadence is provisional.** `[PLANNED]` It is the starting value named in the
brief. The correct interval is a function of how long one cycle actually takes, how often the
crawler produces new raw docs, and how much load the teacher (Ollama) tolerates. It will be
adjusted after the deployment test session measures real cycle duration. Until then
`PERPETUAL_IDLE_MS` is irrelevant to a one-shot unit (it only paces internal retries within a
single run).

### 8.4 Teacher residency `[TBD]`

Every perpetual cycle calls the curator and critic, which call Ollama. If the teacher model is
evicted between minutes, each run pays a cold model load and the schedule wastes far more than it
computes. Decide during testing whether to keep `deepseek-r1` resident
(`OLLAMA_KEEP_ALIVE=-1` or a long duration) or to lower the cadence to match model-load economics.
This is a load decision, measured in situ, not assumed here.

---

## 9. Data-plane concurrency `[TBD]`

Two processes touch the same stores: `simpleminds.service` (`npm start`, which serves GraphQL and
the `POST /api/ingest` shunt) and `simpleminds-perpetual.service` (which curates, scores and
trains). Both open `BufferStore` and `RegistryStore` on the same directories.

- `[CURRENT]` `RegistryStore` serialises the training step with an atomic `RUN.lock`
  (`openSync(..., 'wx')`), with a 10-minute stale break.
- `[CURRENT]` `BufferStore` is append-only NDJSON. Concurrent append from a serving request and a
  perpetual run is the thing to verify, not assume, under load.

`[TBD]` Exercise concurrent `/api/ingest` while a perpetual run is mid-cycle and confirm no
corruption. If it fails, the mitigations in preference order are: route ingestion through GraphQL
only, reduce the timer cadence, or give the perpetual unit a `Conflicts=`/`ExecStartPre` gate.

---

## 10. Security model

`[CURRENT]` Network exposure is unchanged from the CompanionAI document §18: only `22`, `80` and
`443` are forwarded from the Sky Hub. **No SimpleMindsAI, Ollama or FastFlowLM port is ever
forwarded.** SimpleMindsAI adds no new inbound port.

`[PLANNED]` Requirements once `/simpleminds/` is public:

- The GraphQL/API surface is **unauthenticated** today. Publishing it exposes `POST /api/ingest`
  and `/graphql` mutations to anyone who can reach the hostname. **Either do not expose
  `/simpleminds/` publicly until auth exists, or restrict it** (HTTP basic auth at Nginx,
  `allow`/`deny`, or an auth filter in the app). This is the single most important security gap in
  the current plan.
- `[CURRENT]` `express.json({ limit: "25mb" })` on `POST /api/ingest` is a write path into the
  buffer; it must not be left open unauthenticated.
- `[CURRENT]` Both Node listeners bind all interfaces (§4.1). Bind loopback or firewall the host
  so `4000` and `8787` are not reachable from the LAN.
- `[CURRENT]` `BRAIN_MODE=ollama` keeps the DeepSeek fallback, which the README lists as a known
  defect to remove once the trained model serves chat. It is acceptable for the data-plane phase
  but must be tracked.

---

## 11. Deployment sequence (planned runbook)

Nothing below has been executed. This is the ordered procedure for the test session.

### Step 1 — Node.js `[PLANNED]`

```bash
# Node >=20 (package.json engines). Install system-wide, e.g. NodeSource:
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version && command -v npm
```

Record the installed version and the resolved `npm` path for the unit file.

### Step 2 — service account and directories `[PLANNED]`

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin simpleminds
sudo mkdir -p /opt/simpleminds /var/lib/simpleminds /etc/simpleminds
sudo chown -R simpleminds:simpleminds /var/lib/simpleminds
```

Note the CompanionAI lesson: `--no-create-home` still records `/home/simpleminds` in passwd, so
the unit must set `Environment=HOME=/var/lib/simpleminds` (it does), or a component resolving
`$HOME` fails against a non-existent path.

### Step 3 — install the application `[PLANNED]`

Install to `/opt/simpleminds` and **not** run from the git working tree, so a redeploy cannot
overwrite `/var/lib/simpleminds`.

```bash
sudo cp -r /home/dave/Repositories/SimpleMindsAI/. /opt/simpleminds/
sudo rm -rf /opt/simpleminds/.git /opt/simpleminds/node_modules
sudo chown -R simpleminds:simpleminds /opt/simpleminds
cd /opt/simpleminds && sudo -u simpleminds npm ci --omit=dev
```

### Step 4 — environment file `[PLANNED]`

```bash
sudo install -o root -g root -m 0600 /opt/simpleminds/.env.example /etc/simpleminds/simpleminds.env
sudoedit /etc/simpleminds/simpleminds.env      # set the absolute paths from §7
```

### Step 5 — teacher model `[PLANNED]`

```bash
ollama pull deepseek-r1:latest      # confirm the tag actually present with: ollama list
sudo systemctl status ollama --no-pager
```

### Step 6 — Nginx `[PLANNED]`

```bash
sudo cp /opt/simpleminds/deploy/nginx/simpleminds-locations.conf /etc/nginx/snippets/
sudoedit /etc/nginx/sites-enabled/x1pro        # add the include line inside the HTTPS server{}
#   include /etc/nginx/snippets/simpleminds-locations.conf;
sudo nginx -t && sudo systemctl reload nginx
# verify the CompanionAI and placeholder paths still answer (§12)
```

### Step 7 — units and timer `[PLANNED]`

```bash
sudo cp /opt/simpleminds/deploy/systemd/simpleminds*.service /etc/systemd/system/
sudo cp /opt/simpleminds/deploy/systemd/simpleminds-perpetual.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now simpleminds.service
sudo systemctl enable --now simpleminds-perpetual.timer
```

### Step 8 — Python compute plane (separate, manual) `[PLANNED]`

Not wired to the Node plane; documented for the record.

```bash
cd /opt/simpleminds/python
sudo -u simpleminds python3 -m venv .venv
sudo -u simpleminds .venv/bin/pip install -r requirements-rocm.txt   # after fixing the gfx pin (§2.1)
sudo -u simpleminds env SMA_STORE=/var/lib/simpleminds/store .venv/bin/python -m sma.brain init --config small
```

---

## 12. Verification checklist

### Host prerequisites

- [ ] `node --version` reports a version satisfying `engines.node >= 20`.
- [ ] `command -v npm` resolves to the path used in `simpleminds.service`.
- [ ] `ollama list` shows the configured `OLLAMA_MODEL` tag.
- [ ] `rocminfo` gfx target recorded and matched to the ROCm wheel before any Python run.

### Service

- [ ] `systemctl status simpleminds` is `active (running)`.
- [ ] `systemctl status simpleminds-perpetual.timer` is `active (waiting)`.
- [ ] `ss -ltnp` shows `4000` (and confirm whether it is `127.0.0.1` or `0.0.0.0`).
- [ ] `journalctl -u simpleminds-perpetual -n 50` shows completed cycles, not repeated failures.

### Reverse proxy

- [ ] `curl -sS http://127.0.0.1:4000/health` returns `{"ok":true,...}` locally.
- [ ] `curl -sS https://x1pro.runningcode.dev/simpleminds/health` returns the same through Nginx.
- [ ] `curl -sS https://x1pro.runningcode.dev/` still returns the placeholder page — proving the
      new `include` merged rather than displaced anything.
- [ ] `curl -sS -o /dev/null -w '%{http_code}\n' https://x1pro.runningcode.dev/companionAI/`
      still succeeds — proving CompanionAI was not broken by the second snippet.
- [ ] A GraphQL query to `/simpleminds/graphql` succeeds.

### Storage and provenance

- [ ] Files appear under `/var/lib/simpleminds/data/{buffer,registry,snapshots,...}` after a cycle.
- [ ] Nothing is written under `/opt/simpleminds/data`.
- [ ] After a restart, buffer and registry state survives (install target is not the git tree).

### Exposure

- [ ] `curl --max-time 5 http://<PUBLIC-IP>:4000/health` times out from **off-box**.
- [ ] `curl --max-time 5 http://<PUBLIC-IP>:11434/api/tags` times out from **off-box**.
- [ ] `/simpleminds/` is either not public or is access-restricted (§10).

---

## 13. Rollback

Removing the units, the timer and the snippet leaves the CompanionAI stack untouched. The data
directory is deliberately **not** touched.

```bash
sudo systemctl disable --now simpleminds-perpetual.timer
sudo systemctl disable --now simpleminds.service
sudo rm /etc/systemd/system/simpleminds.service
sudo rm /etc/systemd/system/simpleminds-perpetual.service
sudo rm /etc/systemd/system/simpleminds-perpetual.timer
sudo rm /etc/nginx/snippets/simpleminds-locations.conf
sudoedit /etc/nginx/sites-enabled/x1pro        # remove the include line
sudo systemctl daemon-reload
sudo nginx -t && sudo systemctl reload nginx
```

`/var/lib/simpleminds` and `/etc/simpleminds` are retained on purpose.

---

## 14. Open questions to settle in the test session

| # | Question | Owner decision |
|---|---|---|
| 1 | Actual wall-clock duration of one `npm run perpetual` cycle | Sets the timer cadence (§8.3) |
| 2 | Does a timer cadence of one minute ever overlap a running cycle? | systemd single-instance + `RUN.lock`; measure anyway |
| 3 | Is concurrent `/api/ingest` safe against a running cycle? | §9 |
| 4 | Correct ROCm wheel pin for `gfx1150` | §2.1 |
| 5 | Does the API need authentication before `/simpleminds/` is public? | §10 |
| 6 | Bind Node to loopback? | §4.1 |
| 7 | Teacher model residency vs cadence | §8.4 |
| 8 | Path prefix vs subdomain for the GraphQL endpoint | §5.3 |
| 9 | When does the Python compute plane get wired to `npm run train`? | Out of scope here |

---

## 15. Operational commands

```bash
# Node data plane
sudo systemctl status simpleminds --no-pager
sudo journalctl -u simpleminds -n 50 --no-pager

# Scheduled cycle
sudo systemctl status simpleminds-perpetual.timer --no-pager
systemctl list-timers simpleminds-perpetual.timer
sudo systemctl start simpleminds-perpetual.service         # run one cycle now
sudo journalctl -u simpleminds-perpetual -n 100 --no-pager

# Nginx
sudo nginx -t && sudo systemctl reload nginx
curl -sS https://x1pro.runningcode.dev/simpleminds/health

# Teacher
systemctl status ollama --no-pager
ollama list
ss -ltnp | grep -E '4000|8787|11434|52625'
```

---

## 16. Relationship to the CompanionAI documents

| Document | Ownership |
|---|---|
| [X1Pro-Home-Hosting-Architecture.md](../../CompanionAI/docs/X1Pro-Home-Hosting-Architecture.md) | DNS, DDNS, Nginx, TLS, security model, host tuning — **authoritative, unchanged** |
| `CompanionAI/deploy/README.md` | The pattern this deployment copies (install to `/opt`, data in `/var/lib`, environment file, snippet, units) |
| `SimpleMindsAI/README.md` | Application behaviour, invariants, proof obligations, storage model |
| **This file** | The SimpleMindsAI-specific plan layered onto all of the above |
