# EXPERIMENT-DESIGN — Controlled 62M Learning Experiment v1

**Status:** designed, implemented and tested; **candidate training not started**.
**Experiment ID:** `953dce2c738110c44445e2c32889e8173055de5625757cd5cded0dc6a74d50dc`
**Experiment manifest:** `EXPERIMENT-MANIFEST.json` (SHA-256 `eee153dc888f3aefa0f4f4e272a8912265957c9a1bb7b34161efb3a371510c0d`)
**Isolated workspace:** `/home/dave/sma-experiments/controlled-experiment-20261030T230000Z`
**Frozen corpus:** `/home/dave/sma-experiments/prospective-rebalanced-20261030T224516Z`
**Corpus manifest SHA-256:** `44fd36ae0ddb1378023e26c299dd16f6d74d9d3d1162e44462e47c863fde6e35`

## 1. Primary hypothesis

**H1:** Continuing training of the randomly-initialised v389 student on the frozen, source-disjoint training corpus will produce a material improvement on the frozen prospective validation corpus, relative to the unchanged parent, without a material generation-quality or retention regression.

This is a **narrow controlled learning test**, not a claim of broad language capability. The corpus is ~0.78M training tokens for a 62M-parameter model; it cannot support a broad pretraining claim.

### Outcome hierarchy

| Layer | Primary measure | Not sufficient alone |
|---|---|---|
| Optimisation/training progress | Training-corpus loss | Reduced training loss is not proof of learning |
| Generalisation | Prospective validation loss, paired by source/document | A single aggregate validation number |
| Retention/regression | Per-source validation regressions; train/validation gap; generation | Training loss decrease |
| Generation capability | Fixed-prompt generation metrics and samples | Next-token loss |

## 2. Frozen inputs

| Input | Identity |
|---|---|
| Parent | v389, model SHA-256 `4ca50873039fa3d0f5af92fc004c368e6a5c40c33a5122b05b337e98627627ff` |
| Parent weight fingerprint | `a2aa77c0c3efb6b59fea452e206d7e3cc02a5f22a60d4db4527869f338db92a9` |
| Parent lineage | RANDOM-rooted; `pretrainedWeightsUsed: false`; parentInitialisationType `RANDOM`; v389 itself 8 steps / 4,096 tokens |
| Architecture | SmolLM3ForCausalLM, 8 layers, hidden 384, GQA 3:1, 61,839,744 parameters |
| Tokenizer | Frozen v389 tokenizer, SHA-256 `ab4da6b2aa68247e9c0fa9b97fc7fcc796505038d01f7e144522a65ce0dbd2e5` |
| Training corpus | `corpus/train.jsonl`, 87 docs, 775,434 actual tokens |
| Validation corpus | `corpus/validation.jsonl`, 20 docs, 138,571 actual tokens |
| Split | `document-source-disjoint-v1`, seed 20261030, split hash `603e0260d481a4b0ab21b7b29a975cfcb97fe5262f58d2a5a795b2250dd7ab5a` |
| Validation protection | Prospective-only, source-disjoint, cluster-disjoint, zero exact/normalised hash overlap |
| Historical screening | 128 cleaned docs, all `NO_HISTORICAL_MATCH` against 19,719 production articles |
| Execution runtime | Actual X1 Pro runtime: Python 3.14.4, Torch 2.12.0+rocm7.14.0, ROCm, gfx1150, AMD Radeon 890M, Node v22.22.1 |
| Evaluation runtime | CPU test venv: Torch 2.14.1+cpu, Transformers 5.20.0, Tokenizers 0.23.3 |
| Runtime fingerprint | Captured by `runtime-fingerprint` in `EXPERIMENT-MANIFEST.json`; both execution and evaluation runtime have separate fingerprints |
| Trainer code | Content fingerprint in `EXPERIMENT-MANIFEST.json` |

