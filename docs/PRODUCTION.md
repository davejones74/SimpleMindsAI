# SimpleMindsAI Production Deployment (X1 Pro)

## Hosting the SimpleMindsAI data plane alongside CompanionAI

This document describes the deployment of SimpleMindsAI onto the Minisforum X1 Pro HX-370 Ubuntu
server (`dave-X1PRO`), the same host that already runs CompanionAI and FastFlowLM. It began as a
preparation document; the first deployment was executed on **2026-10-16** and the status markers
below now reflect what was measured on the host.

> **Deployed 2026-10-16.** Code at `/opt/simpleminds`, environment at
> `/etc/simpleminds/simpleminds.env`, the three systemd units enabled and active (perpetual timer
> firing every minute, cycles clean), the Python compute plane venv built with the `gfx1150` ROCm
> wheels and `sma.brain preflight` passing on ROCm `gfx1150` with native bf16 (§2.1). The Nginx
> `include` on the x1pro vhost is in place, so `/simpleminds/` is served end-to-end. Verify with
> §12; redeploy with §15.1.

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
| **Node data plane** (`src/`) | harvest → curate → score → snapshot → plan → eval → train → promote → registry | Long-running service (`npm start`) + scheduled job (`npm run perpetual`) |
| **Python compute plane** (`python/`) | random init, real training, eval, generation, checkpoint store | **Wired to the Node plane** — invoked by the real trainer by default (`TRAINER_KIND=python`); also runnable as an operator CLI |

The Node plane calls the **real Python-backed CausalLM trainer** by default
(`config.trainerKind = "python"`; the legacy stub is reachable only by explicitly setting
`TRAINER_KIND=stub`, and an unknown value is a hard error). `npm run train` and
`npm run perpetual` spawn the Python compute plane and perform real backpropagation, so the
Python plane is a **required** part of a training deployment, not an optional later step. This
document therefore deploys the Node plane and treats the Python compute plane as a prerequisite
that must be installed alongside it (§11 step 8).

> **Verified end-to-end (dev box, 2026-10-10).** On a separate Windows / RTX 3070 Ti machine, the
> full loop — real fetch → teacher curation → review → snapshot → real Python training →
> frozen-set loss gate → promotion — ran against an isolated *copy* of the store and promoted
> `v004` (frozen-set loss 11.8392 → 11.3805). The X1 Pro deployment described here remains
> `[PLANNED]`; use that result as evidence the Python plane is wired, not as a claim about this
> host.

> **The honest caveat, restated:** `npm run train` trains a real network, but on a small corpus.
> Scheduling `npm run perpetual` every minute schedules the *pipeline*; how much the student
> actually learns is a function of cohort size and cadence, which are settled by measurement
> (§14), not assumed here.

> **Managed lifecycle controls (dev-milestone note).** The Observatory now exposes
> interruptible, durable learning/training/fresh-brain jobs plus a shared model-version
> selector. These were verified on the development machine (Node + Python suites, plus a live
> server/API smoke test) and **do not change the X1 Pro deployment steps below** — the new
> variables are optional bounds (`JOBS_POLL_INTERVAL_MS`, `JOB_STOP_GRACE_MS`,
> `LEARNING_TARGET_ARTICLES`, `LEARNING_MAX_RAW_DOCS`, `TRAIN_MIN_ELIGIBLE`); defaults
> are safe. The `runJsonProcess`/`killProcessTree` cancellation path is
> exercised on Windows and designed for Ubuntu; target-hardware operation remains `[PLANNED]`
> and was not exercised for this milestone.

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
| ROCm | `[CURRENT]` ROCm 7.1.0 (`hipconfig 7.1.52801`); `rocminfo` reports GPU **`gfx1150`** (+ `gfx11-generic`) |
| Python | `[CURRENT]` `python3` 3.14.4 |
| **Node.js / npm** | **`[CURRENT]` Node.js v22.22.1 installed system-wide** |
| SimpleMindsAI checkout | `[CURRENT]` `/home/dave/Repositories/SimpleMindsAI` (developer working tree, owned by `dave`) |

Two consequences worth stating plainly:

1. **Node.js was the prerequisite, and it is now satisfied.** `node` and `npm` are installed
   system-wide (v22.22.1). The resolved `npm` path still needs recording for the unit file
   (`command -v npm`); see §11 step 1.
2. **The checkout is a developer working tree, not a deployment target.** Following the
   CompanionAI precedent, the application is installed to `/opt/simpleminds` and its mutable data
   lives in `/var/lib/simpleminds`, so a `git pull` or redeploy cannot clobber the buffer,
   registry, snapshots or brain store.

### 2.1 The ROCm arch mismatch `[VALIDATED]` — resolved

