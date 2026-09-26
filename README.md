# SimpleMindsAI

A perpetually self-improving text model, **trained from random initialization** and grown
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
| Python compute plane | 57/57 pytest tests pass |
| Checkpoint `v001` | committed, 62M params, provenance recorded |
| Checkpoint `v002` | committed, 60 real steps, 74/74 params moved, 2 buffers unchanged |

Phase 1 is partially complete. Random initialization, atomic commit, the no-pretrained-weights
proof, provenance, and **real optimization with resumable state** are done and tested.
Evaluation, version comparison, and generation are not.

### What `v002` does and does not prove

`v002` was trained for 60 steps on the 4 KB fixture corpus — 7 blocks, 5 of them train. Train
loss fell 11.83 → 7.72; validation loss moved 11.82 → 11.54. **That gap is memorization of five
blocks, not learning**, and the honest reading is that the model still knows almost nothing. It is
supposed to. The fixture exists to prove the machinery moves real gradients into real weights and
can be resumed, not to produce a language model.

So check 5 passing means *"the optimizer, the precision model, the guards, the provenance and the
resume path work"* — nothing more. Any claim that the model has learned English at this point
would be reading a training curve as a capability, which is the mistake the loss-signature guard
exists to prevent in the opposite direction.

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
   guard is armed permanently: **if a fresh checkpoint ever evaluates below the band, weights
   leaked.** This is the check that catches a silent leak, because nothing else inspects numbers.

   **The band applies only to freshly initialized, untrained checkpoints.** A successfully trained
   `v002` legitimately scores far below 11.76 — that is the whole point. Applying the band to a
   trained checkpoint would report a leak that did not happen, so the guard must be conditional on
   `initialisationType == "RANDOM"` with no training steps recorded. This is a correctness
   requirement for check 8, not an extension of it.

---

## The 12 checks (Phase 1 gate)

Phase 1 exists to prove the full lifecycle end-to-end at 62M before spending years on 3B.
A phase is not done until all twelve pass.

**The Phase 1 scope boundary, stated explicitly:**

```
Phase 1:   prove the machinery can train and recover safely
Later:      prove the machinery can learn continuously without degrading
```

