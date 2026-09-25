# SimpleMindsAI — prototype boilerplate

An experimental **autonomous, self-improving text-generation loop** oriented around a small
model trained piecemeal on consumer hardware. This repo is the Node.js data plane: harvest →
curate → buffer → plan → stream → (train) → chat, with the trainer deliberately left as a
swappable stub (the honest recommendation is a PyTorch/ONNX backend, see below).

## Architecture

```
 SUBSYSTEM A (harvest & ingest)              SUBSYSTEM B (plan)
 ┌──────────────┐   ┌──────────────────┐     ┌────────────────────┐
 │ crawler.js   │──▶│ curator.js       │     │ planner.js         │
 │ raw blobs    │   │ deepseek-r1 via  │     │ reads stats +      │
 │  (placeholder)│  │ Ollama -> pairs  │     │ domain diversity,  │
 └──────────────┘   └────────┬─────────┘     │ asks LLM for a     │
                             │ GraphQL        │ balanced curriculum│
                             ▼                └─────────┬──────────┘
 ┌────────────────────────── GraphQL buffer ◀───────────┘  (advisory:
 ── transient (purgeable) ──▐ Prompt ▐ Completion ▐ RewardScore ▐
 ── durable ────────────────▐ TrainingLog ▐ trained marks ▐      ┘
 └────────────────────────────▲───┬────────────────────────────────┘
                              │   │ consumeBatch (untrained only) + commitConsumption
SUBSYSTEM C (train & chat)   │   ▼
 ┌───────────────┐  ┌──────────────────────┐  ┌──────────────────┐
 │ cli/train.js  │──│ dataset/snapshot.js  │──│ trainer-interface │
 │ CLI runner    │  │ immutable .jsonl     │  │ stubTrainer()    │
 │               │  │ freeze + leak guard  │  │ (backprop seam)  │
 └───────────────┘  └──────────────────────┘  └──────┬───────────┘
 │                                                   │ synthetic targets
 ┌───────────────┐  ┌──────────────────────┐          │ (high score, origin
 │ chat-server.js│──│ brain.js  ◀───────▲──┘          ▼
 │ chat UI       │  │ respond() seam     │   reward-scorer.js  (critic)
 └───────────────┘  └───────────────────┘   judges completions → RewardScore
                     evaluation-set.js       curriculum/validation.js
                     (frozen eval set)       (deterministic plan gate)
                     registry-store.js (durable checkpoints, RUN.lock)
 ```

* **Transient:** Prompt / Completion / RewardScore live in `data/buffer/` and are safe to
  purge (`purgeBuffer` mutation) once trained — that's the conveyor belt.
* **Durable log:** `TrainingLog` records `runId`, start/finish dates, the dataset refs
  (prompt ids) consumed, and metrics. Trained marks (which prompt → which run) are also
  append-only durable, so a crash after training never trains the same rows twice.
* **Registry (Phase 2):** `data/registry/` is an append-only NDJSON ledger of models,
  dataset snapshots, training runs, run events and evaluations. A `RUN.lock` guarantees
  exactly-once run commit (lifted only after training + eval succeed — crash-safe).
* **Snapshots & evaluation (Phase 2):** training never reads the live buffer. Each run
  freezes an immutable, hash-sealed `dataset-*` snapshot plus a frozen eval set
  (pair-hash guard prevents eval set leakage into training data).

## Quickstart (no GPU required)

```bash
npm install

# 0. Verify the whole data plane (24 node:test tests, no GPU/Ollama needed)
npm test

# 1. GraphQL buffer (subsystem hub)
npm start                    # http://localhost:4000/graphql

# 2. Seed the buffer end-to-end with FIXTURE mode (zero Ollama/VRAM):
#    in another terminal:
$env:OLLAMA_FIXTURE="true"; $env:OLLAMA_MODEL="deepseek-r1:8b"; npm run crawl
npm run curate               # pipes sample raw docs -> ollama(clean) -> buffer

# 3. Let the AI planner (Subsystem B) look at buffer health
npm run plan                 # LLM is advisory — outcome must pass the deterministic gate

# 4. Train (placeholder backprop) — snapshots untrained rows, runs the full
#    evaluate->train->evaluate->promote/reject lifecycle, streams the report
npm run train

# 5. Chat with whatever brain is loaded
npm run chat                 # http://localhost:8787
```