The mismatch was real, and it was a **documentation bug, not a host fault**. The host is correct:
the Radeon 890M in the Ryzen AI 9 HX 370 is **`gfx1150`** (RDNA 3.5, Strix Point). `gfx1151` is
Strix Halo (Ryzen AI Max / Radeon 8050S), a different APU. Both `rocminfo` on this host and AMD's
own GPU specification table and ROCm 7.14 PyTorch support matrix list the HX 370 / 890M as
`gfx1150`.

Investigated on 2026-10-10:

| Fact | Value |
|---|---|
| `rocminfo` GPU agent | `gfx1150` (plus `gfx11-generic`); **no `gfx1151` target present** |
| AMD spec, Ryzen AI 9 HX 370 / Radeon 890M | RDNA 3.5, **`gfx1150`** |
| Distro ROCm | 7.1.0 (`hipconfig 7.1.52801`) — the Radeon/Ryzen track |
| Kernel / driver | `7.0.0-38-generic`, in-kernel `amdgpu` |
| Host Python | 3.14.4 (cp314 wheels exist for the pin below) |
| AMD-validated pin for this APU | `torch[device-gfx1150]==2.12.0+rocm7.14.0` |

Two corrections follow, both applied to `python/requirements-rocm.txt`:

1. **The device extra was wrong.** `device-gfx1151` → `device-gfx1150`. AMD publishes
   `rocm-sdk-device-gfx1150`, and its PyTorch playbook gives the gfx1150 command verbatim for
   this exact APU. The old pin would have installed the wrong architecture's device package.
2. **The "ROCm wheel set is tied to the driver/kernel version" warning is obsolete for these
   wheels.** The AMD multi-arch wheels are self-contained — a host `torch` wheel plus
   `rocm-sdk-device-gfx1150` and the ROCm libraries from `repo.amd.com`. PyTorch therefore does
   **not** depend on the distro's ROCm 7.1.0 packages; only the in-kernel `amdgpu` driver and the
   `gfx1150` target matter. `+rocm7.14.0` names the ROCm release the wheel carries, not `apt`'s.

`[VALIDATED]` Confirmed by running on 2026-10-16: `python -m sma.brain preflight` reports
`backend=rocm`, `device=AMD Radeon 890M Graphics`, `arch=gfx1150`, native bf16 (2.94x over fp32),
a 3.52 GiB resident budget against 14.86 GiB usable, and `exitCode 0`. The pin matches AMD's
matrix for this APU. Residual community reports of gfx1150 Linux rough edges (e.g.
`hipMallocManaged`/GTT limits) remain operator-facing, not pin-blocking.

### 2.2 Ollama on the Radeon 890M `[CURRENT]`

The Radeon 890M is an integrated GPU (iGPU). Ollama does not enable iGPUs by default,
and the 890M reports an RDNA 3.5 (`gfx1150`) architecture that Ollama's ROCm backend
does not recognise as a valid discrete target. Two environment variables are required:

| Variable | Value | Purpose |
|---|---|---|
| `OLLAMA_IGPU_ENABLE` | `1` | Allow Ollama to use integrated graphics |
| `HSA_OVERRIDE_GFX_VERSION` | `11.0.2` | Spoof a compatible discrete RDNA 3 architecture |

Apply via a systemd drop-in (preserves the package-managed unit):

```bash
sudo systemctl edit ollama.service
```

```ini
[Service]
Environment="OLLAMA_IGPU_ENABLE=1"
Environment="HSA_OVERRIDE_GFX_VERSION=11.0.2"
```

