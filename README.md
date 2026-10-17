# SimpleMindsAI

A perpetually self-improving text model, **trained from random initialization** and grown
continuously over years of operation. No pretrained neural weights are ever loaded into the
student. The model starts as noise and becomes a language model by consuming articles it
collects itself.

SimpleMindsAI is split into two planes that share a store, not a process:

- **Node data plane** (this repository's `src/`) — harvest, curate, review, plan, registry,
  provenance. It owns the corpus and the ledger. It never touches a GPU.
- **Python compute plane** (`python/`) — random init, tokenization/packing, optimization,
  checkpointing, evaluation, generation. It owns the accelerator. It never writes the Node
  registry.

The teacher is an **Ollama-served LLM** (configurable via `OLLAMA_MODEL`; both DeepSeek and Gemma
variants have been run) and is a **researcher and reviewer only**. It is never the brain, and it
is never a fallback for the brain.

---

## Status

Phase 1 is **complete at 62M**: the full lifecycle — random initialization, atomic commit,
the no-pretrained-weights proof, provenance, real optimization with resumable state,
evaluation, version comparison, and generation — is implemented and tested. Chat is now
served by the long-lived Python student worker, and promotion is gated by causal-LM loss on a
frozen evaluation set.

Verified on the development machine (Windows, RTX 4090 24,564 MiB, CUDA capability 8.9,
63.7 GB RAM, Python 3.14.6, Node ≥20, torch 2.14.0+cu130, transformers 5.17.0):

| | |
|---|---|
| Node data plane | 221 `node:test` tests — all pass (see [Testing](#testing)) |
| Python compute plane | 194/194 pytest tests pass |
| Checkpoint `v001` | committed, 62M params, provenance recorded |
| Checkpoint `v002` | committed, 60 real steps, 74/74 params moved, 2 buffers unchanged |

**An honest caveat.** `v002` was trained for 60 steps on a 4 KB fixture (7 blocks, 5 train).
Train loss fell 11.83 → 7.72 while validation moved 11.82 → 11.54 — that gap is memorization
of five blocks, not learning. Check 5 passing means *the optimizer, precision model, guards,
provenance and resume path work*; it does not mean the model knows English. See
[Proof obligations and the Phase 1 gate](docs/PROOF.md#what-v002-does-and-does-not-prove) for
the full reading. `npm run train` runs the real Python-backed CausalLM trainer by
default; the legacy stub is only reachable by explicitly setting `TRAINER_KIND=stub`.

### End-to-end verification (2026-10-10, isolated)

A bounded, **real** end-to-end run was executed against a *copy* of the store, on a separate dev
box (Windows, RTX 3070 Ti 8 GB, Python 3.14.7, torch 2.14.0+cu130 — a different machine from the
RTX 4090 in the table above):

| Stage | Result |
|---|---|
| Acquisition | **100 unique** fetched articles (English Wikipedia featured articles; real, robots-aware fetch), 108 attempts / 108 successes, 0 fetch failures |
| Curation | teacher `llama3.2:latest`; 102 curated articles, each keeping its source URL + fetched-content hash |
| Review | 10 reviewed, 10 approved (teacher critic in the loop; policy unchanged) |
| Training | real Python CausalLM; `v004` built from `v003`, 10 articles, 60 steps |
| Evaluation | frozen-set loss **11.8392 → 11.3805** (Δ 0.4587) → **promoted** |
| Isolation | original dev store **byte-identical** (SHA-256 manifest); `v004` committed only in the trial store |

**The same honest caveat applies, at a smaller scale.** ~10 training articles and a five-row
evaluation set make this evidence that the *pipeline and the loss gate are wired to real data* —
not that the model has learned English. Larger cohorts are Phase 2+.

---

## The one invariant that cannot bend

**The student is randomly initialized and never receives pretrained neural weights.**

Everything else in this repository is negotiable. This is not. Only three things are permitted,
because they are encodings rather than learned knowledge: `config.json` (architecture
hyperparameters — shapes, not values), the tokenizer (an encoding mechanism), and a teacher
LLM's **text output** (corpus data, never merged into weights outside ordinary training).

The proof is deliberately over-determined. See
[Proof obligations](docs/PROOF.md#proof-obligations) and the
[twelve Phase 1 checks](docs/PROOF.md#the-12-checks-phase-1-gate).

---

## What SimpleMindsAI is

The student is a **raw causal language model**: it learns by predicting the next token in
continuous text, not by fitting scored `{prompt, completion}` pairs. That choice drives most of
the design (see [Architecture](docs/ARCHITECTURE.md)).

**Implemented and tested**

- Randomly initialized 62M student; atomic, append-only, hash-verified checkpoints.
- The six proof obligations and the twelve Phase 1 checks (`docs/PROOF.md`).
- Real, resumable training with fp32 master weights, guards and instrumentation.
- `init`, `train`, `eval`, `generate`, `diff`, `export`, `verify-export`, `active`, `preflight`.
- A long-lived student chat worker with **no teacher fallback** (returns `503`, never answers
  as the student).
- A causal-LM loss promotion gate on a frozen, leak-guarded evaluation set.
- A Node data plane: harvest, curate, review, plan, an append-only registry, and the
  dependency-free admin portal (Learning Observatory).

**Planned or not yet implemented**

- **3B training** (Phase 2) — checks 1–12 repeated at 3B scale, gated by an empirical memory
  preflight. The 62M model is the only trained model today.
- **Continuous/perpetual learning** (Phase 3), including experience replay. A single bounded
  lifecycle is verified end-to-end (above); *unbounded* multi-cycle autonomous operation is not.
- S3 sharding of 3B weight assets, and the remaining known defects listed in the
  [roadmap](docs/ROADMAP.md#known-defects).

---

## Quickstart

### Prerequisites

- **Node.js ≥ 20** for the data plane.
- **Python 3.14** with a virtual environment for the compute plane.
- Exactly one torch backend: NVIDIA CUDA or AMD ROCm (torch is intentionally not in the common
  requirements).
- Ollama with a teacher model, or `OLLAMA_FIXTURE=true` for a deterministic stub
  (see the fixture caveat under [Node data plane](#node-data-plane)).

### Node data plane

```bash
npm install
npm test

npm start
# $env:OLLAMA_FIXTURE="true"; $env:OLLAMA_MODEL="deepseek-r1:8b"; npm run crawl
$env:OLLAMA_FIXTURE="true"; $env:OLLAMA_MODEL="llama3.2:latest"; npm run crawl
npm run curate
npm run plan
npm run init:brain
npm run train
npm run chat
```

`npm run train` is the training **step**, not the whole loop: it snapshot-plans a
curated dataset, runs the real Python-backed CausalLM trainer on it, and drives
the causal-LM loss gate. It does **not** discover or review articles, and it fails
fast with `train failed: dataset empty after snapshot guards (no reviewed,
unconsumed articles)` when the article store holds no reviewed-and-unconsumed
material — the snapshot collects only `REVIEWED` articles that have not already
been consumed (`src/dataset/snapshot.js`). The legacy stub trainer is reachable
only via `TRAINER_KIND=stub`.

The **autonomous workflow** and the **individual step** are different commands:

- `npm run perpetual` is the full server-free loop: discover → curate → **review** →
  snapshot → plan → baseline-eval → train → candidate-eval → promote/reject,
  then repeat. Review requires the teacher critic (real Ollama) or a human
  decision.
- `npm run train` is just the training step. Run it on its own once reviewed,
  unconsumed articles exist — produced by the critic, or by a human review in the
  admin portal at `http://localhost:4000/admin`.

Server-free one-shot CLI runners are also available: `npm run evaluate`, `npm run
promote`, `npm run reject`, `npm run perpetual`, and `npm run review`. The last
one drains the review backlog in bounded pages without starting the server
(honouring cooldowns and attempt caps by default). `npm run review -- --force=<id>`
requests a fresh human re-review of a specific article — reopening a retired
article and bypassing its cooldown — the same override the Observatory exposes
via `POST /articles/:id/request-review`. The drain is also exposed as
`POST /review/start` (`POST /review/stop` to halt it). See
[Development](docs/DEVELOPMENT.md).

**Fixture caveat.** `OLLAMA_FIXTURE=true` stubs the curator and most Ollama round
trips. The critic fixture now detects the critic prompt and returns a real scored
reply (raw `6.5`, verdict `approve`), so fixture-mode `npm run perpetual` reaches
the training stage; use a real Ollama critic or a human decision for a real
review. (An earlier defect scored every fixture article `uncertain` at a
fabricated `5/10`; see [Phase 7 report](docs/PHASE7_REPORT.md#defects-found-and-fixed).)

`npm run chat` does not fall back to a teacher: it starts the Python student worker, loads the
`COMMITTED` version named by `$SMA_STORE/active.json`, and returns `503` if no version is active
or the worker is down.

### Observing a second store (workspaces)

The Observatory (`/admin`) is bound to ONE live, writable store: the store the
server booted with — the **development** workspace (`$SMA_STORE` / `~/.sma/store`
plus the cwd ledgers). It can also *display* other stores **read-only** by
allow-listing them; the browser selects one by id and can never supply a path.

```powershell
# Plain `npm start` auto-loads ./workspaces.json from the working directory.
# Override explicitly with SMA_WORKSPACES (inline JSON) or SMA_WORKSPACES_FILE (path).
npm start
```

A working example is committed at [`workspaces.example.json`](workspaces.example.json)
(a completed 100-article trial exposed read-only as `trial-100`, active `v004`, next to
development `v003`). Copy it to `workspaces.json` — git-ignored, because the paths are
machine-specific). Plain `npm start` from that directory then picks it up automatically.

Each entry is `{ id, label?, kind?, pythonStore, articles, registry,
governance?, snapshots?, models?, evaluation?, raw? }`. Any workspace that is
not `kind: "development"` is **inspection-only**: its stores are opened
read-only (no directory is created, no append stream opened) and every mutating
endpoint returns `403` with a clear reason. The selected workspace's identity
and active version are shown in a banner, so a completed trial (e.g. v004) can
be inspected alongside development (v003) with no risk of mutating it.
`GET /api/admin/workspaces` lists what is available; a configured-but-missing
store is reported `available:false` (its endpoints return `503`), never
fabricated.

### Driving the lifecycle from the Observatory

The **Learning & Training** tab drives the same lifecycle as `npm run perpetual`/`npm run train`
as durable, observable jobs, backed by a single `JobSupervisor` bound to the live
development store:

- **Learning** — bounded (one pass, reports source exhaustion honestly) or continuous
  (polls for new material at `JOBS_POLL_INTERVAL_MS`, default 60000).
- **Training** — one-shot (refuses below the eligible gate) or continuous (waits for
  eligible reviewed+unconsumed articles). An explicit training parent can be chosen;
  it is resolved fail-closed from the store and never silently replaced by the active pointer.
- **Fresh brain** — creates a genuinely randomly-initialised version (no pretrained
  student weights) as an unpromoted candidate; it never activates itself.
- **Stop** is cooperative-first with a bounded grace period before the process tree is
  terminated; **no job auto-resumes** on restart (non-terminal jobs are reconciled and
  reported as `interrupted`).
- **Teacher readiness** is probed before work and reports the actual configured Ollama
  model, availability and pinned digest match.

The header **model version** selector is loaded dynamically from the selected store and
pins the version used by Dashboard, Chat view, Training History and Trends. It is a
*viewing scope only*: it never moves the active pointer or changes a running job's parent,
and chat still answers from the serving checkpoint.

Related endpoints: `GET/POST /api/admin/jobs*`, `/learning/start|stop`,
`/training/start|stop`, `/training/eligibility`, `/brain/fresh`, `/teacher`,
`/brain/versions`.

### Python compute plane

```bash
cd python
python -m venv .venv
.\.venv\Scripts\Activate.ps1

# pick exactly ONE backend profile:
pip install -r requirements-cuda.txt      # NVIDIA (RTX 4090 dev box)
# pip install -r requirements-rocm.txt    # AMD ROCm (Ryzen AI HX 370 / 890M, gfx1150)

python -m pytest                                  # 194 tests
python -m sma.brain init   --config small --out $SMA_STORE
python -m sma.brain status --out $SMA_STORE

# chat worker (framed stdio; Node spawns this, you rarely run it directly)
python -m sma.student --out $SMA_STORE
```


Training directly from the Python plane exercises the optimization pipeline
independently of the Node article-review workflow; useful for testing the trainer
in isolation, but **not** the normal end-to-end path (use the Node plane for that).
`--lr` is required and has no default, on purpose — the correct value depends on
optimizer, batch size, sequence length, model size, schedule and warm-up:

```bash
python -m sma.brain train --parent v001 --corpus sma\fixtures\tiny_en.txt `
    --out $SMA_STORE --lr 1e-4 --steps 60
```

`--compute-dtype bfloat16 --device cuda` is the intended production path. On CPU use
`--compute-dtype float32`: bf16 is emulated there and measured at 220× slower. To continue an
interrupted run, pass a larger `--steps` and `--resume-from vNNN`; resume refuses to cross a
changed corpus or config.

See [Development](docs/DEVELOPMENT.md) for the full command set, the repository map, and the
one-JSON-object subprocess contract.

---

## Architecture summary

The data plane carries text through harvest, curation, review and planning; the compute plane
consumes a frozen snapshot and produces an immutable checkpoint; the loss gate decides whether
the new checkpoint replaces the active one.

- **Only `REVIEWED` articles are trainable.** The critic is advisory; it never selects training
  data.
- **The dataset store is a ledger, not a queue.** Consumed material stays addressable so replay
  remains possible without being implemented.
- **Documents become fixed-length token blocks** (`concatenate-chunk-v1`) with no padding or
  masking; the train/validation split holds out a contiguous tail.
- **There is no teacher fallback** in chat; a turn comes from the student or not at all.
- **Checkpoints are immutable and append-only.** `active.json` is the only mutable pointer and
  never appears in a manifest.

The full component map, data-flow diagram, chat protocol, admin portal, model architecture and
the project invariants are in [Architecture](docs/ARCHITECTURE.md).

---

## Roadmap summary

- **Phase 0** — the harvest/curate/plan/registry loop with the stub trainer (the
  existing Node data plane; the stub is retained only as an explicitly opt-in
  `TRAINER_KIND=stub` path, real training is the default since Phase 1).
- **Phase 1 — 62M proof** — all twelve checks, complete.
- **Phase 2 — 3B** — repeat checks 1–12 at 3B, after an empirical memory preflight.
- **Phase 3 — perpetual** — years of continuous training that never caps or resets.

Experience replay and continual-learning algorithms are out of scope for Phases 1–2; the
architecture stays open to them. Known limitations and open research questions are consolidated
in the [Roadmap](docs/ROADMAP.md).

---

## Documentation

The full index is at [docs/README.md](docs/README.md).

| Document | Purpose |
|---|---|
| [Architecture](docs/ARCHITECTURE.md) | Two planes, components, data flow, chat/loss gate, invariants. |
| [Proof obligations](docs/PROOF.md) | The random-init invariant, six proof obligations, twelve checks. |
| [Deployment](docs/DEPLOYMENT.md) | Store layout, git boundaries, artifact naming, export, `active.json`, environment configuration. |
| [Roadmap](docs/ROADMAP.md) | Phases, priorities, known limitations, open questions. |
| [Development](docs/DEVELOPMENT.md) | Setup, repository map, testing, subprocess contract. |
| [Verified empirical findings](docs/FINDINGS.md) | Measured behaviours that shaped the design. |

---

## Testing

```bash
npm test                    # Node data plane: 221 node:test tests (repo root)
cd python; python -m pytest # Python compute plane: 194 pytest tests
```

Measured on the verified development machine (Windows, RTX 4090): Python
**194/194 pass**; Node **221/221 pass**. The trends classifier
`finitePoints` (`src/admin/metrics.js`) drops non-finite and empty `loss`
samples rather than coercing them with `Number(...)` (an earlier version
turned `loss: null` into `0` and kept the sample; `test/metrics.test.js`
pins the drop behaviour). The candidate-dependent worker/promotion tests run
only when the real Python store with committed `v001` and `v002` is present;
they skip otherwise.

A documentation-only change must leave both suites passing and must not modify
application code, training algorithms, model behaviour, APIs, dependencies,
build configuration, or runtime configuration.

---

## License

No license file is currently included in this repository.