One-shot lifecycle CLIs (all talk to the registry directly, no server needed):

```bash
npm run train      # one full run: snapshot -> baseline eval -> train -> candidate eval -> promote/reject
npm run evaluate   # measure only — evaluate the active model, decide nothing
npm run promote    # evaluate the active model, then promote it (explicit apply)
npm run reject     # force-reject a run (e.g. bad checkpoint, no checkout back)
npm run perpetual  # server-free autonomous loop: curate->score->train->report, repeat
                   #   PERPETUAL_CYCLES=n  (default 1)   OLLAMA_FIXTURE=true for CI
```

With **real Ollama** installed you can skip fixture mode:
`$env:OLLAMA_MODEL="deepseek-r1:latest"` (whatever `ollama list` shows — on consumer
rigs `:latest` is a 4-7GB distill, not the 671B MoE). Score completions with `npm run score`.

**Bring-up notes (verified live, not theorized):**

* `deepseek-r1` counts its **hidden chain-of-thought against `num_predict`** — a tight
  cap burns the budget on reasoning and returns an **empty** answer. This client omits
  `num_predict` unless you explicitly pass `maxTokens`. Do not re-add a small cap.
* The model is loose about JSON shapes: array, single object, or `{"results":[...]}`.
  `OllamaClient.#parsePairs` normalizes all three.
* One curation call ≈ 5-15s on a consumer box — the LLM cleaning stage is your real
  throughput bottleneck, not the buffer or the trainer.

## The three subsystems

| Subsystem | Files | Role |
|---|---|---|
| A — harvest/ingest | `harness/crawler.js`, `services/curator.js`, `chat/synthetic-feedback.js` | crawl raw text → deepseek-r1 cleans it into `{prompt,completion,domain}` pairs → GraphQL buffer; high-scoring chat completions re-enter as synthetic |
| B — plan | `services/planner.js`, `curriculum/validation.js` | reads buffer *measurements*, asks the LLM for a balanced curriculum, passes it through a deterministic validation gate (LLM is advisory only); falls back to a balanced default plan |
| C — train & chat | `training/*`, `dataset/*`, `storage/*`, `cli/*`, `brain/brain.js`, `chat/*`, `reward/*` | immutable snapshot + frozen eval set → baseline eval → train (stub seam) → candidate eval → promote/reject → durable registry |

## Phase 2: the perpetual training loop

The honest-to-god training loop, without the hand-waving:

```
  registry-store (data/registry/)
  ├─ model-events   (append-only)     run-events (append-only)   snapshots
  ├─ evaluations    (baseline + candidate per run)
  ├─ RUN.lock       (exactly-once run commit)
  └─ models.json    (base/result checkpoints, current = `activeModel`)

  one run (training/lifecycle.js: executeFullRun):
    recover stale runs → acquire RUN.lock
    → freeze eval set (evaluation-set.js, pair-hash leak guard)
    → collect rows from buffer → build immutable snapshot (snapshot.js,
      synthetic cap default 20%, lowest-reward dropped FIRST, reasons recorded)
    → plan.cursor = validateCurriculum(planner plan) || fallbackCurriculum
    → createRun → baseline eval vs frozen eval set
    → trainer.train(snapshot file, checkpointDir)   [stubTrainer: safe seam]
    → registerModel(result) → candidate eval
    → decidePromotion: same-score thresholds produce tidy PROMOTED/REJECTED;
      missing/broken eval => not_evaluated, NO promotion
    → markConsumed (buffer rows→run, AFTER success) → runEvent → completeRun
```

The report each run prints looks like:

