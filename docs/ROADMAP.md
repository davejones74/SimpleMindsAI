# Roadmap

This article consolidates the project's phases, completed milestones, current
priorities, longer-term direction, known limitations and unresolved technical
challenges. It distinguishes implemented functionality from work in progress and
from aspirational research directions.

This roadmap records priorities already present in the project. It does **not**
introduce commitments, dates, delivery estimates or new goals.

## Contents

- [Phase map](#phase-map)
- [Current capabilities and completed milestones](#current-capabilities-and-completed-milestones)
- [Work in progress](#work-in-progress)
- [Near-term priorities: the Phase 2 preflight](#near-term-priorities-the-phase-2-preflight)
- [Longer-term direction: Phase 3, perpetual](#longer-term-direction-phase-3-perpetual)
- [Known future problems](#known-future-problems)
- [Known defects](#known-defects)
- [Open research questions](#open-research-questions)

---

## Phase map

Phase numbering was previously ambiguous — the old README used "Phase 2" for the
perpetual loop. The mapping:

- **Phase 0 (this repository's existing Node work)** — the
  harvest/curate/plan/registry loop with a stub trainer. Still the reference for
  the data plane. What the old README called "Phase 2" is Phase 0's internal run
  loop.
- **Phase 1 — 62M proof.** All 12 checks. Proves the lifecycle and the proofs on
  a model cheap enough to iterate on in minutes. Scope: *the machinery can train
  and recover safely.*
- **Phase 2 — 3B.** Repeat checks 1–12 on the official architecture, then an
  empirical memory preflight before any long run.
- **Phase 3 — perpetual.** Years of continuous training. Never caps, never
  resets. This is where the [open questions](#1-catastrophic-forgetting) about
  replay ratios, sampling, forgetting detection, and mixture weighting get
  answered experimentally.

---

## Current capabilities and completed milestones

**Phase 1 is complete at 62M.** Random initialization, atomic commit, the
no-pretrained-weights proof, provenance, real optimization with resumable state,
evaluation, version comparison, and generation are done and tested. Chat is
served by the long-lived Python student worker, and the promotion gate is
causal-LM loss on a frozen evaluation set.

Verified state (see [PROOF.md](PROOF.md) for the checks):

- All 12 Phase 1 checks pass.
- `v001` is committed: 62M params, provenance recorded.
- `v002` is committed: 60 real steps, 74/74 params moved, 2 buffers unchanged.
- The loss gate rejects worse candidates, promotes better ones, and treats
  unevaluable candidates as `not_evaluated`.

The honest caveat on `v002` (memorization of a five-block fixture, not learning)
is recorded in [PROOF.md](PROOF.md#what-v002-does-and-does-not-prove).

**Managed learning lifecycle & Observatory controls (new).** The admin portal now
drives the harvest → curate → review → train → evaluate → promote lifecycle as
durable, observable jobs instead of ad-hoc scripts:

- A single `JobSupervisor` owns learning, training and fresh-brain jobs against
  the one live writable `development` store. Job creation, status transitions,
  progress and output are appended to an append-only log, so history survives a
  restart.
- Jobs are **cooperative-first**: stop signals an abort; the process tree is
  terminated after a bounded grace period, never leaving a partial checkpoint or
  a misrepresented `running` state. Nothing auto-resumes on boot — a job the
  process left non-terminal is reconciled against the actual lifecycle/registry/
  checkpoint state and reported as `interrupted` (or `completed` if promotion
  really committed before the crash).
- Bounded learning performs a single pass and reports **source exhaustion**
  honestly rather than pretending a target was reached; continuous learning polls
  at a configurable interval. One-shot training **refuses below the eligible
  gate** instead of training on nothing; continuous training waits for material.
- Training honours an explicit `parentVersion` resolved **fail-closed** from the
  store; an unknown/inconsistent version is refused, never silently swapped for
  the active pointer.
- Fresh brains are genuinely randomly initialised (no pretrained student
  weights), recorded with source/revision hashes, and registered as an
  **unpromoted** candidate — they never activate themselves.
- Teacher readiness is probed before work starts and reports the actual
  configured Ollama model, availability and (when pinned) digest match; no
  fallback teacher is ever substituted.
- The portal adds a "Learning & Training" tab (teacher readiness, eligibility,
  start/stop, job history + log, fresh-brain creation) and a **shared model-version
  selector** loaded dynamically from the selected workspace's registry. The
  selector is a viewing scope: it is kept strictly separate from the active
  pointer and from a running job's training parent, is persisted per workspace,
  and feeds the metrics/history views.

**Limitations of the above.** The version selector scopes Dashboard/Chat/History/
Trends and the metrics request; the chat endpoint still answers from the serving
checkpoint, so a pinned version is a *inspection* scope rather than a per-version
serving switch. Promoted-model activation remains a separate explicit action.
This milestone was verified on the development machine with the Node and Python
suites and a live server/API smoke test — not on the X1 Pro.

---

## Work in progress

- **Node data-plane hardening.** The authoritative loss gate, the admin
  observability portal, and the student worker are implemented; the known defects
  below are the remaining unfixed items.
- **Publication pipeline.** Content-addressed naming, export/verify-export, and
  the git/durable split are implemented at 62M; sharding for 3B is designed but
  not yet exercised because no 3B run exists.

---

## Near-term priorities: the Phase 2 preflight

Do not attempt 3B training until measured. Budget explicitly for parameters,
gradients, optimizer state, fp32 master weights, activations, CUDA overhead, and
checkpoint write space. The intended design is CPU fp32 master weights with bf16
compute and gradient checkpointing, but this must be **empirically verified on the
actual machine, not assumed**. Adafactor is the fallback if 8-bit Adam plus fp32
masters does not fit. Never silently switch training strategy — if the config
changes, the manifest must say so.

The fp32-master requirement is not hypothetical: see
[bf16 master weights silently freeze 17 parameters](FINDINGS.md#bf16-master-weights-silently-freeze-17-parameters).

The read-only preflight (`python/sma/preflight.py`, exposed as
`python -m sma.brain preflight`) exists to produce this budget before a model is
built or a checkpoint is loaded. It measures the machine and fails closed on the
resume-parity check; everything else is a budget the caller reads and decides on.
The nine preflight checks are platform, bf16, resume parity, run lock, parameter
count, optimizer availability, memory budget, checkpoint write space, and master
dtype.

Phase 2 repeats checks 1–12 on the official 3B architecture. The checks themselves
are defined in [PROOF.md](PROOF.md#the-12-checks-phase-1-gate).

---

## Longer-term direction: Phase 3, perpetual

Phase 3 is years of continuous training across millions of articles. The lineage
is append-only and continuous; review at every 1,000 consumed articles is a
checkpoint, not a cap, and it neither stops training nor resets the brain. The
perpetual loop is where the [open questions](#open-research-questions) below are
answered experimentally.

Experience replay and sophisticated continual-learning algorithms are **out of
scope** for Phases 1 and 2. The architecture must merely stay *open* to them, and
the [dataset-as-ledger design](ARCHITECTURE.md#the-dataset-store-is-a-ledger-not-a-queue)
preserves that option.

---

## Known future problems

Recorded deliberately unimplemented, so the architecture accommodates them
without Phase 1 growing to solve them. Each says what is **out of scope now** and
what **must be preserved now** so the option stays open.

### 1. Catastrophic forgetting

A continuously growing corpus over months or years will eventually overwrite
earlier capabilities. The long-term system needs some form of experience replay.

**Out of scope for Phase 1 and Phase 2.** Do **not** implement "shuffle all
historical documents back into every batch." That is a strategy choice, not a
safety mechanism, and it would silently multiply training cost by a factor nobody
has measured. The eventual mixture will be configurable and experimentally
measurable, and something like:

```
new material
+ historical replay
+ mission-focused material
+ under-represented curriculum areas
```

**What must be preserved now** — cheap, and irreversible if skipped:

- **Consumed article provenance must stay recoverable.** Never make it
  unrecoverable.
- **The dataset store must not be write-once-discard.** Historical training
  material must remain addressable after consumption.
- **Historical datasets must be reconstructable**, ideally byte-for-byte. This is
  the binding constraint, and it is easy to violate by accident: article IDs alone
  are not enough, because replay must reproduce the *token stream*, not just the
  source text. The train state must therefore record the packing parameters,
  sequence length, tokenizer identity, and the content hash of every consumed
  article. See [What train state must record](#what-train-state-must-record).
- **Every brain version must record which articles contributed to it.**

### 2. Loss instability

**Out of scope for Phase 1: tuning.** Do not hard-code a universal learning rate
such as `1e-4` or `3e-4`. The correct value depends on optimizer, effective batch
size, sequence length, model size, scheduler, warm-up, gradient behaviour, and
objective. Committing to a constant now would be cargo-culting a number that is
wrong for the 3B configuration.

**In scope for Phase 1: instrumentation and protection.** Phase 1's job is not a
good loss curve, it is a *visible* one. Required:

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

A corrupted training run must **never** be allowed to replace the active brain.
This is the numerical-stability analogue of the promotion rule: a model that
failed must not win by default.

**Required for later diagnosis:** the full training configuration must be
recorded with every checkpoint, so a future review can correlate an instability
episode against the exact optimizer, schedule, and data configuration that
produced it. An instability nobody can attribute is an instability nobody can
fix.

### What train state must record

The intersection of both risks. Satisfying it is Phase 1 work (check 5), and it is
what keeps replay *possible* without implementing replay:

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

1. ~~**A zero-score model is promoted.**~~ **Resolved for the real brain.**
   Promotion is now gated by causal-LM loss in `src/training/loss-evaluator.js` +
   `src/training/python-promotion.js` (`not_evaluated` on
   missing/invalid/non-finite/incomparable results). The legacy token-F1
   `evaluator.js:111` path still exists but is **supplementary only** and is no
   longer the gate for a real brain version. Regression tests cover reject /
   promote / unevaluable.
2. **`RUN.lock` goes stale after 10 minutes.** Unsuitable for multi-day training.
   The Python `store.py` already provides a heartbeat; the Node side does not use
   it yet.
3. **`dataset/snapshot.js` materializes entire datasets in memory.** Fine for
   thousands of rows, fatal for a million-article corpus. Must become a descriptor
   handoff to the Python worker.
4. ~~**The Ollama/DeepSeek brain fallback still exists** in `brain/brain.js`.~~
   **Resolved.** `brain/brain.js` now talks only to the Python student worker and
   throws if it is unavailable; a regression test fails if Ollama/DeepSeek
   reappear in its code. DeepSeek remains a teacher/critic only.
5. **`TeacherClient` has no `complete` implementation.**
6. **`promptsPage` cursor plus trained-filter can skip rows**; move to a keyset
   cursor as the buffer grows.
7. ~~**The critic fixture cannot approve articles.**~~ **Resolved.** In fixture
   mode (`OLLAMA_FIXTURE=true`) `src/services/ollama-client.js` now detects the
   critic by markers present in the current `CRITIC_PROMPT`
   (`harsh but fair teacher` / `suggestedImportance` / `reviewing a single
   ARTICLE`) and returns a real scored reply (raw score `6.5`, verdict `approve`),
   so fixture-mode `npm run perpetual` reaches training. A missing/unparseable
   critic reply no longer becomes a neutral `5`; it is recorded as missing and
   fails closed to `uncertain` (`criticScoreMissing`, score `0`). Regression
   coverage in `test/critic.test.js`.
8. **Repeated rejection / no-progress loops had no visible failure.** A run that
   kept staging the same candidate version with no improvement, or a learning job
   that made no progress, previously churned indefinitely. The job supervisor now
   fails closed: training raises `repeated-rejection` after
   `TRAIN_MAX_CONSECUTIVE_REJECTIONS`, learning raises `no-progress` after
   `LEARNING_NO_PROGRESS_CYCLES`, and both honour an optional
   `JOBS_MAX_RUNTIME_MS` wall-clock bound (`max-runtime`). Progress is counted
   only from genuinely acquired (`ingested`) material, not deduped events.
   Regression coverage in `test/jobs-resilience.test.js`.

---

## Open research questions

Deliberately unanswered until the perpetual phase:

- How much historical data to replay.
- How to sample it.
- How to detect forgetting.
- How to weight new versus historical data.
- How the optimal strategy changes as the corpus reaches millions of articles.