The parent copy in the experiment workspace was made from the production v389 directory and verified by re-hashing its `model.safetensors`. No production checkpoint was modified.

## 3. Training protocol

| Setting | Value | Rationale |
|---|---|---|
| Sequence length | 128 | Existing model/context/tooling; matches validation evaluation |
| Micro-batch | 2 | Stable for 62M on the X1 Pro; existing default |
| Gradient accumulation | 2 | Effective batch 4, 512 tokens/step |
| Effective batch | 4 | Proven in prior candidate runs |
| Learning rate | 1e-4 | Existing reviewed training config; small model, short run |
| Schedule | Cosine, 10% floor | Stable decay over 3,030 steps |
| Warmup | 150 steps | ~5% of run; avoids early instability |
| Weight decay | 0.01 | Existing AdamW setting |
| Betas | (0.9, 0.95) | Existing config |
| Gradient clipping | 1.0 | Existing stability guard |
| Master dtype | float32 | Required; avoids frozen RMSNorm tensors |
| Compute dtype | bfloat16 (ROCm) | Existing supported path; use float32 on CPU |
| Target epochs | 2 | 3,030 steps, 1,550,868 presented tokens, 775,434 unique tokens |
| Max/min steps | 4,000 / 1,000 | Hard cap and minimum credible run |
| Validation interval | 200 steps | 15 validation points for checkpoint selection |
| Validation blocks | 1,082 | Full frozen validation corpus (138,571 tokens) |
| Checkpoint selection | Best validation loss | Disabled final-step tail; `selectBest=true` |
| Seeds | 17, 29, 43 | Three independent runs for seed-variance evidence |
| Candidate versions | v390, v391, v392 | Isolated store only; no activation |

Data ordering is the existing `torch.randperm` block shuffle seeded by the recorded seed. The exact document/token accounting is recorded in train-state: 87 docs, 775,434 unique tokens, 6,058 training blocks, 1,082 validation blocks.

**Why 2 epochs:** it is enough to test whether the student can acquire measurable signal from the available corpus without turning the experiment into repeated-corpus memorisation. It remains far below a broad-pretraining budget; that limitation is explicit.

## 4. Evaluation protocol

Evaluation uses the frozen corpus only. No final-test material is accessed.

1. **Parent baseline** (already executed, read-only): validation loss, training-corpus loss, per-document and per-source losses, fixed generation quality.
2. **Training-corpus loss** for each candidate: optimisation progress and retention diagnostic.
3. **Prospective validation loss** for each candidate: primary generalisation measure.
4. **Per-document/per-source paired comparison** using the existing token-weighted paired source-group bootstrap (`pairedSourceGroupBootstrap`) with 20 validation source groups and 4,000 resamples.
5. **Seed-level analysis:** report each seed separately; do not treat a document bootstrap as seed-variance evidence.
6. **Generation quality:** fixed 5-prompt, 32-token greedy suite from the existing `generate-quality` path; samples retained. This is diagnostic, not a capability gate by itself.
7. **Retention/regression:** per-source validation regression count; train/validation gap; generation repetition.

Evaluation commands must use the same parent snapshot, tokenizer, sequence length, micro-batch, device type and scoring code for parent and candidates. Candidate evaluation is read-only except for writing evidence files under the experiment workspace.

## 5. Controls and reproducibility

- **Reference control:** unchanged v389, evaluated once and re-used as the parent comparator.
- **Treatment:** v389 + frozen-corpus training, one run per seed.
- **Paired design:** parent and candidate on the same 20 validation documents and source groups.
- **Seeds:** three runs, same protocol, distinct seeds; report all outcomes, not only the best.
- **No tuning loop:** validation is used for checkpoint selection within a run and for the primary comparison; it must not be used to iterate hyperparameters after seeing candidate results.
- **Failure handling:** failed/non-finite/incomplete runs are reported; they are not silently replaced. A failed seed is not counted as success.
- **Validation protection:** no added/removed/reassigned validation documents; no final-test access.
- **Production isolation:** isolated store and workspace; no active pointer, no promotion, no production writes.