```bash
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

Verify with `ollama list` (model loads without falling back to CPU) and
`journalctl -u ollama --no-pager | grep -i gpu` (confirms GPU device selection).

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
      |  NPU (XDNA2)  |       | llama3.2        |
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
- **Ollama (GPU/CPU)** is SimpleMindsAI's **teacher** — the curator, critic and planner. It
  supplies *text*, which becomes corpus; it is never merged into the student's weights, and it is
  not a chat fallback (there is none). `OllamaClient` is the single file that talks to it
  (`src/services/ollama-client.js`), and the whole pipeline can be stubbed with
  `OLLAMA_FIXTURE=true`.

Ollama remaining installed and active is a **positive dependency**, not legacy to remove. It
does not conflict with FastFlowLM: the teacher runs on the GPU/CPU, the student's compute plane
runs on ROCm, and CompanionAI's runtime runs on the NPU. Three roles, three backends.

---

## 4. Components and ports

| Component | Process | Port | Exposed? |
|---|---|---|---|
| SimpleMindsAI GraphQL + REST + admin portal | `npm start` (`src/server.js`) | `4000` (`API_PORT`) | Via Nginx `/simpleminds/` **and** `/admin/` + `/api/admin/` (see §5.2) |
| SimpleMindsAI chat UI (optional) | `npm run chat` (`src/chat/chat-server.js`) | `8787` (`CHAT_PORT`) | **Not exposed initially** `[PLANNED]` |
| SimpleMindsAI perpetual cycle | `npm run perpetual` on a timer | none | Never; file I/O only |
| Python compute plane | `python -m sma.brain …` | none | Never; subprocess/file I/O |
| Ollama teacher | `ollama.service` | `11434` | Loopback only `[CURRENT]` |
| FastFlowLM | `fastflowlm.service` | `52625` | Loopback only `[CURRENT]` |
| CompanionAI | `companionai.service` | `8080` | Via Nginx `/companionAI/` |

`[CURRENT]` Exposed by `src/server.js`: `/graphql` (Apollo), `/health`, `/api/stats`,
`POST /api/ingest`, plus the Learning Observatory portal at `/admin` (a static SPA) and its
REST/SSE API at `/api/admin`. The portal hardcodes absolute URLs, which is why those two paths are
also routed at the domain root (§5.2).

`[PLANNED]` The GraphQL port is the only SimpleMindsAI listener to expose. The chat UI is left
internal until it is reviewed; it can be added to the same snippet later.

### 4.1 Bind address `[CURRENT]`

`[CURRENT]` `src/server.js:113` calls `app.listen(config.port, config.host)`, and `config.host`
defaults to `127.0.0.1` (`API_HOST` in `src/config.js:128`), so the **API server binds loopback by
default** — matching CompanionAI's `COMPANIONAI_HOST=127.0.0.1`.

`[CURRENT]` The **chat** server is weaker: `src/chat/chat-server.js:39` calls `app.listen(port)`
with no host argument, so Node binds **all interfaces** (`0.0.0.0` / `::`). There is no
`CHAT_HOST` yet. This is acceptable only while the port is never forwarded at the Sky Hub — but it
is an SSRF-adjacent exposure if the host is ever multi-homed.

**Recommended before go-live:** add a `CHAT_HOST` (mirroring `API_HOST`) and pass it to
`app.listen` in `chat-server.js`, binding `127.0.0.1` in production. Until then, rely on the Sky
Hub not forwarding `8787` and verify with `ss -ltnp`.

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
https://x1pro.runningcode.dev/admin/              # Learning Observatory portal (see 5.2)
https://x1pro.runningcode.dev/api/admin/          # portal REST/SSE API (see 5.2)
```

The trailing slash on `proxy_pass http://127.0.0.1:4000/;` strips the `/simpleminds` prefix, so
the Node app still sees `/graphql`, `/health`, `/api/stats`.

### 5.2 The snippet `[CURRENT]`

File: `/etc/nginx/snippets/simpleminds-locations.conf` (mirrors
`deploy/nginx/simpleminds-locations.conf` in the repo)

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

# The admin portal's HTML/JS hardcode absolute URLs -- /admin/styles.css,
# /admin/app.js and fetch('/api/admin/...') -- so those must be routable at the
# domain root too, not only under the /simpleminds prefix. Same reason
# companionai-locations.conf routes /api/ and /upload/ at the root.
#
# proxy_pass here has NO trailing slash: the app is mounted at /admin and
# /api/admin, so the URI must pass through unchanged (no prefix stripping).
#
# /api/admin/ is a longer prefix than CompanionAI's /api/, so nginx's longest-
# prefix match sends it to SimpleMindsAI, not to Tomcat.

location = /admin {
    return 301 /admin/;
}

location /admin/ {
    proxy_pass http://127.0.0.1:4000;

    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_connect_timeout 5s;
}

location /api/admin/ {
    proxy_pass http://127.0.0.1:4000;

    # Live Chat is SSE (`/api/admin/events`); proxy_buffering would otherwise
    # hold every delta until the stream ends and turn it into one lump.
    proxy_buffering off;
    proxy_cache off;

    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    client_max_body_size 25m;
    proxy_read_timeout 120s;
    proxy_connect_timeout 5s;
}
```

> **Why the portal is at the domain root, not under `/simpleminds/`.** The portal SPA hardcodes
> absolute URLs — `index.html` links `/admin/styles.css` and `/admin/app.js`, and `app.js:1` sets
> `const API = "/api/admin"` (with SSE at `${API}/events`). A browser resolves those against the
> domain root, so no amount of prefix-stripping on `/simpleminds/` can make them work. Express even
> 301-redirects `/admin` → `/admin/` with a root-relative `Location`. The fix is CompanionAI's own
> solution (see `companionai-locations.conf:14-17`): route the absolute paths at the root as well.
> `/api/admin/` beats CompanionAI's `/api/` on nginx longest-prefix match, so the two do not collide.
> Consequence: the portal lives at `https://x1pro.runningcode.dev/admin/`, while GraphQL/REST stay
> under `/simpleminds/`.

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
    frontier/                         FRONTIER_DIR (URL frontier + DOMAIN registry)
    raw/                              RAW_DIR
  store/                              SMA_STORE for the Python compute plane (vNNN, _runs, active.json)

/etc/simpleminds/
  simpleminds.env                     [PLANNED] root:root 0600, systemd EnvironmentFile
