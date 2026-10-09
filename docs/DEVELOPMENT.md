# Development

This article covers the developer environment, the repository layout, how to run
and interpret the tests, the subprocess contract between the two planes, and the
contribution conventions. It is aimed at contributors.

For the system model see [ARCHITECTURE.md](ARCHITECTURE.md); for the proof
obligations see [PROOF.md](PROOF.md); for deployment and artifacts see
[DEPLOYMENT.md](DEPLOYMENT.md).

## Contents

- [Prerequisites](#prerequisites)
- [Repository map](#repository-map)
- [Node data plane](#node-data-plane)
- [Python compute plane](#python-compute-plane)
- [The subprocess contract](#the-subprocess-contract)
- [Testing and validation](#testing-and-validation)
- [Contribution conventions](#contribution-conventions)

---

## Prerequisites

- **Node.js ≥ 20** (verified on Node 24). The Node plane needs no hardware
  accelerator.
- **Python 3.14** with a virtual environment (verified on Python 3.14.6).
- **Exactly one** torch backend, chosen explicitly: NVIDIA CUDA (the RTX 4090
  development machine) or AMD ROCm (the Ryzen AI HX 370 / 890M deployment host).
- **Ollama** running a teacher model for curation/review, or `OLLAMA_FIXTURE=true`
  for a deterministic stub.

The Node data plane never touches a GPU. The Python compute plane owns the
accelerator.

---

## Repository map

```
python/                        compute plane
  sma/configs.py               3B source of truth, derived 62M config, expected counts
  sma/arch.py                  SmolLM3 construction, validation, parameter accounting
  sma/proof.py                 config-only fetch, AST audit, tensor hashes, loss signature
  sma/store.py                 immutable versions, atomic commit, durability, heartbeat,
                               content-addressed naming, export + verify
  sma/data.py                  ingestion, content hashes, concatenate-chunk packing, split
  sma/train.py                 precision model, guards, instrumentation, resumable train state
  sma/brain.py                 CLI and the one-JSON-object subprocess contract
  sma/student.py               long-lived chat worker (framed stdio, hot active brain)
  sma/preflight.py             read-only Phase 2 memory/portability budget
  sma/portability.py           platform/backend detection and the bf16 probe
  sma/fixtures/tiny_en.txt     deterministic corpus (original prose — no licensing question)
  tests/                       158 pytest tests (proof/init, training/check-7, publication/store,
                               phase-1 checks 6/8/9/10/11, student worker, phase-2 preflight)

src/
  harness/ services/           crawl, curate, plan, ollama-client (teacher/critic only)
  domain/                      article (lifecycle/importance — authoritative), review-policy
  storage/                     article-store (authoritative Article ledger; legacy pair-buffer is
                               detect-only), registry-store (append-only ledger, RUN.lock),
                               governance-store (append-only mission/strategy/proposal versions)
  dataset/                     snapshot, evaluation-set (frozen, leak-guarded)
  training/                    lifecycle, trainer-interface (stub), evaluator, model-handle,
                               loss-evaluator + python-promotion (authoritative loss gate)
  brain/ chat/ reward/         python-cli + student-worker + brain.js (student only), chat server,
                               reward scorer (advisory only)
  curriculum/ graphql/ cli/    validation gate, schema, one-shot runners
  admin/                       portal REST/SSE routes, change-feed, governance services,
                               read-only Python store reader, public/ SPA (vanilla JS)

test/                          83 node:test tests (domain, stores, admin portal, worker/promotion)
test-support/                  shared Python-prerequisite test helpers (not auto-discovered)
```

Phase 0 concepts worth preserving during the migration: exactly-once consumption
via `markConsumed`, the append-only NDJSON registry, frozen hash-sealed snapshots,
and the deterministic plan gate. These survive the move to real training; the
snapshot *format* does not.

---

## Node data plane

```bash
npm install
npm test                 # 83 node:test tests (domain, stores, admin portal, worker/promotion)

npm start                # GraphQL → http://localhost:4000/graphql, portal → http://localhost:4000/admin
$env:OLLAMA_FIXTURE="true"; $env:OLLAMA_MODEL="deepseek-r1:8b"; npm run crawl
npm run curate           # raw docs → ollama(clean) → buffer
npm run plan             # LLM is advisory; must pass the deterministic gate
npm run train            # NOTE: stub trainer — no real backprop yet
npm run chat             # http://localhost:8787 — serves the active Python student
```

`npm run train` currently computes statistics and calls the stub trainer. **It
does not train a neural network.** Real training is the Python CLI
(`python -m sma.brain train`). This is the single most important caveat in the
project.

`npm run chat` does not fall back to a teacher: it starts the Python student
worker, loads the `COMMITTED` version named by `$SMA_STORE/active.json`, and
returns `503` if no version is active or the worker is down.

Server-free one-shot CLIs: `train`, `evaluate`, `promote`, `reject`, `perpetual`
(`PERPETUAL_CYCLES=n`, `OLLAMA_FIXTURE=true` for CI).

---

## Python compute plane

```bash
cd python
python -m venv .venv
.\.venv\Scripts\Activate.ps1

# pick exactly ONE backend profile (torch is not in the common requirements):
#   -cuda : NVIDIA RTX 4090 dev box
#   -rocm : AMD Ryzen AI HX 370 / 890M (gfx1151) deployment host
pip install -r requirements-cuda.txt      # NVIDIA
# pip install -r requirements-rocm.txt    # AMD ROCm

python -m pytest                                  # 158 tests
python -m sma.brain init   --config small --out $SMA_STORE
python -m sma.brain status --out $SMA_STORE

# chat worker (framed stdio; Node spawns this, you rarely run it directly)
python -m sma.student --out $SMA_STORE
```

`init` writes `$SMA_STORE/v001/` containing `model.safetensors` (123,687,776
bytes), tokenizer, `config.json`, `generation_config.json`, `init-manifest.json`,
`provenance.json`, and `COMMITTED`. It fetches exactly 5 files and 0 weight bytes.

Training a child version:

```bash
python -m sma.brain train --parent v001 --corpus sma\fixtures\tiny_en.txt `
    --out $SMA_STORE --lr 1e-4 --steps 60
```

`--lr` is **required and has no default**, on purpose. The correct learning rate
depends on optimizer, batch size, sequence length, model size, schedule and
warm-up, so a constant baked into the code would be a number that looks measured
and is not. A test enforces its absence.

`--compute-dtype bfloat16` with `--device cuda` is the intended production path.
On **CPU**, use `--compute-dtype float32`: bf16 is emulated there and measured at
**220× slower** (see
[bf16 on CPU is emulated and 220× slower](FINDINGS.md#bf16-on-cpu-is-emulated-and-220x-slower)).

To continue an interrupted run, pass a larger `--steps` and name the version to
resume from:

```bash
python -m sma.brain train --parent v002 --corpus sma\fixtures\tiny_en.txt `
    --out $SMA_STORE --lr 1e-4 --steps 120 --resume-from v002
```

Resume **refuses** to proceed if the corpus `datasetHash` or any config field
other than `steps` differs, and refuses if the target does not advance.
Continuing against silently different data would make the recorded attribution a
lie.

`eval`, `generate` and `diff` are implemented (Phase 1 checks 6, 8, 9, 10 and 11).
`eval` loads a committed version and reports a token-weighted mean cross-entropy
over a packed corpus or frozen eval set; with `--verify-weights` it also re-hashes
the loaded tensors against the init manifest. `generate` decodes from a committed
version. `diff` compares two versions by tensor name in fp32 and reports
architecture parity, per-parameter deltas, buffer drift and both eval losses.

The `--verify-weights` count reconciliation (76 recorded, 74 persisted, 2 derived)
is explained in [PROOF.md](PROOF.md#verifying-a-trained-checkpoints-weights).

---

## The subprocess contract

Python emits **exactly one JSON object on stdout**; all progress goes to stderr.
Node invokes it as a subprocess and treats stdout as the entire result. Python
never writes the Node registry.

The long-lived student worker uses a different framing rule (one JSON request per
line on stdin, one response per line on stdout, echoing `id`); see
[Chat, the student worker, and the loss gate](ARCHITECTURE.md#chat-the-student-worker-and-the-loss-gate).

---

## Testing and validation

| Suite | Command | Count |
|---|---|---|
| Node data plane | `npm test` (from repo root) | 83 `node:test` tests |
| Python compute plane | `python -m pytest` (from `python/`) | 158 pytest tests |

Both suites pass on the verified development machine. The Python suite includes
proof/init, check-7 training, publication/store, Phase 1 checks 6/8/9/10/11, the
student worker, portability and the Phase 2 preflight.

When adding a test that exercises a real model, **state its compute dtype
deliberately**: a bf16-on-CPU test silently bills ~220× for nothing (see
[FINDINGS.md](FINDINGS.md#bf16-on-cpu-is-emulated-and-220x-slower)).

A documentation-only change must not modify application code, training
algorithms, model behaviour, APIs, dependencies, build configuration, or runtime
configuration, and should leave both test suites passing.

---

## Contribution conventions

- **Do not break the [invariants](ARCHITECTURE.md#invariants--do-not-break-these).**
  They are correctness properties, not style preferences.
- **Keep the two planes separate.** The Node plane owns the corpus and the
  ledger; the Python plane owns the accelerator and never writes the Node
  registry.
- **Preserve provenance.** Every checkpoint records seed, initializer, config
  source, tensor hashes and the structural audit result. A training number that is
  *nearly* right is worse than one that is absent, because it reads as evidence.
- **Keep the teacher advisory.** The teacher may propose and review; it must never
  select training data deterministically or answer as the student.
- **Documentation conventions.** New documentation lives under `docs/` and is
  indexed from [docs/README.md](README.md). Use relative Markdown links so they
  work on GitHub and from a local clone. Prefer a Mermaid diagram only when it
  clarifies architecture or data flow. Keep specialist terminology explained on
  first use, and keep a single authoritative location for each substantial piece
  of information.