## 5.1 Mandatory execution pre-flight

`preflightTraining()` independently verifies immediately before any training:

- corpus manifest and all artifact hashes;
- parent model SHA-256 and weight fingerprint;
- tokenizer hash;
- experiment manifest identity;
- baseline artifact hashes;
- trainer and execution/evaluation runtime fingerprints;
- isolated experiment store path (not `/var/lib/simpleminds` or `/opt/simpleminds`);
- absent `active.json` in the experiment store;
- candidate versions v390/v391/v392 not already present.

Training additionally requires both `EXPERIMENT_ALLOW_TRAINING=1` and `--execute`. A pre-flight failure is fatal; there is no fallback to production or development paths.

## 6. Pre-registered success criteria

The baseline validation group-level 95% half-width is **0.1496 nats** (20 groups, token-weighted; group SD 0.3414). The pre-registered practical material delta is **0.15 nats**. The baseline half-width **motivated** the threshold, but it is not the candidate-versus-parent paired confidence interval: the success decision uses the **paired source-group bootstrap** (`pairedSourceGroupBootstrap`, 20 source groups, 4,000 resamples) for each candidate. The 0.15 threshold is practical/material, not a substitute for that paired CI.

### Success

All of:

- All three expected seeds are present exactly once; no duplicate or unexpected seed.
- Complete validation, training-corpus, paired-bootstrap and generation evidence for every seed.
- At least **2 of 3 seeds** have paired validation improvement ≥ **0.15 nats** and paired bootstrap 95% CI lower bound > 0.
- Median seed improvement ≥ **0.15 nats**.
- No seed has a validation regression < **-0.10 nats**.
- Training-corpus loss improves for every seed.
- Train/validation gap does not increase by more than **0.50 nats** for any seed.
- Generation guard passes for every seed: `meanRep1` not below parent by more than **0.05**, and `maxRun` ≤ **8**.
- No missing/incomplete evidence.

### Inconclusive

- Fewer than 2/3 seeds meet the material threshold, or the paired CI includes zero, or median improvement is between 0 and 0.15.
- Training-corpus loss did not improve for one or more seeds (so success is blocked).
- Evidence is missing, duplicated, unexpected or incomplete.
- Training completed but validation evidence is insufficient.

### Failure

- Median seed improvement ≤ 0.
- Any seed validation regression < **-0.10 nats**.
- Any train/validation gap increase > **0.50 nats**.
- Generation regression on any seed (`meanRep1` < parent - 0.05 or `maxRun` > 8).
- Numerical/stability failure, or an incomplete run that cannot be evaluated.

These thresholds are pre-registered and must not be changed after candidate results are observed.

## 7. What would and would not be demonstrated

**Would be demonstrated by a success:** the student can improve its own next-token prediction on genuinely unseen, source-disjoint English material under this protocol, with seed-level replication and no immediate generation collapse.

**Would not be demonstrated:** broad language capability, factual knowledge, instruction following, reasoning, or performance on an independent final test. Those require larger corpora and the reserved final-test architecture.

## 8. Known limitations

- 775,434 unique training tokens is very small for 61.8M parameters (~0.0125 tokens/parameter over one epoch).
- Parent v389 is only 8 steps / 4,096 tokens beyond its random root; this is a weak baseline.
- Validation has 20 source groups, exactly the minimum for the paired gate; statistical power is limited.
- Validation is used for checkpoint selection and the primary comparison; it is not an independent final test.
- Generation evaluation is five prompts × 32 tokens; it is a degeneration diagnostic, not a broad capability measure.
- Historical screening is lexical; translations and paraphrases remain a limitation.
- Licence evidence is not legal clearance.
- Current trainer has no durable mid-run optimizer checkpoint; an interrupted run restarts from the parent.
