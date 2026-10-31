# EXPERIMENT-REVIEW — Independent Critical Review

**Reviewed artifact:** `EXPERIMENT-DESIGN.md` + `EXPERIMENT-MANIFEST.json` (experiment `953dce2c738110c44445e2c32889e8173055de5625757cd5cded0dc6a74d50dc`) + implemented harness.
**Review stance:** adversarial; this review does not simply approve the initial proposal.

## 1. Is the corpus sufficient for the intended experiment?

**Finding:** No for broad language capability; yes for a narrow controlled learning test.

- 775,434 unique training tokens for 61,839,744 parameters is ~0.0125 tokens/parameter over one epoch, ~0.025 over two epochs. This is orders of magnitude below a normal pretraining budget.
- The corpus is publisher-diverse but heavily weighted toward OpenStax, Gutenberg, Wikipedia and Python docs; 14 publishers do not imply balanced domain coverage.
- The validation set is 20 documents / 138,571 tokens from 5 publishers. It is suitable for a first signal, not for a broad generalisation claim.
- The experiment must therefore be described as **“can this student acquire measurable next-token knowledge from this corpus?”**, not **“is it a good language model?”**

**Resolution:** retain the experiment, explicitly limit claims, and require an independent final test before any production capability claim.

## 2. Is validation independence adequately protected?

**Finding:** Mostly, but not perfectly for scientific inference.

- Validation is prospective-only, source-disjoint, cluster-disjoint, and has zero exact/normalised hash overlap with training.
- The 0.15-nat threshold was motivated by the baseline validation group 95% half-width (0.1496) but is a **practical material threshold**; the success decision still uses the paired source-group bootstrap confidence interval. The baseline half-width is not the candidate-versus-parent paired CI.
- It is still used for checkpoint selection and for the primary comparison. That is acceptable for a development experiment but makes it a selection set, not an independent final test.
- Reusing it across three seeds is planned and documented; it must not be used to tune hyperparameters after seeing candidate results.
- The historical screening is lexical only; translations and substantial paraphrases could evade it.

**Resolution:** pre-register the protocol and thresholds; do not tune after results; preserve the reserved final test separately; state the lexical-screening limitation.

## 3. Is the training budget meaningful?

**Finding:** Marginal but defensible as a first experiment.

- 3,030 steps × 512 tokens = ~1.55M presented tokens, two epochs.
- Prior 62M candidate evidence suggests ~2,512 steps took ~610s on the X1 Pro; 3,030 steps should be ~12 minutes per seed on the same hardware. Three seeds are feasible.
- More epochs would increase exposure but also repeated-corpus memorisation; two epochs is a conservative first test.
- The minimium-step floor of 1,000 prevents a nominally trained but tiny update from being accepted.

**Resolution:** keep 2 epochs for experiment v1; do not silently extend after seeing underperformance. Any extension is a new pre-registered experiment.

## 4. Can evaluation distinguish learning from memorisation?

**Finding:** Partially.

- Training-corpus loss and validation loss are both measured. A validation improvement that is much smaller than the training improvement is reported as a generalisation gap, not hidden.
- Validation is genuinely unseen and source-disjoint, so a validation improvement is not simple training-set memorisation.
- The classifier rejects success if training-corpus loss fails to improve, if the train/validation gap increases by more than 0.50 nats, if any seed regresses by more than 0.10 nats, or if generation regresses.
- However, with only 20 validation sources and 775k training tokens, the model can still overfit corpus style and topics. The final test is required for stronger claims.
- Generation evaluation is only five prompts × 32 tokens; it detects degeneration, not broad quality.

**Resolution:** require both training and validation evidence; report the gap; treat generation as a diagnostic, not proof; reserve final test for later.

## 5. Will results be reproducible?

**Finding:** Yes at the input level, with caveats.

- Corpus manifest, train/validation hashes, parent model hash, tokenizer hash, protocol, seeds, trainer fingerprint and runtime identity are frozen in `EXPERIMENT-MANIFEST.json`.
- Parent checkpoint is copied into an isolated store and re-hashed.
- Seeds are explicit; hardware/backend is recorded.
- Caveats: non-deterministic GPU kernels may cause small run-to-run differences; the current trainer does not create a durable mid-run optimizer checkpoint.

**Resolution:** record separate execution and evaluation runtime fingerprints; the manifest now records the actual X1 Pro ROCm runtime (Torch 2.12.0+rocm7.14.0, gfx1150, AMD Radeon 890M) and the CPU evaluation runtime (Torch 2.14.1+cpu). Pre-flight fails closed if required runtime information is missing or changes.

## 6. Can the experiment fail safely?

**Finding:** Yes.

- Training is blocked by default (`optionalTrain` refuses without `--execute` and `EXPERIMENT_ALLOW_TRAINING=1`).
- The parent is copied into an isolated store; no active pointer or production registry is touched.
- Candidate versions are isolated and never activated.
- `preflightTraining()` verifies corpus, parent, tokenizer, experiment identity, baseline hashes, trainer/runtime fingerprints, isolated path, no active pointer and candidate-version collisions before training.
- Manifest mismatch, parent mismatch, validation policy mismatch, baseline drift, runtime drift and insufficient validation fail closed.
- Training failures are recorded as failed seeds, not replaced silently.
- The frozen corpus and original pilot are read-only.

**Resolution:** retain all fail-closed checks; no production deployment as part of the experiment.

## 7. Other weaknesses found

1. **Weak parent:** v389 is only 8 steps beyond its random root. A gain mainly demonstrates that additional training beats a barely-trained parent; it is not a comparison against a mature baseline.
2. **Seed variance unknown:** three seeds are the minimum credible set; a positive median with one negative seed is still reported as inconclusive under the pre-registered rule.
3. **Validation power:** 20 source groups is the minimum for the paired gate; the 0.15-nat threshold is based on the baseline group 95% half-width (0.1496) and is intentionally conservative.
4. **Generation suite too small:** five prompts cannot establish broad generation capability; it is only a regression check.
5. **Licence/legal:** evidence is not clearance; redistribution obligations remain unresolved.
6. **Historical screening:** lexical only; no semantic/translation detection.
7. **No final test:** all validation is development material; no independent final-test claim is possible from this experiment alone.
8. **Runtime split:** training is recorded on the X1 Pro ROCm runtime, while baseline/candidate loss evaluation uses the CPU test venv. This is recorded explicitly and must remain consistent for parent and candidate; it is not a hidden substitution.

## 8. Review conclusion

**Conditionally approved for execution as a narrow controlled experiment.**

It is suitable to answer: *does this student acquire measurable, source-disjoint next-token knowledge from this corpus under a reproducible protocol?*

It is **not** suitable to answer: *is the student broadly capable, factually reliable, instruction-following, or ready for production?*

Required conditions before execution:

- Keep all frozen hashes and parent lineage checks.
- Do not change the pre-registered thresholds after seeing results.
- Do not use the final-test corpus.
- Run all three seeds and report every seed.
- Treat generation as diagnostic and preserve samples.
- Do not activate or promote any candidate.
- Do not use production state.

No blocking inconsistency was found in the frozen corpus or parent snapshot. The experiment can proceed to a separate execution authorisation decision.