```

`[CURRENT]` `src/config.js` resolves every path from an environment variable with a **relative**
`data/...` default (`BUFFER_DIR`, `REGISTRY_DIR`, `SNAPSHOT_DIR`, `EVALUATION_DIR`, `PLAN_DIR`,
`MODEL_DIR`, `FRONTIER_DIR`, `RAW_DIR`, `CHAT_DIR`). Left unset, those paths land inside the
working directory. Production must set them explicitly to absolute paths under
`/var/lib/simpleminds/data`, exactly as the CompanionAI `COMPANIONAI_DATA_DIR` precedent does.

`FRONTIER_DIR` is load-bearing for discovery: it holds the persistent URL frontier **and** the
domain registry whose eligible domains are the bootstrap roots for the next cycle. If it is left
unset, discovery state is written inside the checkout (`/opt/simpleminds/data/frontier`), so it is
not durable across redeploys and it is not where an operator would look for it.

---

## 7. Environment file `[PLANNED]`

File: `/etc/simpleminds/simpleminds.env` — `root:root`, mode `0600`, read by systemd as root
before dropping to `User=simpleminds`. Modelled on `deploy/companionai.env.example`.

```bash
# --- Servers ---------------------------------------------------------------------
API_PORT=4000
CHAT_PORT=8787
API_HOST=127.0.0.1
# (CHAT_HOST does not exist yet — chat-server.js binds all interfaces; see 4.1.)

# --- Auth (CompanionAI-style). Blank = auth OFF. Set in production. ---------------
# Generate:  openssl rand -hex 24
SIMPLEMINDS_AUTH_TOKEN=

# --- Storage (absolute; never inside the checkout) -------------------------------
BUFFER_DIR=/var/lib/simpleminds/data/buffer
REGISTRY_DIR=/var/lib/simpleminds/data/registry
SNAPSHOT_DIR=/var/lib/simpleminds/data/snapshots
EVALUATION_DIR=/var/lib/simpleminds/data/evaluation
PLAN_DIR=/var/lib/simpleminds/data/plans
MODEL_DIR=/var/lib/simpleminds/data/models
# Discovery state: URL frontier + the DOMAIN registry discovery bootstraps from.
FRONTIER_DIR=/var/lib/simpleminds/data/frontier
RAW_DIR=/var/lib/simpleminds/data/raw
GRAPHQL_URL=http://127.0.0.1:4000/graphql

# --- Teacher (Ollama). Text only; never the brain. -------------------------------
OLLAMA_ENDPOINT=http://127.0.0.1:11434
OLLAMA_MODEL=llama3.2:latest
OLLAMA_FIXTURE=false
# (No BRAIN_MODE / no teacher fallback: chat serves the student or returns 503.)

# --- Python compute plane store ---------------------------------------------------
SMA_STORE=/var/lib/simpleminds/store

# --- Evaluation baseline (the frozen promotion gate) ------------------------------
# eval-002 is the bundled, domain-stratified English Wikipedia corpus committed at
# data/evaluation/eval-002.jsonl (~60 docs, tens of thousands of tokens). It ships
# with the checkout; on first load the Node plane copies it into EVALUATION_DIR and
# freezes a manifest. The legacy eval-001 seed (5 Q/A rows, ~105 tokens) is noise-
# dominated and must not gate promotion. PROMOTE_EVAL_SEQ_LEN is pinned to
# TRAIN_SEQ_LEN so eval measures the same objective training optimises.
EVAL_DATASET_ID=eval-002
PROMOTE_EVAL_SET=/var/lib/simpleminds/data/evaluation/eval-002.jsonl
PROMOTE_EVAL_SEQ_LEN=128
PROMOTE_EVAL_MICRO_BATCH=1
PROMOTE_MIN_LOSS_DELTA=0
# Advisory only; never blocks promotion. Recommended: set EVAL_MIN_TOKENS=20000 so
# a return to a tiny evaluation set warns loudly on the run record and in the UI.
EVAL_MIN_DOCUMENTS=0
EVAL_MIN_TOKENS=20000

# --- Perpetual loop ---------------------------------------------------------------
PERPETUAL_CYCLES=1
PERPETUAL_IDLE_MS=10000

# --- Language filter (ON by default) ----------------------------------------------
# Deterministic, dependency-free English gate shared by the harvest seam and the
# ingest backstop. NOT a domain allow/deny list. A source that declares a
# non-English language (<html lang>, or a multilingual host such as
# ca.wikipedia.org) is decisive unless the body text is confidently English.
# To roll out cautiously, set SHADOW=true first and inspect the would-be
# exclusions before enforcing; thresholds are heuristic starting values, not
# calibrated accuracy guarantees.
LANGUAGE_FILTER_ENABLED=true
LANGUAGE_FILTER_SHADOW=false
LANGUAGE_FILTER_MIN_CONFIDENCE=0.8
LANGUAGE_FILTER_UNKNOWN_POLICY=allow   # allow (fail-open) | reject

