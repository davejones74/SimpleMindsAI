# EXPERIMENT-EXECUTION-PLAN — Controlled 62M Learning Experiment v1

**Status:** plan only. Candidate training is not authorised or started.

## 0. Preconditions

1. Separate execution authorisation from Dave.
2. Production timer/job state must remain untouched; the experiment uses only the isolated workspace.
3. Verify the frozen corpus, parent, tokenizer and manifest:

```bash
cd /home/dave/Repositories/SimpleMindsAI
node scripts/experiment-controlled.mjs verify
node scripts/experiment-controlled.mjs preflight
```

4. Confirm the parent baseline artifacts exist and are unchanged:

```bash
sha256sum \
  /home/dave/sma-experiments/controlled-experiment-20261030T230000Z/baseline/parent-validation-eval.json \
  /home/dave/sma-experiments/controlled-experiment-20261030T230000Z/baseline/parent-train-eval.json \
  /home/dave/sma-experiments/controlled-experiment-20261030T230000Z/baseline/parent-generation-quality.json
```

5. Confirm no production write path is used. The experiment parent store is:

`/home/dave/sma-experiments/controlled-experiment-20261030T230000Z/parent-store`

It is a copy of v389, not the production store.

## 1. Resource estimate

Measured/estimated:

- Parent model: 247,367,192 bytes (~236 MiB).
- Optimizer state per candidate: ~472 MiB.
- Three candidate checkpoints: ~708 MiB weights + ~1.4 GiB optimizer state.
- Workspace total expected: ~3–4 GiB, including parent and evidence.
- Required free space: at least **6 GiB**.
- Prior 62M candidate training: 2,512 steps in ~610 s on the X1 Pro ROCm path.
- Planned 3,030 steps/seed: ~12–13 min training per seed, ~37–40 min for three seeds.
- Full validation/training evaluations add overhead; plan **1.5–2.5 hours** total on the X1 Pro, plus human review.
- CPU fallback would be substantially slower and should not use bf16 emulation; the planned protocol assumes the ROCm GPU path.

These are estimates from measured prior runs, not guarantees.

## 2. Execution sequence (after authorisation)

```bash
cd /home/dave/Repositories/SimpleMindsAI

# 1. Re-verify frozen inputs and run mandatory pre-flight
node scripts/experiment-controlled.mjs verify
node scripts/experiment-controlled.mjs preflight

# 2. Confirm the baseline is still valid
node scripts/experiment-controlled.mjs baseline --reuse

# 3. Start the three pre-registered seeds. This is intentionally gated.
EXPERIMENT_ALLOW_TRAINING=1 EXPERIMENT_DEVICE=cuda \
  node scripts/experiment-controlled.mjs train --execute

# 4. Evaluate candidates against the frozen parent baseline
EXPERIMENT_DEVICE=cuda \
  node scripts/experiment-controlled.mjs evaluate
```

The training command creates v390, v391, v392 in the isolated store only. It must not create or change `active.json`, the production registry, the article store, the perpetual timer, or any production checkpoint. `preflightTraining()` is called by `train` and verifies corpus, parent, tokenizer, experiment manifest identity, baseline hashes, trainer/runtime fingerprints, isolation and candidate collisions before any optimizer step.

## 3. Per-run protocol

| Parameter | Value |
|---|---|
| Parent | v389 |
| Candidate versions | v390 (seed 17), v391 (seed 29), v392 (seed 43) |
| Corpus | frozen `corpus/train.jsonl` + `corpus/validation.jsonl` |
| Sequence length | 128 |
| Micro-batch / grad accumulation | 2 / 2 |
| Effective batch | 4 |
| Steps | 3,030 (2 epochs target) |
| Tokens presented | 1,550,868 (expected) |
| Unique training tokens | 775,434 |
| Learning rate | 1e-4, cosine |
| Warmup | 150 |
| Weight decay | 0.01 |
| Grad clip | 1.0 |
| Validation interval | every 200 steps |
| Validation blocks | 1,082 |
| Checkpoint selection | lowest validation loss |
| Precision | bf16 compute, fp32 master |
| Seeds | 17, 29, 43 |

Execution runtime is the actual X1 Pro ROCm runtime (Torch 2.12.0+rocm7.14.0, gfx1150, AMD Radeon 890M, Node v22.22.1). Evaluation uses the recorded CPU runtime (Torch 2.14.1+cpu) for parent and candidates consistently. Both are in `EXPERIMENT-MANIFEST.json`; pre-flight fails if either changes.

## 4. Evidence to preserve

For every seed:

- train-state.json and history/validation history;
- selected checkpoint and selected validation loss;
- parameter-diff.json;
- provenance.json and init-manifest.json;
- candidate validation eval (per-document/groups);
- candidate training-corpus eval;
- generation-quality samples/metrics;
- paired source-group bootstrap inputs/result;
- final decision file.

Store under:

`/home/dave/sma-experiments/controlled-experiment-20261030T230000Z/candidates/seed-<seed>/`

## 5. Interruption and recovery

- The current Python trainer does not durably checkpoint optimizer state mid-run. If a seed is interrupted, do not treat a partial run as resumable.
- Safe recovery: stop, preserve logs, discard any incomplete staged candidate, and rerun that seed from the unchanged v389 parent with the same seed and protocol.
- Do not change the seed, protocol or corpus after a failure without declaring a new experiment.
- If a candidate version already exists, use a fresh experiment workspace rather than overwriting it.
- If the manifest or parent hash changes, stop: this is not the same experiment.

## 6. Stop conditions

Stop immediately and report if any of the following occurs:

- corpus manifest/hash mismatch;
- parent model/weight fingerprint mismatch;
- tokenizer mismatch;
- training/validation overlap or non-prospective validation;
- non-finite loss/gradient or repeated fatal spikes;
- completed steps < 1,000;
- candidate cannot be weight-verified before evaluation;
- generation regression beyond the pre-registered guard;
- any production state change or activation attempt;
- any attempt to access the final-test corpus.

## 7. Decision rule

The pre-registered decision is implemented in `classifyCandidateResults()`:

- **Success:** all three seeds present exactly once with complete evidence; ≥2/3 seeds with paired validation improvement ≥0.15 nats and bootstrap CI lower >0; median ≥0.15; no seed regression < -0.10; training loss improves for every seed; no >0.50-nat gap increase; generation guard passes for every seed.
- **Inconclusive:** missing/duplicate/unexpected/incomplete evidence; training loss did not improve; fewer than 2/3 seeds meet the material threshold; CI includes zero; median in (0, 0.15).
- **Failure:** median ≤0, any seed regression < -0.10, gap increase >0.50, generation regression, or numerical/stability failure.

No post-hoc threshold adjustment is permitted.

## 8. What happens after evaluation

Produce `candidates/evaluation-summary.json` and `candidates/decision.json`. Review the per-seed evidence and generation samples. If success, request separate authorisation for a larger corpus and/or final-test evaluation. If inconclusive/failure, preserve evidence and design the next pre-registered experiment; do not silently retune against the same validation set.

## 9. Explicit stop

This plan does not authorise training. Training requires a separate explicit decision after reviewing the design, review, baseline, implementation and test report. No candidate training has been started.
