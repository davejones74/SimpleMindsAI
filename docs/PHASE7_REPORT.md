# Phase 7 validation report

This article is the Phase 7 gate: the final pre-deployment validation of
continuous bounded operation, crash and failure recovery, held-out evaluation
integrity, promotion-gate correctness, chart honesty, critic quality, and
resource readiness. It records what was changed, what was measured, and — in a
separate section — what was **not** proven.

It is aimed at reviewers and operators. For the system model see
[ARCHITECTURE.md](ARCHITECTURE.md); for the proof obligations see
[PROOF.md](PROOF.md); for the measured behaviours that shaped the design see
[FINDINGS.md](FINDINGS.md).

## Contents

- [Scope and acceptance criteria](#scope-and-acceptance-criteria)
- [Environment](#environment)
- [Defects found and fixed](#defects-found-and-fixed)
- [Test evidence](#test-evidence)
- [Critic-temperature experiment](#critic-temperature-experiment)
- [Resource readiness](#resource-readiness)
- [What this does NOT prove](#what-this-does-not-prove)
- [Recommendation](#recommendation)

---

## Scope and acceptance criteria

Phase 7 had to demonstrate, on the development machine:

- crash/restart recovery at every lifecycle boundary — especially **after
  promotion, before consumption is committed** — proving idempotent recovery, no
  double consumption, the correct published version, and truthful run status;
- no-progress and repeated-rejection safeguards in the **actual worker
  lifecycle**, not merely as config flags;
- preserved resume and cancellation behaviour;
- training loss, in-training validation loss, and frozen-eval metrics stay
  distinguishable, and missing stays missing;
- the frozen-dev evaluation set is provenance-recorded and cross-signature
  comparisons are refused;
- the active store is never mutated by a read-only inspection;
- a critic-temperature experiment, recorded with the effective model, prompt and
  rubric versions and the parsing outcome;
- rejected candidates are never published and the active model is never deleted.

Non-negotiable throughout: the student is randomly initialised, **no pretrained
neural weights** are ever loaded, and no safeguard or threshold was weakened to
make a test pass.

## Environment

- Windows, RTX 4090; Node v24.18.1; Python 3.14.6 in `python/.venv`.
- torch 2.14.0+cu130, `torch.cuda.is_available()` True.
- Ollama `0.40.3` at `http://localhost:11434`; critic model
  `ssfdre38/gemma4-turbo:e4b` (digest `9d0719003cc9…`, matching
  `OLLAMA_MODEL_DIGEST`).
- Live store `C:\Users\sneak\.sma\store`: versions `v001`–`v034`, `active.json` =
  `v032`. Inspected **read-only**.

## Defects found and fixed

Each defect below was measured before it was fixed. The general lesson recorded
in [FINDINGS.md](FINDINGS.md) applies to all of them: a number or status that is
*nearly* right is worse than one that is absent, because it reads as evidence.

### F1 — the training-loss chart was dishonest

One shared y-axis mixed three incomparable series on `v034`: training loss
(`0.2866→2.3377`), in-training validation loss (`3.0388→3.4494`), and 39
frozen-eval markers (`4.7386→10.6877`). Validation occupied **3.9 %** of the
242 px plot. `mergeChain` unioned points by `step` alone, so two lineages that
shared a `datasetHash` silently overwrote each other.

Fixed in `src/admin/metrics.js` and `src/admin/public/app.js`: `mergeChain`
applies a per-segment `stepOffset` and returns `collisions`; a new
`computeChartScales` produces separate left (in-run train + held-out validation)
and right (frozen eval-set) axes, padding degenerate ranges and ignoring
non-finite marker losses; the SPA draws the two axes and shows a
`⚠ N step(s) overlap` warning when collisions are non-zero.

### F2 — restart after `decision:"promoted"` failed

`lifecycle.js` read `trainerResult?.version ?? savedManifest.resultVersion`, but
`resultVersion` was never written, so a process that restarted after promotion
but before consumption could not name the candidate. The manifest now records
`resultVersion`, `resultParentVersion` and `resultModelId`, and the recovery
sweep **fails closed**: a promoted manifest with no candidate version is left for
inspection rather than falsely reported recovered.

### F3 — the promotion gate compared dataset hashes, not metrics

`decidePromotionByLoss` compared only `datasetHash`, and
`data/registry/evaluations.ndjson` was 0 bytes (never written on the Python
path), so a parent and candidate evaluated with different sequence length,
micro-batch, metric, strategy or compute dtype could be compared as if
equivalent. A frozen evaluation set also topically overlapped the crawl set.

`evaluateVersionLoss` now returns a `metricSignature` (sha256 of
`{metric, strategy, datasetHash, tokenizerHash, sequenceLength, microBatch,
computeDtype}`). `decidePromotionByLoss` requires signature equality when both
sides present it and falls back to `datasetHash` only when neither does; a
mismatch is `not_evaluated` with reason `parent and candidate metric signatures
differ`. A non-enforcing `EVAL_MIN_DOCUMENTS` (default 0) was added, and the
frozen-set provenance is persisted and hashed (`python/sma/store.py`,
`python/tests/test_eval_record.py`).

### F4 — silent churn on repeated rejection / no progress

Runs `run-46`…`run-52` all staged `v035` and were rejected with no backoff and no
visible failure. The job supervisor now surfaces both stalls: training logs the
`repeated-rejection` phase after `TRAIN_MAX_CONSECUTIVE_REJECTIONS` (then resets the
counter and keeps waiting — continuous training is perpetual and never stops on
rejections; rejected runs consume their batch, so new cycles only see new material),
learning raises `no-progress` after `LEARNING_NO_PROGRESS_CYCLES`, and both honour an
optional `JOBS_MAX_RUNTIME_MS` (`max-runtime`). Only genuinely acquired (`ingested`)
material counts as progress; deduped events do not.

### F5 — the run-lock is not the recovery mechanism

The Node `RUN.lock` still goes stale after 10 minutes (a known defect, unchanged
here). Recovery is driven by re-reading the registry and manifests, not by the
lock, so a stale lock cannot cause a double promotion.

### F6 — the critic fixture could not score, and a missing score became a 5

Fixture detection looked for `/reward model/i`, which the current `CRITIC_PROMPT`
does not contain, so the fixture returned a generic hit: raw score `5`, verdict
`uncertain`. Separately, a missing or unparseable critic reply was coerced to a
neutral `5`. The fixture now detects the critic by markers that exist in the
prompt and returns a real scored reply (raw `6.5`, verdict `approve`); a
missing/unparseable reply **stays missing** and fails closed to `uncertain` at
score `0` with `criticScoreMissing` and `criticError` recorded. Reviews now
persist `criticTemperature`, `criticPromptVersion`, `criticScoreMissing` and
`criticError`.

### F7 — `cmd_train` referenced the run id before assigning it

`python/sma/brain.py` allocated the version with
`store.allocate_version(root, run_id=node_run_id)` **before** the line that
defined `node_run_id`. On the normal Node-orchestrated path no `--version` is
supplied, so the right-hand side was evaluated and raised
`UnboundLocalError: cannot access local variable 'node_run_id'` before a single
weight was built — every one-shot and continuous Python-backed training run
failed this way (observed as `job-28 failed training · continuous`). Fixed by
validating the run id first, then passing it to the allocator. Regression test:
`python/tests/test_init_and_proof.py::test_cmd_train_validates_run_id_before_allocating`.

## Test evidence

Both suites were run on the development machine. The commands are exact; the
counts are the observed reporter output.

| Suite | Command | Result |
|---|---|---|
| Node data plane | `$env:SMA_SKIP_ENV_FILE="1"; $env:SMA_ENV_FILE="$env:TEMP\sma-test.env"; node --test` | **221 tests, 221 pass, 0 fail, 0 skipped** |
| Python compute plane | `python -m pytest -q` (from `python/`, in the venv) | **exit 0**, 194 tests (72 + 72 + 50) |

New Node coverage added in Phase 7 (+28 tests over the 193 baseline):

- `test/eval-gate.test.js` — `metricSignature` determinism and field
  sensitivity; promote on identical signature; reject on differing signature;
  legacy `datasetHash` fallback; one-sided fallback; non-finite fail-closed.
- `test/critic.test.js` — fixture critic real score and verdict; review
  provenance; non-JSON and throwing critic fail closed; a JSON reply without a
  numeric score stays missing.
- `test/jobs-resilience.test.js` — continuous training surfaces the
  `repeated-rejection` phase but keeps running; `max-runtime`; and `no-progress`
  driven through the real supervisor loop.
- `test/lifecycle-crash.test.js` — promoted-unconsumed recovery; crash after
  publish; rejected never publishes/activates but consumes; consumed manifests
  are terminal; F2 promoted-without-version fails closed; an in-process crash
  before the consumption commit is re-driven with exactly one activation.
- `test/metrics.test.js` additions — `computeChartScales` degenerate/empty/
  non-finite handling; `mergeChain` `stepOffset` separation and collision count.

New Python coverage: `python/tests/test_eval_record.py` (frozen-eval provenance
payload complete and hashed, deterministic, datasetHash changes on mutation) and
`python/tests/test_retention.py` (prune and prune-runs dry-run/confirm/retention
semantics).

The Python `-q` reporter suppresses the trailing "N passed" summary line in this
environment; the run is reported as **exit 0 with 194 dots**. This is the
reporter's behaviour, not a skipped or errored run.

## Critic-temperature experiment

`CRITIC_TEMPERATURE` reaches the provider, but provenance previously recorded
only `criticModel` / `criticVersion` / `rubricVersion`. The experiment scored a
fixed six-article set — four legitimate articles plus a degenerate-repetition
control and a boilerplate control — at temperatures `0.0`, `0.2` and `0.5`, three
repetitions each (54 calls), against the production critic.

Effective configuration recorded with the run:

| Field | Value |
|---|---|
| model | `ssfdre38/gemma4-turbo:e4b` |
| `criticPromptVersion` | `critic-prompt-v1` |
| `criticVersion` | `critic-v1` |
| `rubricVersion` | `rubric-v1` |
| configured `CRITIC_TEMPERATURE` | `0.5` |
| fixture | `false` (real model) |
| endpoint | `http://localhost:11434` |
| total calls / wall time | 54 / 169 s (≈ 97 s first call incl. model load, ≈ 3 s warm) |

Results — verdict stability and score spread per temperature:

| temp | legit raw range | control-degenerate | control-boilerplate | verdict flips | parse failures |
|---|---|---|---|---|---|
| 0.0 | 9.0–9.8 → approve | 0.0 → uncertain | 1.5 (spread 0) → uncertain | 0 | 0 |
| 0.2 | 9.2–9.8 → approve | 0.0 → uncertain | 1.5–2.5 (spread 1.0) → uncertain | 0 | 0 |
| 0.5 | 9.2–9.7 → approve | 0.0 → uncertain | 0.5–2.5 (spread 2.0) → uncertain | 0 | 0 |

All 54 calls parsed; **every article's verdict was identical across the three
repetitions at every temperature**. The critic separated legitimate content
(approve) from both controls (uncertain) at all three temperatures. The only
temperature effect observed is run-to-run variance on the boilerplate control
(raw spread 0.0 at `0.0`, 1.0 at `0.2`, 2.0 at `0.5`).

**Decision: retain `CRITIC_TEMPERATURE=0.5`.** The load-bearing property —
verdict stability, which is what decides eligibility — showed no flips, and the
sample is too small (one borderline control, six articles) to call the variance
difference conclusive. Per the pre-registered rule, an inconclusive result keeps
the current value. The variant observation is recorded here so a larger
follow-up can test it deliberately rather than rediscovering it.

## Resource readiness

The store is append-only and the `_runs/` optimizer-moment pickles are the part
that grows without bound. Measured on the live store:

| Measure | Value |
|---|---|
| store total | 24,306.6 MB / 397 files |
| `_runs/` | 15,572 MB / 33 files (≈ 472 MB per version) |
| exports | 252.5 MB |
| reclaimable by `prune-runs` (dry run) | **14,844,019,474 bytes ≈ 14.84 GB** (30 files) |

`prune` and `prune-runs` are **dry run by default** and delete nothing without
`--confirm`. The dry run above removed nothing. The active version (`v032`) and
the two most recent (`v033`, `v034`) are always retained; only
`_runs/*.train-state.pt` blobs are ever in scope for `prune-runs` — never a
published version, weight file, or record. Every executed prune and prune-runs
appends a durable record to the store's prune log.

## What this does NOT prove

Stated plainly so it is not mistaken for evidence:

- **Nothing here was measured on the X1 Pro.** Every result is from the RTX 4090
  development machine. The ROCm/APU-specific risks (torch pin tied to the host
  ROCm release, `bitsandbytes` 8-bit Adam being CUDA-only, the 890M being an APU
  with shared carve-out rather than dedicated VRAM) remain **untested on the
  target host**. See [DEPLOYMENT.md](DEPLOYMENT.md#operational-requirements).
- **3B is not exercised.** The 3B preflight budget is designed and the memory
  preflight exists, but no 3B run exists; sharding is designed, not exercised.
- **The critic experiment is small** (six articles, three temperatures, one
  borderline control). It supports verdict stability, not a precise variance
  model.
- **The Node `RUN.lock` staleness is unchanged** (known defect). Recovery does
  not rely on it.
- The Python `-q` summary line is suppressed in this environment; the pass count
  is reported from exit code and dot count.

## Recommendation

Phase 7 is **green on the development machine**: 221/221 Node tests and 194
Python tests pass; crash-recovery, the promotion gate, chart honesty and the
critic all met their acceptance criteria; the active store was never mutated.

Before deploying to the X1 Pro, do the following **on that host**:

1. Run `python -m sma.brain preflight --config 3b` and confirm the ROCm backend
   reconciles against the resume-parity check; treat the memory budget as an
   operator decision, not a pass/fail.
2. Re-run the critic experiment on the target-host model, because the effective
   model and prompt are the load-bearing inputs.
3. Reclaim space with `python -m sma.brain prune-runs` (dry run first, review the
   proposed deletions and bytes, then `--confirm`); the development store alone
   has ≈ 14.84 GB of reclaimable resume state.
4. Keep the live store on a durable volume and never run the read-only admin
   views against a writable handle.
