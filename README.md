# SimpleMindsAI

A perpetually self-improving text model, **pre-trained from random initialization** and grown
continuously over years of operation. No pretrained neural weights are ever loaded into the
student. The model starts as noise and becomes a language model by consuming articles it
collects itself.

Two planes:

- **Node data plane** (this repo's `src/`) — harvest, curate, review, plan, registry, provenance.
  Owns the corpus and the ledger. Never touches a GPU.
- **Python compute plane** (`python/`) — random init, tokenization/packing, optimization,
  checkpointing, evaluation, generation. Owns the accelerator. Never writes the Node registry.

The teacher (DeepSeek, via Ollama) is a **researcher and reviewer only**. It is never the brain,
and it is never a fallback for the brain.

---

## Status

Verified on this machine (Windows, RTX 4090 24,564 MiB, CUDA capability 8.9, 63.7 GB RAM,
Python 3.14.6, Node ≥20, torch 2.14.0+cu130, transformers 5.17.0).

| | |
|---|---|
| Node data plane | 24/24 `node:test` tests pass |
| Python compute plane | 32/32 pytest tests pass |
| Checkpoint `v001` | committed, 62M params, provenance recorded |
| Trained checkpoint | **not yet** — `train` is not implemented |

Phase 1 is partially complete. Random initialization, atomic commit, the no-pretrained-weights
proof, and provenance are done and tested. Training, evaluation, and generation are not.

---

## The one invariant that cannot bend

**The student is randomly initialized and never receives pretrained neural weights.**

Everything else in this repo is negotiable. This is not. It is the difference between a system
that learns and a system that launders someone else's training run. Three things are permitted
because they are encodings, not learned knowledge:

1. `config.json` — architecture hyperparameters. Shapes, not values.
2. The tokenizer (vocabulary, merges, special-token IDs) — an encoding mechanism.
3. A teacher LLM's *text output*, which becomes corpus data and is never merged into weights
   outside of ordinary training.

The proof is deliberately over-determined, because "we didn't load pretrained weights" is easy to
claim and easy to get wrong. See [Proof obligations](#proof-obligations).

---

## Proof obligations

`python/sma/proof.py` exists to make the invariant above falsifiable. Six independent checks:

1. **Manifest fields.** Every checkpoint records `initialisationType: "RANDOM"`,
   `pretrainedWeightsUsed: false`, the seed, the initializer kind and std, and the full
   architecture. A checkpoint without these is invalid.
2. **Structural audit.** An AST walk over the whole `sma` package finds every `.from_pretrained`
   call. A bare `org/name` Hub id is a violation; a filesystem path is allowed, because reloading
   our own trained checkpoint is required. An AST walk rather than a text scan, so docstrings and
   comments cannot trigger a false positive. Result is **persisted into the manifest**, not merely
   logged — an init that prints "0 violations" while writing no evidence has proved nothing.
3. **Zero weight bytes.** The fetch uses an allowlist of config/tokenizer patterns and asserts on
   *bytes*, not filenames. A single shard under any name shows up as `weightBytes > 0`.
4. **Offline construction.** `init` sets `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1` after
   fetching, then builds the model. The recorded env is written to the manifest.
5. **Parameter accounting.** Unique-parameter count is computed from the config (deduplicated by
   `data_ptr()`, because tied embeddings alias) and asserted against a stored expectation. All
   parameters must be trainable — a frozen tensor is a bug.
6. **Loss signature.** A randomly initialized model over vocabulary *V* must have cross-entropy
   near `ln(V)`. For `V = 128256` that is **11.7618**. The accepted band is `[10.5, 12.5]`, wide
   enough not to trip on loss-reduction differences. A pretrained SmolLM3 scores ~1.8–2.5, so the
   guard is armed permanently: **if a future checkpoint ever evaluates below the band, weights
   leaked.** This is the check that catches a silent leak, because nothing else inspects numbers.

---

## The 12 checks (Phase 1 gate)

Phase 1 exists to prove the full lifecycle end-to-end at 62M before spending years on 3B.
A phase is not done until all twelve pass.

| # | Check | Status |
|---|---|---|
| 1 | A config exists and produces a randomly initialized model | done |
| 2 | Parameter count matches the config exactly (`61,839,744`) | done |
| 3 | `v001` is saved and published atomically with a `COMMITTED` marker | done |
| 4 | No pretrained neural weights were loaded (all six obligations above) | done |
| 5 | `train` runs real optimization on the fixture corpus and produces `v002` | **todo** |
| 6 | `v002` reloads from disk into a fresh process | **todo** |
| 7 | Every tensor changed by name after training | **todo** |
| 8 | Evaluation produces a loss number | **todo** |
| 9 | Loss decreases in the expected direction | **todo** |
| 10 | Versions are comparable and the diff is explainable | **todo** |
| 11 | Generation runs from a checkpoint (nonsense output is fine) | **todo** |
| 12 | Provenance and init manifest are persisted | done |

Nonsense generations at step 11 are **expected and acceptable**. A model that has seen a few
thousand tokens of English should not produce English. The point is that the plumbing works.

---

## Roadmap

Phase numbering was previously ambiguous — the old README used "Phase 2" for the perpetual loop.
The mapping:

- **Phase 0 (this repo's existing Node work)** — the harvest/curate/plan/registry loop with a
  stub trainer. Still the reference for the data plane. What the old README called "Phase 2" is
  Phase 0's internal run loop.
- **Phase 1 — 62M proof.** All 12 checks. Proves the lifecycle and the proofs on a model cheap
  enough to iterate on in minutes.
- **Phase 2 — 3B.** Repeat checks 1–12 on the official architecture, then an empirical memory
  preflight before any long run.
- **Phase 3 — perpetual.** Years of continuous training. Never caps, never resets.

### Phase 2 preflight, before any 3B run

Do not attempt 3B training until measured. Budget explicitly for parameters, gradients, optimizer
state, fp32 master weights, activations, CUDA overhead, and checkpoint write space. The intended
design is CPU fp32 master weights with bf16 compute and gradient checkpointing, but this must be
**empirically verified on the actual machine, not assumed**. Adafactor is the fallback if 8-bit
Adam plus fp32 masters does not fit. Never silently switch training strategy — if the config
changes, the manifest must say so.

---

## Architecture

```
  SUBSYSTEM A (harvest & ingest)          SUBSYSTEM B (plan)
  ┌──────────────┐   ┌────────────────┐   ┌──────────────────────┐
  │ crawler.js   │──▶│ curator.js     │   │ planner.js           │
  │ raw blobs    │   │ deepseek-r1    │   │ reads measurements,  │
  │(placeholder) │   │ via Ollama     │   │ asks LLM for a       │
  └──────────────┘   │ → long-form    │   │ balanced curriculum  │
                     │   articles     │   └──────────┬───────────┘
                     └────────┬───────┘   (advisory: deterministic
                              │                   gate has final say)
  ┌───────────────────────────── buffer ◀──────────┘
  ── transient (purgeable) ──▐ Article ▐ ReviewVerdict ▐
  ── durable ────────────────▐ TrainingLog ▐ trained marks ▐
  └────────────────────────────▲───┬──────────────────────────┘
                               │   │ consumeBatch (REVIEWED only) + commitConsumption
  SUBSYSTEM C (train & chat)   │   ▼
  ┌──────────────┐  ┌────────────────────┐  ┌──────────────────────┐
  │ cli/train.js │─▶│ dataset/snapshot.js│─▶│ PYTHON WORKER        │
  │ orchestrator │  │ immutable records  │  │ sma.brain (subprocess)│
  └──────────────┘  └────────────────────┘  │ init/train/eval/     │
                                            │ generate → JSON      │
  ┌──────────────┐  ┌────────────────────┐  └──────────┬───────────┘
  │ chat-server  │─▶│ brain.js           │◀────────────┘
  │ chat UI      │  │ the trained model  │  (Ollama fallback: REMOVE)
  └──────────────┘  └────────────────────┘
                     evaluation-set.js (frozen, leak-guarded)
                     registry-store.js (append-only ledger, RUN.lock)
```

### The training unit is an article, not a pair

The earlier design trained on `{prompt, completion}` pairs scored by a critic. That is
instruction-tuning, and it is not what this project does. The student is a **raw causal language
model**: it learns by predicting the next token in continuous text. Consequences:

- **No reward in the training signal.** `RewardScore`, `MAX_SYNTHETIC_SHARE`, and the echo-chamber
  cap guard an SFT failure mode that this design does not have. Keep the deterministic guardrail
  for chat quality, but it must never select training data.
- **The critic is advisory.** A reward model may flag bad articles. It may not be the gate.
- **Only `REVIEWED` articles are trainable.** Unreviewed text is buffered but not consumed.

### Review cadence

Review runs every **1,000** consumed articles. This is an **interval, not a cap**. It does not
stop training, reset the brain, or create a fresh dataset. The lineage is append-only and
continuous, and the model trains continuously for years across millions of articles.

Teacher review is **sampled** — proposed default 5–10% of articles. The primary mission remains
human-controlled; sampling is a throughput measure, not a transfer of authority.

---

## Quickstart

### Node data plane

```bash
npm install
npm test                 # 24 node:test tests, no GPU or Ollama needed

npm start                # GraphQL buffer  → http://localhost:4000/graphql
$env:OLLAMA_FIXTURE="true"; $env:OLLAMA_MODEL="deepseek-r1:8b"; npm run crawl
npm run curate           # raw docs → ollama(clean) → buffer
npm run plan             # LLM is advisory; must pass the deterministic gate
npm run train            # NOTE: stub trainer — no real backprop yet
npm run chat             # http://localhost:8787
```

`npm run train` currently computes statistics and calls the stub trainer. **It does not train a
neural network.** This is the single most important caveat in this README.

Server-free one-shot CLIs: `train`, `evaluate`, `promote`, `reject`, `perpetual`
(`PERPETUAL_CYCLES=n`, `OLLAMA_FIXTURE=true` for CI).

### Python compute plane

```bash
cd python
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install --index-url https://download.pytorch.org/whl/cu130 torch
pip install -r requirements.txt

python -m pytest                                  # 32 tests
python -m sma.brain init   --config small --out scratch\models
python -m sma.brain status --out scratch\models
```

`init` writes `scratch/models/v001/` containing `model.safetensors` (123,687,776 bytes),
tokenizer, `config.json`, `generation_config.json`, `init-manifest.json`, `provenance.json`, and
`COMMITTED`. It fetches exactly 5 files and 0 weight bytes.

`train`, `eval`, and `generate` raise `NotImplementedError` — they are Phase 1 checks 5, 8, and 11.

### The subprocess contract

Python emits **exactly one JSON object on stdout**; all progress goes to stderr. Node invokes it
as a subprocess and treats stdout as the entire result. Python never writes the Node registry.

---

## Model architecture

`SmolLM3ForCausalLM`, built from a config. Same code path for both sizes — only scale fields differ.

| | `small` (dev/CI) | `3b` (target) |
|---|---|---|
| layers | 8 | 36 |
| hidden | 384 | 2048 |
| attention heads | 6 | 16 |
| KV heads | 2 | 4 |
| head dim (derived) | 64 | 128 |
| intermediate | 1024 | 11008 |
| max positions | 2048 | 65536 |
| **unique params** | **61,839,744** | **3,075,098,624** |

Shared by both, and asserted field by field: vocab 128256, tied embeddings, `rope_theta`
5000000.0, RMSNorm eps 1e-6, no attention or MLP bias, `hidden_act: silu`,
`no_rope_layer_interval: 4` (NoPE on every 4th layer: `small` → layers 3 and 7), attention
dropout 0, `sliding_window: null`, no rope scaling.

`small` is **derived** from the 3B config by overriding only `SCALE_FIELDS`; a test fails if any
non-scale field is touched, so the two can never silently drift apart.

Source of truth: `https://huggingface.co/HuggingFaceTB/SmolLM3-3B-Base/raw/main/config.json`.

### Do not construct SmolLM3 from class defaults

`SmolLM3Config()` defaults differ from the published SmolLM3 config:
`max_position_embeddings` is 32768 (not 65536), `rope_theta` is 2000000.0 (not 5000000.0), and
`bos_token_id` is 128000 (not `null`). Building from defaults instead of from the published file
trains different RoPE with a spurious BOS token, and **nothing raises**. `test_class_defaults_differ_from_published_config`
pins this so a future transformers upgrade that aligns the defaults is noticed.

---

## Verified empirical findings

Behaviours measured on this machine, not assumed. Several contradict the documentation or the
intuition, and each cost real debugging time.

**Transformers 5.x uses a plain normal, not a truncated normal.** The docstring says "truncated
normal"; the observed max is ~4.6σ, not 2. `INITIALIZER_KIND = "normal"` and `std = 0.02`.

**Transformers 5.17 API changes.** RoPE lives under `config.rope_parameters`; `torch_dtype` is
deprecated in favour of `dtype`. Setting `config.torch_dtype` emits a warning.

**19 of 76 tensors are seed-invariant.** Of 76 tensors, 57 depend on the seed. The other 19 do
not: the 17 RMSNorm weights initialize to exactly 1.0 regardless of seed, and the 2 RoPE
`inv_freq` buffers are a deterministic function of `head_dim` and `rope_theta`. Consequences:

- "Reseeding produces a different brain" holds for 57/76 tensors, not all of them.
- 76 tensors yield only **59 distinct SHA-256 digests**.
- **Version diffs must be keyed by tensor name.** A digest-set comparison loses the name
  correspondence and cannot report *which* tensor moved. This does not endanger
  `test_every_tensor_differs_after_training` — norms and RoPE buffers both receive gradients and
  move during training. It would only break a change test written against *initialization*.
- `named_parameters()` already deduplicates tied embeddings, so the alias never appears there. It
  does appear in `state_dict()`; count by `data_ptr()`, not by entry.

**`os.fsync()` on a read-only handle returns `EBADF` on Windows**, and `os.open()` on a directory
raises `PermissionError` — there is no POSIX-style directory fsync on Windows at all. `store.py`
opens `r+b`, treats directory fsync as unsupported there, and reports what actually synced rather
than pretending. NTFS still orders metadata through `os.replace`.

**`snapshot_download(local_dir=...)` writes hub bookkeeping** under `.cache/huggingface/`. It is
filtered out of `filesDownloaded` so the manifest lists only artifacts actually requested.

---

## Known defects

Real, unfixed, and listed so they are not mistaken for intended behavior.

1. **A zero-score model is promoted.** `evaluator.js:111` tests
   `cand >= promoteMinScore && delta >= promoteMinDelta` with both defaults at `0`
   (`config.js:56-57`). A model scoring 0.0 that improves by 0.0 is **PROMOTED**. The docstring
   above it (line 98) claims "non-zero absolute score" — the code does not enforce that. *No test
   covers the zero case*; the lifecycle tests pass legitimately because their fake completer returns
   the reference text, giving a real score of 1.0. Fixing this means deciding whether promotion
   should be gated on causal-LM loss rather than token-F1, which changes the evaluator.
2. **`RUN.lock` goes stale after 10 minutes.** Unsuitable for multi-day training. The Python
   `store.py` already provides a heartbeat; the Node side does not use it yet.
3. **`dataset/snapshot.js` materializes entire datasets in memory.** Fine for thousands of rows,
   fatal for a million-article corpus. Must become a descriptor handoff to the Python worker.
4. **The Ollama/DeepSeek brain fallback still exists** in `brain/brain.js`. Delete it once the
   trained model can serve chat. DeepSeek must never be the brain.
5. **`TeacherClient` has no `complete` implementation.**
6. `promptsPage` cursor plus trained-filter can skip rows; move to a keyset cursor as the buffer
   grows.

---

## Invariants — do not break these

1. **Never load pretrained weights into the student.** Config, tokenizer, and teacher text only.
   Enforced by check 4; see [Proof obligations](#proof-obligations).
2. **Never train on the live buffer.** The trainer reads frozen records only; consumption is
   committed *after* the run records success, so a crash never double-trains.
3. **Never consume unreviewed articles.** Only `REVIEWED` is trainable.
4. **The LLM plan is advisory.** Any curriculum must survive `validateCurriculum`; on failure the
   run proceeds with `fallbackCurriculum`. A malformed plan cannot stall the loop.
5. **The eval set never leaks.** Sets are frozen and hash-sealed at run start; the pair-hash guard
   refuses rows appearing in both.
6. **Never promote without an evaluation.** (Currently violated in spirit — see defect 1.)
7. **Checkpoints are immutable and append-only.** `vNNN` directories are never rewritten.
8. **Every checkpoint carries provenance.** Seed, initializer, config source, tensor hashes, and
   the structural audit result.

---

## Repository map

```
python/                        compute plane
  sma/configs.py               3B source of truth, derived 62M config, expected counts
  sma/arch.py                  SmolLM3 construction, validation, parameter accounting
  sma/proof.py                 config-only fetch, AST audit, tensor hashes, loss signature
  sma/store.py                 immutable versions, atomic commit, durability, heartbeat
  sma/brain.py                 CLI and the one-JSON-object subprocess contract
  sma/fixtures/tiny_en.txt     deterministic corpus (original prose — no licensing question)
  tests/                       32 pytest tests

src/
  harness/ services/           crawl, curate, plan, ollama-client
  storage/                     buffer-store, registry-store (append-only ledger, RUN.lock)
  dataset/                     snapshot, evaluation-set (frozen, leak-guarded)
  training/                    lifecycle, trainer-interface (stub), evaluator, model-handle
  brain/ chat/ reward/         brain.js, chat server, reward scorer (advisory only)
  curriculum/ graphql/ cli/    validation gate, schema, one-shot runners

test/                          24 node:test tests
```

Phase 0 concepts worth preserving during the migration: exactly-once consumption via
`markConsumed`, the append-only NDJSON registry, frozen hash-sealed snapshots, and the
deterministic plan gate. These survive the move to real training; the snapshot *format* does not.