```
TRAINING RUN run-1
  status        promoted    dataset dataset-20260925-001 v-6870a86d
  baseModel     model-1     resultModel model-2      critic deepseek-r1  critic-v1/rubric-v1
  curriculum    curriculum-v1  general:3 factcheck:3 trainer stub vstub-v1
  baseline      eval-1  0.0   trained   eval-2  0.0   delta 0.00  decision PROMOTED
  checkpoint    data/models/run-1/checkpoint.json
```

Phase 2 invariants (do NOT break these):

1. **Never promote without an evaluation.** `decidePromotion` needs both a baseline and a
   candidate score; anything missing ⇒ `not_evaluated`, and the CLI refuses to apply.
2. **Never train from the live buffer.** The trainer reads the frozen snapshot file only;
   rows are marked trained via `markConsumed` *after* the run records success.
3. **The LLM plan is advisory.** Any plan must survive `validateCurriculum`; on failure the
   run proceeds with `fallbackCurriculum`. A malformed LLM plan can not stall the loop.
4. **Cap synthetic data.** `MAX_SYNTHETIC_SHARE` (default 0.20) caps synthetic rows in a
   snapshot and drops the lowest-reward synthetic first. Remove the cap and the loop
   becomes an echo chamber.
5. **The eval set never leaks.** Snapshots and the eval set are frozen and hash-sealed at
   run start; the pair-hash guard refuses rows that appear in both.

## Where the real trainer plugs in (read this before you write kernels)

The Node process should stay the **data plane**, not the compute plane:

1. `dataset/snapshot.js` freezes an immutable NDJSON run file
   (`data/snapshots/<datasetId>.jsonl`, one row per line with `prompt/reward/domain/origin`)
   and `storage/registry-store.js` records the run back to the durable ledger.
2. Point a **Python/PyTorch worker** at that snapshot file (or consume the GraphQL cursor
   loop directly). It owns the GPU; Node never tokenizes or backprops.
3. The worker reports `avgLoss/avgReward/recordsTrained` via `recordTrainingRun` so the
   durable TrainingLog stays the single source of truth. The `stubTrainer()` behind
   `training/trainer-interface.js` writes `run-<id>/checkpoint.json` and is the safe seam
   for the real backend.
4. High-scoring *synthetic* completions from the chat brain re-enter the buffer through
   `ingestCompletion(origin: "synthetic")`; the snapshot respects the config
   `MAX_SYNTHETIC_SHARE` (default 0.20), or the loop becomes an echo chamber.

## Scaling ladder (the 3B reality check)

Consumer hardware **cannot pre-train a 3B transformer from scratch** in useful time:
3B at Chinchilla-optimal ~2-3T tokens ≈ months-to-years even on an RTX 4090, and fp32
weights+Adam+activations exceed a 24 GB card anyway. Train a **ladder**, not a monolith:

1. **7–42M params** — validate the whole pipeline (this repo's loop) in hours, on CPU/one GPU.
2. **125–180M** — the library-scale "lease was on a public repo" baseline; still days on a 4090.
3. **~700M–1B with QLoRA** — fine-tune from a pretrained base if you must go big quickly.
4. **3B from scratch** — only viable as a distributed cluster project. Treat it as the endgame,
   not the starting gate.

The loop, critic, planner, and chat are all size-agnostic — the ladder is just budgets.

## Known iteration points (Prototype honesty)

- `promptsPage` cursor + trained-filter can skip rows; move to a keyset cursor when the buffer grows.
- GraphQL is an *interface*, not a *transport*; for >100 MB/min through the pipe, the loader's
  JSONL file off-ramp (`streamToFile`) is the real data path — GraphQL drives the cursor.
- Two judges are better than one: the LLM critic saturates/starts hand-waving; pair it with the
  deterministic heuristic and a held-out human-eval set before trusting reward signals.
- No `Subscription` yet — the trainer is pull-based (robust) rather than push-based (fancy).
  Add GraphQL subscriptions for live training progress if the UI wants it.