# --- Crawling / discovery --------------------------------------------------------
# CRAWL_URLS is optional BOOTSTRAP input, not a required boundary. When empty the
# frontier is NOT cleared; discovery bootstraps from eligible registered domains
# (in FRONTIER_DIR) and the configured adapters.
CRAWL_MODE=real
CRAWL_URLS=
CRAWL_DISCOVERY_SEEDS=
# Built-in bootstrap FALLBACK — used ONLY when nothing else yields a root (no
# CRAWL_URLS, no CRAWL_DISCOVERY_SEEDS, empty domain registry). A brand-new host
# therefore makes its first crawl with zero configuration instead of reporting
# `no-source-configured`. After that first cycle populates the domain registry,
# the fallback is no longer used. Set to empty to disable it entirely.
CRAWL_DISCOVERY_DEFAULT_SEEDS=https://en.wikipedia.org/wiki/Steam_engine,https://en.wikipedia.org/wiki/James_Watt,https://en.wikipedia.org/wiki/Recursion,https://en.wikipedia.org/wiki/Photosynthesis
# Discovery policy — which hosts may be fetched beyond the bootstrap roots:
#   seeds-only : only bootstrap-source hosts (DEFAULT — and a trap on a fresh host,
#                because with empty CRAWL_URLS nothing is a seed, so nothing expands)
#   allowlist  : bootstrap hosts + CRAWL_ALLOWED_DOMAINS
#   open       : any host except CRAWL_DENIED_DOMAINS (use this to actually discover)
CRAWL_DISCOVERY_POLICY=open
CRAWL_DISCOVERY_ADAPTERS=sitemap,feed
CRAWL_DENIED_DOMAINS=
CRAWL_MAX_DEPTH=2
CRAWL_MAX_LINKS_PER_PAGE=50
```

> **Note (code fix):** `CRAWL_DISCOVERY_SEEDS` are now enqueued as documents
> into the frontier, not just used as adapter roots. Previously only adapter
> roots, a host configured only with discovery seeds would report
> `sources-exhausted` indefinitely.

`[CURRENT]` `SIMPLEMINDS_AUTH_TOKEN` gates the GraphQL and REST surfaces (and the `/admin/`
portal). Leave it blank to disable auth (dev/tests); set it in production so the published
`/simpleminds/` surface is not reachable by anyone who can reach the hostname. See §10.

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

`[CURRENT]` The `ExecStart` path is `/usr/bin/npm` (`command -v npm` on this host), matching the
unit file. Node.js v22.22.1 is installed system-wide (NodeSource); a user-home `nvm` install would
not work for a system service.

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
computes. Decide during testing whether to keep `llama3.2` resident
(`OLLAMA_KEEP_ALIVE=-1` or a long duration) or to lower the cadence to match model-load economics.
This is a load decision, measured in situ, not assumed here.

### 8.5 `simpleminds-prune.service` / `.timer` — disk retention `[CURRENT]`

A dedicated oneshot service plus weekly timer run the audited retention CLI
(`python -m sma.brain prune-runs --confirm`). It is a separate unit, never embedded in the
perpetual loop, and it uses the *same* implementation and audit log as the CLI — no deletion
logic in a shell script. Source: `scripts/systemd/simpleminds-prune.{service,timer}`.

```ini
# simpleminds-prune.service (abridged)
[Unit]
Description=SimpleMindsAI optimizer-state pruning
After=network-online.target simpleminds.service

