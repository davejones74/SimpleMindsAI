# EXPERIMENT-RESULTS — Controlled 62M Learning Experiment v1

**Overall classification: FAILURE** under the pre-registered decision rule.

**Experiment ID:** `953dce2c738110c44445e2c32889e8173055de5625757cd5cded0dc6a74d50dc`  
**Manifest SHA-256:** `eee153dc888f3aefa0f4f4e272a8912265957c9a1bb7b34161efb3a371510c0d`  
**Isolated workspace:** `/home/dave/sma-experiments/controlled-experiment-20261030T230000Z`  
**Frozen corpus:** `/home/dave/sma-experiments/prospective-rebalanced-20261030T224516Z`

No promotion, activation, production write, corpus change, parent change, final-test access, job/timer/service change, or deployment occurred.

## 1. Execution summary

| Item | Value |
|---|---|
| Parent | v389, model SHA-256 `4ca50873039fa3d0f5af92fc004c368e6a5c40c33a5122b05b337e98627627ff` |
| Candidate versions | v390 (seed 17), v391 (seed 29), v392 (seed 43) |
| Steps per seed | 3,030 |
| Tokens presented per seed | 1,551,360 |
| Unique training tokens | 775,434 |
| Training blocks | 6,058 |
| Validation blocks | 1,082 |
| Validation tokens | 138,571 |
| Sequence length | 128 |
| Effective batch | 4 (2 micro × 2 accumulation) |
| Learning rate | 1e-4, cosine, 150 warmup |
| Precision | bf16 compute, fp32 master |
| Checkpoint selection | best validation loss |
| Device | ROCm `cuda`, AMD Radeon 890M (gfx1150) |
| Python / Torch | 3.14.4 / 2.12.0+rocm7.14.0 |
| Node | v22.22.1 |
| Split hash | `45261838a112ff403ec4060e9d78c46385511512b3808507921ab77028a06cd5` |

All three runs completed without numerical failure. 74/74 parameters changed; 0 buffers drifted in each run.

## 2. Training results

| Seed | Version | Final train loss | Final validation loss | Selected step | Selected val loss | Wall time |
|---:|---|---:|---:|---:|---:|---:|
| 17 | v390 | 5.853805 | 6.435860 | 2,999 | 6.433538 | 991.309 s |
| 29 | v391 | 5.322837 | 6.436619 | 3,029 | 6.436619 | 1,024.441 s |
| 43 | v392 | 5.774154 | 6.435552 | 3,029 | 6.435552 | 986.204 s |

Parent baseline: training loss **8.256554**, validation loss **8.316382**.

Training-corpus loss improved for every seed (all < parent training loss). Validation loss improved by roughly 1.88 nats in every seed.

## 3. Candidate evaluation

Evaluation used the frozen parent/tokenizer/CPU scoring path, per-document, with `--verify-weights`.

| Seed | Version | Candidate validation loss | Candidate training loss | Parent→candidate validation improvement | Paired 95% CI |
|---:|---|---:|---:|---:|---:|
| 17 | v390 | 6.433440 | 5.583021 | 1.885071 | 1.657414..2.130065 |
| 29 | v391 | 6.436486 | 5.578601 | 1.880838 | 1.654734..2.126263 |
| 43 | v392 | 6.435578 | 5.580193 | 1.883084 | 1.659498..2.123140 |

The paired source-group bootstrap (`pairedSourceGroupBootstrap`, 20 validation source groups, 4,000 resamples, token-weighted) is the statistical comparison. All three intervals exclude zero by a wide margin.

## 4. Pre-registered decision outcome

The classifier returned **FAILURE** with reason:

> train/validation gap increased by more than 0.50 nats: 17, 29, 43

| Seed | Parent gap | Candidate gap | Gap increase | Guard |
|---:|---:|---:|---:|---|
| 17 | 0.059827 | 0.850420 | **0.790592** | FAIL (>0.50) |
| 29 | 0.059827 | 0.857885 | **0.798058** | FAIL |
| 43 | 0.059827 | 0.855385 | **0.795557** | FAIL |

Other conditions:

- Seed regression: none.
- Training loss improved: all seeds.
- Generation guard: passed narrowly for all seeds.
- Evidence completeness: all three seeds present, complete.
- Median improvement: 1.883084 nats.
- Successful seeds under the full conjunctive rule: **none**, because the gap guard fails.

This is recorded exactly as pre-registered. The thresholds were not changed after observing results.

## 5. Interpretation

The candidates acquired a large, highly reproducible reduction in both training and prospective validation loss. The paired validation improvement is large and statistically robust on this set.

However, the **train/validation gap expanded by ~0.79–0.80 nats**, well beyond the pre-registered 0.50-nat limit. This is consistent with substantial corpus-specific overfitting/memorisation: the candidate fit the 775k-token training corpus much more tightly than the 20-source validation cohort. The experiment therefore **fails its pre-registered success criterion**, despite the strong validation loss improvement.

This result should not be reported as “the student learned general language.” It should be reported as: the student learned the training corpus strongly, with a large apparent validation gain on the frozen source-disjoint set, but the gap guard classified the result as failure due to overfitting risk.

## 6. Generation comparison

Fixed five-prompt, 32-token greedy generation.

| Version | meanRep1 | meanRep2 | maxRun | meanLength |
|---|---:|---:|---:|---:|
| Parent v389 | 0.300575 | 0.473846 | 4 | 29.2 |
| v390 seed 17 | 0.256250 | 0.316129 | 1 | 32.0 |
| v391 seed 29 | 0.287500 | 0.380645 | 1 | 32.0 |
| v392 seed 43 | 0.343750 | 0.445161 | 1 | 32.0 |