Experience replay and sophisticated continual-learning algorithms are **out of scope**. The
architecture must merely stay *open* to them. See
[Known future problems](#known-future-problems) — both of the big risks are recorded there
deliberately unimplemented.

| # | Check | Status |
|---|---|---|
| 1 | A config exists and produces a randomly initialized model | done |
| 2 | Parameter count matches the config exactly (`61,839,744`) | done |
| 3 | `v001` is saved and published atomically with a `COMMITTED` marker | done |
| 4 | No pretrained neural weights were loaded (all six obligations above) | done |
| 5 | `train` runs real optimization on the fixture corpus and produces `v002` | done |
| 6 | `v002` reloads from disk into a fresh process | **todo** |
| 7 | Every trainable parameter changes materially; buffers stay put | done |
| 8 | Evaluation produces a loss number | **todo** |
| 9 | Loss decreases in the expected direction | **todo** |
| 10 | Versions are comparable and the diff is explainable | **todo** |
| 11 | Generation runs from a checkpoint (nonsense output is fine) | **todo** |
| 12 | Provenance and init manifest are persisted | done |

Nonsense generations at step 11 are **expected and acceptable**. A model that has seen a few
thousand tokens of English should not produce English. The point is that the plumbing works.

### Check 7 is a statement about parameters, not about `state_dict()`

The change test is deliberately narrow, because the obvious version of it is wrong:

```
Every trainable parameter tensor changes materially after training.
Expected non-trainable buffers remain unchanged unless explicitly designed otherwise.
```

The diff therefore runs over **`named_parameters()`**, not `state_dict()`. Two measured facts make
the narrow form the correct one:

- The RoPE `inv_freq` buffers are **non-persistent**. They are absent from `state_dict()` entirely
  and never change value, because they are a closed-form function of `head_dim` and `rope_theta`.
  A `state_dict()`-wide "everything must differ" test would be asserting that a constant changed.
  They *are* enumerated by `named_buffers()`, which is why the init manifest hashes 76 entries
  (74 parameters + 2 buffers) while `state_dict()` has only 74.
- Asserting that buffers are unchanged is worth doing explicitly, because it catches a
  desynchronised RoPE table — a real failure mode that would otherwise be invisible.

"Changes materially" is not the same as "changes at all", and the threshold is not arbitrary — see
[bf16 master weights silently freeze 17 parameters](#bf16-master-weights-silently-freeze-17-parameters).

---

## Roadmap

Phase numbering was previously ambiguous — the old README used "Phase 2" for the perpetual loop.
The mapping:

- **Phase 0 (this repo's existing Node work)** — the harvest/curate/plan/registry loop with a
  stub trainer. Still the reference for the data plane. What the old README called "Phase 2" is
  Phase 0's internal run loop.
- **Phase 1 — 62M proof.** All 12 checks. Proves the lifecycle and the proofs on a model cheap
  enough to iterate on in minutes. Scope: *the machinery can train and recover safely.*
- **Phase 2 — 3B.** Repeat checks 1–12 on the official architecture, then an empirical memory
  preflight before any long run.
- **Phase 3 — perpetual.** Years of continuous training. Never caps, never resets. This is where
  the [open questions](#1-catastrophic-forgetting) about replay ratios, sampling, forgetting
  detection, and mixture weighting get answered experimentally.

### Phase 2 preflight, before any 3B run

Do not attempt 3B training until measured. Budget explicitly for parameters, gradients, optimizer
state, fp32 master weights, activations, CUDA overhead, and checkpoint write space. The intended
design is CPU fp32 master weights with bf16 compute and gradient checkpointing, but this must be
**empirically verified on the actual machine, not assumed**. Adafactor is the fallback if 8-bit
Adam plus fp32 masters does not fit. Never silently switch training strategy — if the config
changes, the manifest must say so.

The fp32-master requirement is not hypothetical: see
[bf16 master weights silently freeze 17 parameters](#bf16-master-weights-silently-freeze-17-parameters).

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

### The dataset store is a ledger, not a queue

Consumed training material is **not** discarded after training. Articles are marked consumed so
they are not trained on twice, but they remain addressable and their content hashes are retained.
This is a storage design constraint, not a replay feature: it keeps the
[replay option](#1-catastrophic-forgetting) open without implementing any part of it, and it is
cheap now and impossible to retrofit later.

### How documents become training examples

`concatenate-chunk-v1`, in `sma/data.py`:

```
tokenize each document -> concatenate with a "\n\n" separator -> chunk into
fixed-length blocks -> each block is one example, labels shifted by the model
```

No padding, no attention masking, no per-block document bookkeeping. A block may straddle a
document boundary. That is a deliberate trade: it maximises token efficiency and makes the token
stream trivially reconstructible from the recorded parameters, which is the binding constraint for
future replay. The alternative — per-document with EOS separators and masking — changes what the
loss number *means*, so the two are never mixed silently.

Every consumed article is recorded by **both** `articleId` and `contentHash`, and `pack()`
verifies the hash against the text rather than trusting the caller — a stale hash would make the
contribution record quietly false, and that failure would surface months later during a replay,
when it is expensive to diagnose.

The train/validation split holds out a **contiguous tail** of whole blocks, never a random subset.
A random split over a packed stream leaks neighbouring context across the boundary, which makes a
validation number optimistic for a reason that has nothing to do with the model.

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

python -m pytest                                  # 57 tests
python -m sma.brain init   --config small --out scratch\models
python -m sma.brain status --out scratch\models
```

`init` writes `scratch/models/v001/` containing `model.safetensors` (123,687,776 bytes),
tokenizer, `config.json`, `generation_config.json`, `init-manifest.json`, `provenance.json`, and
`COMMITTED`. It fetches exactly 5 files and 0 weight bytes.

Training a child version:

```bash
python -m sma.brain train --parent v001 --corpus sma\fixtures\tiny_en.txt `
    --out scratch\models --lr 1e-4 --steps 60
```

`--lr` is **required and has no default**, on purpose. The correct learning rate depends on
optimizer, batch size, sequence length, model size, schedule and warm-up, so a constant baked into
the code would be a number that looks measured and is not. A test enforces its absence.

`--compute-dtype bfloat16` with `--device cuda` is the intended production path. On **CPU**, use
`--compute-dtype float32`: bf16 is emulated there and measured at **220× slower**
(see [empirical findings](#bf16-on-cpu-is-emulated-and-220x-slower)).

To continue an interrupted run, pass a larger `--steps` and name the version to resume from:

```bash
python -m sma.brain train --parent v002 --corpus sma\fixtures\tiny_en.txt `
    --out scratch\models --lr 1e-4 --steps 120 --resume-from v002
```

Resume **refuses** to proceed if the corpus `datasetHash` or any config field other than `steps`
differs, and refuses if the target does not advance. Continuing against silently different data
would make the recorded attribution a lie.

`eval` and `generate` still raise `NotImplementedError` — they are Phase 1 checks 8 and 11.

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

## Checkpoints: what goes in git, and what does not

A brain version is large, and gets larger every version. Measured on this machine:

| Artifact | Size |
|---|---|
| `v001` total (bf16 weights) | 134.4 MiB |
| `v002` total (fp32 weights) | 252.5 MiB |
| optimizer moments for `v002`, AdamW fp32 | 471.9 MiB |
| 3B weights, bf16 | **5.73 GB** |
| 3B weights, fp32 | **11.46 GB** |

`model.safetensors` for the 62M model is already **118 MiB**, past GitHub's hard 100 MiB
single-file push limit. Weights in git history are worse than merely large: git stores every
version of a binary blob permanently, compresses none of it, and cannot merge it. Training to
`v010` adds 1.2 GB of unreclaimable history; `v500` puts 59 GB in the repository and makes it
unusable for the code work it is supposed to contain. Binary merge conflicts are unresolvable.

So the repo splits into two tiers, and the split is not a compromise — the manifest makes it a
stronger guarantee than a blob in history would:

**Tier 1 — in git, as text.** `config.json`, `provenance.json`, `init-manifest.json`,
`train-state.json`, `parameter-diff.json`, `COMMITTED`, and the tokenizer (16.4 MiB, well under
GitHub's per-file limit). Measured for `v002`: **150,909 bytes** of provenance and config, plus
the 17.2 MB tokenizer. Every claim about how a brain was made and trained is reviewable in a diff.
This includes the SHA-256 of all 76 tensors, so a reviewer can check the manifest against a
downloaded artifact without trusting the uploader.

**Tier 2 — out of git history.** The weight file itself, published as a **GitHub Release
asset** (still GitHub, still versioned, still fetchable through the API) or via Git LFS. The
committed hashes verify it bit-for-bit, which is a stronger statement than "trust the blob that
happens to be in the tree."

Optimizer moments are a third thing and deliberately in neither: they are ~2× the fp32 weights,
they are a torch pickle rather than a reviewable record, and they describe a *run that may
continue* rather than a version that is immutable once committed. They live in
`scratch/models/_runs/<version>.train-state.pt`, outside the version directory. Keeping them
inside would have made every 62M checkpoint 724 MiB instead of 252 MiB.

### Naming

Not `simpleminds_r1:latest`. Docker-style tags are a mutable pointer, and this project's
load-bearing property is that `vNNN` is append-only and immutable — you must always be able to
answer *which exact weights produced this loss number*, and a name that moves under you cannot
answer that. `latest` also invites pull-and-assume-reproducible, which this project cannot offer.

```
internal identity    vNNN                                      append-only, immutable
artifact name        smai-smollm3-<size>-<YYYYMMDD>-<hash12>     immutable, content-addressed
release pointer      latest                                    only ever advances, never in a manifest
```

The 12-hex suffix is the point: the name *proves* which weights it is. If the hash does not match
the file, the name is a lie and verification fails loudly. The canonical `vNNN` remains the
internal identity so `store.py`'s immutability rules and the manifest chain stay authoritative;
the artifact name is a publication concern layered on top, not a replacement.

For 3B this also forces sharding, because a GitHub Release asset caps at 2 GB — 5.73 GB does not
fit in one. `safetensors` shards natively, and shards follow the same naming scheme.

---

## Verified empirical findings

Behaviours measured on this machine, not assumed. Several contradict the documentation or the
intuition, and each cost real debugging time.

**Transformers 5.x uses a plain normal, not a truncated normal.** The docstring says "truncated
normal"; the observed max is ~4.6σ, not 2. `INITIALIZER_KIND = "normal"` and `std = 0.02`.

**Transformers 5.17 API changes.** RoPE lives under `config.rope_parameters`; `torch_dtype` is
deprecated in favour of `dtype`. Setting `config.torch_dtype` emits a warning.

**19 of 76 hashed tensors are seed-invariant.** `proof.tensor_hashes` walks `named_parameters()`
*and* `named_buffers()`, so it records 76 entries: 74 parameters plus the 2 RoPE buffers. Of those
76, 57 depend on the seed. The other 19 do not: the 17 RMSNorm weights initialize to exactly 1.0
regardless of seed, and the 2 RoPE buffers are a closed-form function of `head_dim` and
`rope_theta`. Consequences:

- "Reseeding produces a different brain" holds for 57/76 hashed entries, not all of them.
- 76 entries yield only **59 distinct SHA-256 digests**.
- **Version diffs must be keyed by tensor name.** A digest-set comparison loses the name
  correspondence and cannot report *which* tensor moved.
- `named_parameters()` already deduplicates tied embeddings, so the alias never appears there. It
  does appear in `state_dict()`; count by `data_ptr()`, not by entry.
- The 2 RoPE buffers are **non-persistent**: they are not in `state_dict()` at all, never
  serialize, and never change value. `state_dict()` has 74 entries, not 76.

#### bf16 master weights silently freeze 17 parameters

The single most consequential measurement in this repo, and the reason check 7 is phrased as it is.

The 17 RMSNorm weights all initialize to **1.0**. bfloat16 has 8 mantissa bits, so at magnitude
1.0 its representable resolution is about **7.8e-3**. A default AdamW update of `lr = 1e-4` is two
orders of magnitude *below* that resolution. Measured, with real non-zero gradients of ~1.3e-2:

| master weight dtype | parameters that moved after 5 steps |
|---|---|
| bf16 | **57 of 74** — 17 frozen |
| fp32 | **74 of 74** — none frozen |

So with bf16 parameters those 17 norms receive gradients, are handed to the optimizer, and then
**do not change at all** — the update rounds away. Nothing raises. Loss still falls, because the
other 57 parameters are learning, so this failure is completely invisible in the loss curve. It
would have shipped as a passing Phase 1 and quietly frozen every normalization scale in the 3B
model.

**Consequence, and it is not optional:** the compute dtype and the master dtype must be
separated, and the master must be fp32, on the 62M development model too — not only on 3B. bf16
is then a compute/cast detail, never the storage the optimizer updates. The Phase 2 preflight
below already assumes this; this measurement is why it is a requirement rather than a preference.

#### bf16 on CPU is emulated and 220x slower

The precision model above is correct on an accelerator and a serious performance trap on a CPU.
Measured on this machine, 62M model, batch 2 × 64 tokens, forward + backward:

| compute path | time per fwd+bwd |
|---|---|
| fp32 | **0.13 s** |
| `torch.autocast("cpu", bfloat16)` | **28.96 s** |

A **220× penalty**, because this CPU has no native bf16 and PyTorch emulates it. The result is
still numerically correct, so nothing raises — the run just appears to hang, which is how this was
found: a test suite written against the 62M model took **27 minutes** instead of 30 seconds.

Two consequences. `bf16` compute is for the accelerator; CPU runs use `float32`. And a test suite
that exercises a real model must state its compute dtype deliberately, or it will silently bill
220× for nothing. `train` logs a warning if you ask for CPU + bf16.

#### A ragged final batch makes `effectiveBatchSize` a lie

The sampler originally took whatever remained at the end of a shuffle, so a "batch of 2" was
sometimes a batch of 1. `effectiveBatchSize` was recorded as 4 while the mean was not, and a
60-step run reported 25,600 tokens where `60 × 2 × 2 × 128 = 30,720` was expected.

Nothing crashed and the loss still fell. The fix is to drop the ragged tail and reshuffle, so
every micro-batch is exactly `microBatchSize` blocks; token accounting is then exact by
construction and is asserted. The general lesson is the one this repo keeps hitting: a training
number that is *nearly* right is worse than one that is absent, because it reads as evidence.

**`os.fsync()` on a read-only handle returns `EBADF` on Windows**, and `os.open()` on a directory
raises `PermissionError` — there is no POSIX-style directory fsync on Windows at all. `store.py`
opens `r+b`, treats directory fsync as unsupported there, and reports what actually synced rather
than pretending. NTFS still orders metadata through `os.replace`.

**`snapshot_download(local_dir=...)` writes hub bookkeeping** under `.cache/huggingface/`. It is
filtered out of `filesDownloaded` so the manifest lists only artifacts actually requested.

---

## Known future problems

Recorded deliberately unimplemented, so the architecture accommodates them without Phase 1
growing to solve them. Each says what is **out of scope now** and what **must be preserved now**
so the option stays open.

### 1. Catastrophic forgetting

A continuously growing corpus over months or years will eventually overwrite earlier
capabilities. The long-term system needs some form of experience replay.

**Out of scope for Phase 1 and Phase 2.** Do **not** implement "shuffle all historical documents
back into every batch." That is a strategy choice, not a safety mechanism, and it would silently
multiply training cost by a factor nobody has measured. The eventual mixture will be
configurable and experimentally measurable, and something like:

```
new material
+ historical replay
+ mission-focused material
+ under-represented curriculum areas
```

**What must be preserved now** — cheap, and irreversible if skipped:

- **Consumed article provenance must stay recoverable.** Never make it unrecoverable.
- **The dataset store must not be write-once-discard.** Historical training material must remain
  addressable after consumption.
- **Historical datasets must be reconstructable**, ideally byte-for-byte. This is the binding
  constraint, and it is easy to violate by accident: article IDs alone are not enough, because
  replay must reproduce the *token stream*, not just the source text. The train state must
  therefore record the packing parameters, sequence length, tokenizer identity, and the content
  hash of every consumed article. See [What train state must record](#what-train-state-must-record).
- **Every brain version must record which articles contributed to it.**

**Open research questions, deliberately unanswered until the perpetual phase:** how much
historical data to replay; how to sample it; how to detect forgetting; how to weight new versus
historical data; and how the optimal strategy changes as the corpus reaches millions of articles.

### 2. Loss instability

**Out of scope for Phase 1: tuning.** Do not hard-code a universal learning rate such as `1e-4` or
`3e-4`. The correct value depends on optimizer, effective batch size, sequence length, model size,
scheduler, warm-up, gradient behaviour, and objective. Committing to a constant now would be
cargo-culting a number that is wrong for the 3B configuration.

**In scope for Phase 1: instrumentation and protection.** Phase 1's job is not a good loss curve,
it is a *visible* one. Required:

```
learning rate logging        gradient norm logging
training loss                validation loss
NaN / Inf detection          gradient clipping
loss-spike detection
```

**Required failure behaviour.** A serious numerical failure must:

```
detect → log → checkpoint or fail safely → leave the active brain unchanged
```

A corrupted training run must **never** be allowed to replace the active brain. This is the
numerical-stability analogue of the promotion rule in
[Known defects](#known-defects) item 1: a model that failed must not win by default.

**Required for later diagnosis:** the full training configuration must be recorded with every
checkpoint, so a future review can correlate an instability episode against the exact optimizer,
schedule, and data configuration that produced it. An instability nobody can attribute is an
instability nobody can fix.

### What train state must record

The intersection of both risks. Satisfying it is Phase 1 work (check 5), and it is what keeps
replay *possible* without implementing replay:

| Field | Why |
|---|---|
| content hash of every consumed article | replay needs the exact text, not just an ID |
| article IDs consumed, per run | the contribution record for each brain version |
| dataset identity, version, hash | reconstruct and verify a historical set |
| packing parameters, sequence length, block strategy | replay must reproduce the token stream |
| tokenizer identity and hash | a different tokenizer means a different corpus |
| optimizer name and all hyperparameters | attribute instability |
| learning rate, schedule, warm-up, clipping | attribute instability |
| effective batch size, gradient accumulation | attribute instability |
| seed and RNG states (Python, NumPy, torch CPU + CUDA) | exact resume |
| step, tokens seen, wall time | throughput and budget extrapolation |
| library versions (torch, transformers, CUDA) | reproducibility across machines |
| model tensor hashes | verify the starting point was what we think |

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
9. **A failed or corrupted run never replaces the active brain.** Numerical failure, a lost
   process, or a crash mid-run must leave the previous brain serving. Detection, logging, and
   safe checkpoint-or-fail are Phase 1 requirements.
10. **Consumed training material stays reconstructable.** Article content hashes, packing
    parameters, and the per-version contribution record are retained so historical training sets
    can be rebuilt for replay later. Replay itself is a later experiment; losing the ability to
    reconstruct history is not recoverable.
11. **Master weights are fp32, always.** Compute may be bf16; the dtype the optimizer updates may
    not be. With bf16 masters, 17 of 74 parameters receive gradients and then round away to
    unchanged — silently, with a falling loss curve and no error.
12. **There is no default learning rate.** `--lr` is required and `TrainConfig` has no default.
    The right value depends on optimizer, batch size, sequence length, model size, schedule and
    warm-up; a constant in the code would be a number that looks measured and is not. A test fails
    if one is reintroduced.
13. **A resume must not cross a changed corpus or config.** Resume verifies `datasetHash` and every
    config field except `steps`, and refuses if the step target does not advance. Silently
    continuing against different data would make the recorded attribution a lie.

---

## Repository map

```
python/                        compute plane
  sma/configs.py               3B source of truth, derived 62M config, expected counts
  sma/arch.py                  SmolLM3 construction, validation, parameter accounting
  sma/proof.py                 config-only fetch, AST audit, tensor hashes, loss signature
  sma/store.py                 immutable versions, atomic commit, durability, heartbeat
  sma/data.py                  ingestion, content hashes, concatenate-chunk packing, split
  sma/train.py                 precision model, guards, instrumentation, resumable train state
  sma/brain.py                 CLI and the one-JSON-object subprocess contract
  sma/fixtures/tiny_en.txt     deterministic corpus (original prose — no licensing question)
  tests/                       57 pytest tests (32 proof/init, 25 training/check-7)

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