[Service]
Type=oneshot
User=simpleminds
Group=simpleminds
WorkingDirectory=/opt/simpleminds
Environment=HOME=/var/lib/simpleminds
Environment=PYTHONPATH=/opt/simpleminds/python
EnvironmentFile=/etc/simpleminds/simpleminds.env
Environment=SMA_PRUNE_KEEP=5
Environment=SMA_RUN_LOCK=/var/lib/simpleminds/data/registry/RUN.lock
ExecStart=/opt/simpleminds/python/.venv/bin/python -m sma.brain prune-runs --out /var/lib/simpleminds/store --confirm
TimeoutStartSec=1800
Nice=10
IOSchedulingClass=idle
NoNewPrivileges=yes
PrivateTmp=yes
RestrictSUIDSGID=yes
LockPersonality=yes
```

- The unit runs as the least-privileged `simpleminds` account with no inference, no Ollama call
  and no restart of the perpetual application.
- `Persistent=true` on the timer gives safe catch-up; a missed run is one run, never an automatic
  over-deletion, and a live training lock (`$SMA_RUN_LOCK`) makes the service exit safely without
  deleting. The CLI also refuses if any candidate has a live `_runs/*.lock`, if the active version
  cannot be verified, or if the store/audit paths are unsafe.
- `Type=oneshot` plus systemd's single-instance rule prevents overlapping runs; the CLI adds its
  own single-writer `.prune.lock` and honours the trainer's run locks.
- Destructive mode was enabled on 2026-10-17 by adding `--confirm` to `ExecStart` only after the
  dry-run report was reviewed and a controlled confirmed run was verified. Do not add
  `Restart=always`.

Full policy, invariants, install/inspect/disable commands and recovery steps:
[PRUNING.md](PRUNING.md).

### 8.6 Disk-space monitoring `[PLANNED]`

`python -m sma.brain prune-status --out $SMA_STORE` reports filesystem capacity and used
percent, store size, eligible vs protected bytes, the last successful prune, the last
planned-but-unconfirmed run, and warn/crit thresholds (`SMA_DISK_WARN_PCT` default 80,
`SMA_DISK_CRIT_PCT` default 90). A threshold breach only raises a warning and, at most,
triggers a fresh dry run — it never bypasses retention or deletes more categories
automatically.

If the filesystem is critically low, stop unsafe operations through the documented maintenance
procedure (quiesce via systemd, run a reviewed `prune-runs --confirm` against the approved
policy) rather than improvising deletion.

---

## 9. Data-plane concurrency `[TBD]`

Two processes touch the same stores: `simpleminds.service` (`npm start`, which serves GraphQL and
the `POST /api/ingest` shunt) and `simpleminds-perpetual.service` (which curates, scores and
trains). Both open `BufferStore` and `RegistryStore` on the same directories.

- `[CURRENT]` `RegistryStore` serialises the training step with an atomic `RUN.lock`
  (`writeFileSync(..., { flag: "wx" })`). Reclamation is owner-driven: a dead owner
  (dead pid, or a legacy record with no pid/host) is reclaimed immediately regardless
  of heartbeat freshness; a live owner — or a foreign host we cannot verify — is never
  stolen, and a live-but-stale heartbeat is deferred rather than broken. The lock is
  durable and auditable: release is token-checked (a replaced owner's lock is never
  unlinked), `runLockInfo()` reports the holder (pid/host/runId/ages) without ever
  exposing the token, and the heartbeat runs at `min(RUN_LOCK_STALE_MS/3, 60s)`.
- `[CURRENT]` A held `RUN.lock` is **legitimate mutual exclusion, not a failure**. The training
  step raises a typed `RUN_LOCK_HELD` error; a *continuous* supervised job parks at
  `waiting-for-lock` and retries, while a *one-shot* run (and `npm run perpetual`) still reports
  the failure/skip honestly. So the minute-timer and an Observatory job can share the lock
  without either dying.
- `[CURRENT]` A separate `REVIEW.lock` serialises teacher review across the perpetual timer,
  supervised review jobs and `npm run review`, so two workers never score the same pending
  article concurrently. Review is bounded by `REVIEW_COOLDOWN_MS` between attempts and
  `REVIEW_MAX_ATTEMPTS` inconclusive attempts before an article is RETIRED via an auditable
  `review-retired` + `status→RETIRED` pair (history is preserved; a human `requestReview`/`--force`
  reopens it). Transient critic failures use their own `REVIEW_MAX_TECHNICAL_ATTEMPTS` allowance.
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

`[CURRENT]` **Token auth is implemented** (CompanionAI-style), off by default and enabled by
setting `SIMPLEMINDS_AUTH_TOKEN` in `/etc/simpleminds/simpleminds.env`:

- With the token unset/blank, auth is disabled (dev and the test suite are unaffected). With it
  set, every route is gated except `/health`: `GET /health` stays open so systemd/nginx probes
  never need a credential.
- A browser hitting an HTML route (`/admin/`) gets a login page (`src/auth/simple-auth.js`);
  signing in sets an `httpOnly`, `SameSite=Lax`, 7-day cookie `simpleminds_auth` whose value is
  `sha256(token)`. Non-HTML callers (GraphQL, `POST /api/ingest`) get `401` unless they send
  `Authorization: Bearer <token>`.
- The token value is never stored or logged server-side; only its SHA-256 is compared (constant
  time). The comparison **validates the bearer value** (unlike CompanionAI's prefix-only filter).
- The login/logout endpoints live at `/api/admin/auth` and `/api/admin/auth/logout` — under the
  `/api/admin/` prefix nginx already routes here, so **no nginx change is needed**.
- The internal subsystems that call `fetch(GRAPHQL_URL)` — `src/services/curator.js`,
  `src/services/planner.js`, `src/reward/reward-scorer.js` — attach `...authHeaders()` so the
  learning cycle authenticates to its own server. Without this they would 401 themselves.
- Rotating the token means editing the env var and `systemctl restart simpleminds.service`; every
  existing cookie becomes invalid (its hash no longer matches).

`[PLANNED]` Residual hardening once `/simpleminds/` is public:

- `[CURRENT]` `express.json({ limit: "25mb" })` on `POST /api/ingest` is a write path into the
  buffer; the token gate now covers it — keep the token set in production.
- `[CURRENT]` The API server binds loopback (`app.listen(config.port, config.host)`,
  `src/server.js:113`; `API_HOST` defaults to `127.0.0.1`). The **chat** server
  (`src/chat/chat-server.js:39`) still calls `app.listen(port)` with no host and therefore binds
  all interfaces — see §4.1. The public surface is only via the X1 Pro Nginx reverse proxy, and
  `4000`/`8787` are never forwarded.
- Consider per-client tokens or HTTP basic auth at Nginx if the single shared token is too coarse.
- `[CURRENT]` Chat has **no teacher fallback**: `npm run chat` serves the committed student
  (`active.json`) and returns `503` when no version is active or the worker is down. (`BRAIN_MODE`
  was removed; the README lists the absence of a fallback as a hard invariant.)

---

## 11. Deployment sequence (as-run runbook)

Executed on 2026-10-16. The ordered procedure below is retained as the install runbook and is the
basis for the redeploy cycle in §15.1. Steps 2–8 were performed as written; Step 6's `include` was
applied after the initial install (see the as-run note under Step 6).

### Step 1 — Node.js `[CURRENT]`

`[CURRENT]` Node.js **v22.22.1** is installed system-wide, satisfying `engines.node >= 20`.

```bash
node --version && command -v npm
```

Record the resolved `npm` path for the unit file (NodeSource places it at `/usr/bin/npm`).

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
ollama pull llama3.2:latest      # confirm the tag actually present with: ollama list
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

> **As-run (2026-10-16).** The snippet was placed at
> `/etc/nginx/snippets/simpleminds-locations.conf`, and the `include` was added to
> `/etc/nginx/sites-available/x1pro` (reached via the `sites-enabled/x1pro` symlink) with:
>
> ```bash
> sudo sed -i 's#\(include /etc/nginx/snippets/companionai-locations.conf;\)#\1\n    include /etc/nginx/snippets/simpleminds-locations.conf;#' /etc/nginx/sites-available/x1pro
> sudo nginx -t && sudo systemctl reload nginx
> ```
>
> The snippet and unit files are tracked in the repo under `deploy/` (`deploy/nginx/`,
> `deploy/systemd/`) and mirror what is installed on the host, so Steps 6 and 7 are reproducible
> from a fresh checkout.

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
sudo -u simpleminds .venv/bin/pip install -r requirements-rocm.txt   # gfx1150 pin already set (§2.1)
sudo -u simpleminds env SMA_STORE=/var/lib/simpleminds/store .venv/bin/python -m sma.brain init --config small
```

---

## 12. Verification checklist

### Host prerequisites

- [x] `node --version` reports v22.22.1, satisfying `engines.node >= 20`.
- [x] `command -v npm` resolves to `/usr/bin/npm`, the path used in `simpleminds.service`.
- [x] `ollama list` shows `llama3.2:latest`, the configured `OLLAMA_MODEL` tag.
- [x] `rocminfo` reports `gfx1150`, matched to the `rocm-sdk-device-gfx1150` wheel (§2.1).

### Service

- [x] `systemctl status simpleminds` is `active (running)`.
- [x] `systemctl status simpleminds-perpetual.timer` is `active (waiting)`.
- [x] `ss -ltnp` shows `4000` bound to **`127.0.0.1`** (`API_HOST` default), not `0.0.0.0`.
- [x] `journalctl -u simpleminds-perpetual -n 50` shows completed cycles, not repeated failures.

### Reverse proxy

- [x] `curl -sS http://127.0.0.1:4000/health` returns `{"ok":true,...}` locally.
- [x] `curl -sS https://x1pro.runningcode.dev/simpleminds/health` returns `{"ok":true,...}` through Nginx.
- [x] `curl -sS https://x1pro.runningcode.dev/` still returns the placeholder page.
- [x] `curl -sS -o /dev/null -w '%{http_code}\n' https://x1pro.runningcode.dev/companionAI/`
      returns `401` (auth-gated) — reachable, so CompanionAI was not broken by the second snippet.
- [x] A GraphQL query to `/simpleminds/graphql` succeeds through Nginx (verified pre-auth).
- [ ] With `SIMPLEMINDS_AUTH_TOKEN` set: `/simpleminds/graphql` returns `401` **without** a
      credential and succeeds with `Authorization: Bearer <token>`.
- [ ] `/admin/` returns the login page (HTML) unauthenticated; signing in with the token sets the
      `simpleminds_auth` cookie and loads the portal. `/api/admin/auth/logout` clears it.

### Storage and provenance

- [x] Files appear under `/var/lib/simpleminds/data/{registry,articles,...}` after a cycle.
- [x] Nothing is written under `/opt/simpleminds/data` (only an empty `frontier/` directory
      remains from the pre-env-file first run).
- [x] After a restart (07:19), buffer and registry state survives (install target is not the git tree).

### Exposure

- [ ] `curl --max-time 5 http://<PUBLIC-IP>:4000/health` times out from **off-box**.
- [ ] `curl --max-time 5 http://<PUBLIC-IP>:11434/api/tags` times out from **off-box**.
- [ ] `/simpleminds/` is access-restricted via `SIMPLEMINDS_AUTH_TOKEN` (§10); `/health` stays open.

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
| 4 | Correct ROCm wheel pin for `gfx1150` | **Resolved** — `device-gfx1150` (§2.1) |
| 5 | Does the API need authentication before `/simpleminds/` is public? | §10 |
| 6 | Bind Node to loopback? | §4.1 |
| 7 | Teacher model residency vs cadence | §8.4 |
| 8 | Path prefix vs subdomain for the GraphQL endpoint | §5.3 |
| 9 | ~~When does the Python compute plane get wired to `npm run train`?~~ **Resolved** — it is wired by default (`TRAINER_KIND=python`); the stub is opt-in only | Out of scope here |

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

### 15.1 Redeploy cycle (git pull → restart)

The install target is `/opt/simpleminds` — a **copy**, not a git working tree (§2). An update means
pulling in the developer checkout and syncing the tree across. Durable state in
`/var/lib/simpleminds` and host config in `/etc/` are never touched by this cycle.

Run from the checkout (`/home/dave/Repositories/SimpleMindsAI`):

```bash
# 1. Get the new code
cd /home/dave/Repositories/SimpleMindsAI
git pull origin master

# 2. Quiet the planes so nothing is mid-cycle while files swap
sudo systemctl stop simpleminds-perpetual.timer simpleminds.service

# 3. Sync the tree to the install target.
#    rsync (not cp) so files deleted upstream are removed too; the excludes
#    protect the venv, installed deps, and the stray runtime data dir.
sudo rsync -a --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.venv' \
  --exclude 'data' \
  ./ /opt/simpleminds/
sudo chown -R simpleminds:simpleminds /opt/simpleminds

# 4. Refresh Node dependencies (production only)
cd /opt/simpleminds
sudo -u simpleminds npm ci --omit=dev

# 4b. Python deps — ONLY if python/requirements*.txt changed
sudo -u simpleminds /opt/simpleminds/python/.venv/bin/pip install \
  -r /opt/simpleminds/python/requirements-rocm.txt

# 5. Bring the planes back up (restart drops in-flight requests; expected)
sudo systemctl start simpleminds.service
sudo systemctl start simpleminds-perpetual.timer

# 6. Verify
systemctl is-active simpleminds.service simpleminds-perpetual.timer
curl -sS http://127.0.0.1:4000/health
curl -sS https://x1pro.runningcode.dev/simpleminds/health
```

Notes:

- **A normal code update does not touch systemd or Nginx.** The units
  (`/etc/systemd/system/simpleminds*.{service,timer}`) and the snippet
  (`/etc/nginx/snippets/simpleminds-locations.conf`) are host state. Their definitions are tracked
  in the repo under `deploy/` and mirror what is installed; re-copy them only when those
  definitions change:
  ```bash
  sudo cp deploy/systemd/simpleminds.service deploy/systemd/simpleminds-perpetual.service \
         deploy/systemd/simpleminds-perpetual.timer /etc/systemd/system/
  sudo cp deploy/nginx/simpleminds-locations.conf /etc/nginx/snippets/
  sudo systemctl daemon-reload && sudo nginx -t && sudo systemctl reload nginx
  ```
- **Never overwrite `/etc/simpleminds/simpleminds.env`.** It is host state, not part of the sync
  (the `sudo -u simpleminds` run reads it via the unit's `EnvironmentFile`). Copy `.env.example`
  over it only on first install.
- **No git runs on the server.** The cycle is pull-to-checkout, then sync.
- If `git pull` reports conflicts, resolve them in the checkout first; `rsync` mirrors whatever the
  checkout contains.
- For a Python-only change, you may instead rebuild in place:
  `sudo -u simpleminds /opt/simpleminds/python/.venv/bin/pip install -r ...` then restart
  `simpleminds.service` (the perpetual unit spawns Python fresh each cycle).

---

## 16. Relationship to the CompanionAI documents

| Document | Ownership |
|---|---|
| [X1Pro-Home-Hosting-Architecture.md](../../CompanionAI/docs/X1Pro-Home-Hosting-Architecture.md) | DNS, DDNS, Nginx, TLS, security model, host tuning — **authoritative, unchanged** |
| `CompanionAI/deploy/README.md` | The pattern this deployment copies (install to `/opt`, data in `/var/lib`, environment file, snippet, units) |
| `SimpleMindsAI/README.md` | Application behaviour, invariants, proof obligations, storage model |
| **This file** | The SimpleMindsAI-specific plan layered onto all of the above |