The guard did not trigger: v390 is just above the parent-minus-0.05 bound; all candidates have `maxRun 1`, avoiding the long-run failure. But all outputs remain visibly repetitive/degenerate (e.g., “the same as the same as…”, “the first to the first…”). Generation is not materially improved; it is a weak diagnostic, not evidence of capability.

## 7. Reproducibility

- All three seeds used the same frozen corpus, tokenizer, split hash, parent, protocol and runtime.
- Validation losses were nearly identical across seeds: 6.43344, 6.43649, 6.43558.
- Training losses varied more: 5.8538, 5.3228, 5.7742.
- Selected checkpoints differed slightly (step 2,999 vs 3,029) but selected validation losses were within 0.003 nats.
- The result is reproducible at the level of the paired validation improvement; seed variance is small on this corpus.
- The large gap is not a one-seed anomaly.

## 8. Hardware/runtime

- Execution runtime: Python 3.14.4, Torch 2.12.0+rocm7.14.0, Transformers 5.17.0, Tokenizers 0.23.2, NumPy 2.5.4, safetensors 0.8.0, ROCm 7.14.60850, gfx1150, AMD Radeon 890M, Node v22.22.1.
- Peak GPU allocation: 1,634,137,600 bytes; reserved 1,958,739,968 bytes.
- Peak host RSS: ~2.83 GB per run.
- Evaluation runtime: CPU test venv, Torch 2.14.1+cpu, Transformers 5.20.0, Tokenizers 0.23.3.

The execution and evaluation runtime fingerprints are both recorded in the experiment manifest.

## 9. Failures and interruptions

1. The first shell launch attempt was killed by the tool wrapper before any optimizer step; it left only a stale isolated `v390.lock` with a dead PID. The lock was removed and the actual run started cleanly. No candidate checkpoint was produced by the aborted attempt.
2. The first evaluation attempt failed before scoring because the evaluator subprocess ran from the repository root instead of `python/`. The harness path was corrected and evaluation rerun. No candidate weights or corpus were changed.
3. No candidate training run failed numerically or was silently restarted with changed settings.

No parameter, seed, corpus, parent or threshold was changed.

## 10. Provenance finding

Candidate `provenance.json` records parent weight fingerprint:

`61dbd4c41d4c2c34dfa68b5ecf1706b47d8652861bcf8ee99ac67aa02a37dcb5`

The experiment manifest records parent weight fingerprint:

`a2aa77c0c3efb6b59fea452e206d7e3cc02a5f22a60d4db4527869f338db92a9`

These are different canonicalisations of the same parent `v389` manifest (the Python trainer fingerprint omits the version field included by the Node candidate-identity implementation). The parent model SHA-256 and the pre-flight parent identity matched:

`4ca50873039fa3d0f5af92fc004c368e6a5c40c33a5122b05b337e98627627ff`

This is a provenance-format inconsistency, not evidence that a different parent was used. It should be standardised in a future correction.

## 11. Evidence paths and hashes

Under `/home/dave/sma-experiments/controlled-experiment-20261030T230000Z`:

| Artifact | SHA-256 |
|---|---|
| `candidates/seed-17/evidence.json` | `3c4de4cd78720701a230793f15c87f9a0f6f961590eb44242c3112984ec2bff6` |
| `candidates/seed-29/evidence.json` | `fd965a64d30d4ac847df347236c6af8e2b5cc9247b2cc66794cbba8f2fd50cc3` |
| `candidates/seed-43/evidence.json` | `7f091fa8db733e17a3b77010d422bd2315b5f5e50437854b5e3f22f0fdaf9ba5` |
| `candidates/evaluation-summary.json` | `bbf5c9ebe0ce1fedda1d96966adc7f8ed5746573ac1b7f9ba0d6859d0ab90133` |
| `candidates/decision.json` | `1f132058cde72699dc4c4e8658f6534211c5d4be71eb277b22bfb90038d71ec7` |
| `parent-store/v390/model.safetensors` | `32586a62fe791f66f3f323740178aae56fa5ccea5738de7c0d39c466f7780ce6` |
| `parent-store/v391/model.safetensors` | `84147297a21c8768a7d752cbda8eeafffa983205a67de2c401761839fe1e98e7` |
| `parent-store/v392/model.safetensors` | `edfe6a456efab7154ee5414e3ac87858f49fb62b8d23827784b64d5e95190ce0` |

The manifest and baseline artifacts remain unchanged at the frozen identities. No candidate was promoted or activated.

## 12. Final classification

**FAILURE — pre-registered gap guard violated.**

Demonstrated:

- The student can substantially reduce training and prospective validation loss from the frozen parent under the frozen protocol.
- The validation improvement is reproducible across three seeds and has strongly positive paired bootstrap intervals.
- Generation does not cross the pre-registered regression guard, but remains visibly repetitive.

Not demonstrated:

- Generalisation without material overfitting.
- Broad language capability.
- Retention or production readiness.

The correct next action is not to promote or start a larger training run automatically. The evidence points to a data-scale/generalisation limitation: 775k unique training tokens are insufficient to separate genuine generalisation from corpus-specific fitting. A new pre-registered experiment with substantially more data (and/or stronger regularisation) is required; this experiment must not be retuned in place.
