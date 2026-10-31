# EXPERIMENT-CORRECTION-REPORT

Corrections applied to the accepted controlled-experiment design without changing the frozen corpus, parent v389, seeds, training budget or pre-registered 0.15-nat threshold. No training was started.

## Finding 1 — Decision classifier was incomplete

**Finding:** `classifyCandidateResults()` did not enforce seed regression, training-corpus improvement, train/validation gap, complete evidence or exact seed accounting.

**Resolution:** replaced the classifier with a full pre-registered decision engine that:

- requires all three expected seeds exactly once;
- rejects unexpected or duplicate seeds;
- treats missing validation/training/paired/generation evidence as incomplete, never success;
- fails on any seed regression < -0.10 nats;
- fails on any train/validation gap increase > 0.50 nats;
- blocks success if training-corpus loss does not improve;
- fails on generation regression (`meanRep1` < parent - 0.05 or `maxRun` > 8);
- requires ≥2/3 seeds with paired improvement ≥0.15 and paired CI low >0;
- requires median improvement ≥0.15;
- returns explicit reasons and per-seed condition details.

**Verification:** `test/experiment-controlled.test.js` now has 21 tests, including success, seed regression, gap regression, generation regression, median ≤0, training-loss failure, fewer than two successes, missing seed, duplicate seed, incomplete evidence and pre-flight. All 21 passed.

## Finding 2 — Statistical threshold wording

**Finding:** the documents could imply that the 0.15-nat threshold *is* the paired candidate-versus-parent confidence interval.

**Resolution:** updated `EXPERIMENT-DESIGN.md`, `EXPERIMENT-REVIEW.md`, `EXPERIMENT-BASELINE.md` and `EXPERIMENT-EXECUTION-PLAN.md` to state:

- 0.15 nats is a **practical material threshold**;
- the baseline validation group 95% half-width (0.1496) **motivated** it;
- the **paired source-group bootstrap** remains the statistical comparison for success;
- the baseline half-width is not the candidate-versus-parent paired CI.

The paired bootstrap method was not changed.

## Finding 3 — Experiment identity and manifest integrity

**Finding:** experiment identity did not include trainer/runtime fingerprints, and the manifest could be regenerated/overwritten without an explicit identity-change record.

**Resolution:**

- `experimentId` now binds corpus/partition, parent, tokenizer, complete protocol, trainer fingerprint, execution runtime fingerprint and evaluation runtime fingerprint.
- `buildExperimentManifest()` verifies parent lineage, corpus integrity and tokenizer identity.
- `manifest` refuses to overwrite an existing manifest when identity or baseline bindings change unless `--allow-identity-change` is explicitly passed.
- Allowed changes are recorded in `manifests/identity-change-*.json` and in the new manifest's `identityChange` field.
- Baseline artifacts are hashed into the manifest and verified against those hashes.

**Verification:** `verifyCorpus()` checks all 13 frozen artifacts and disjointness; `verifyBaselineArtifacts()` fails on changed/missing baseline files; tests cover manifest identity/tampering and baseline drift. New experiment identity:

`953dce2c738110c44445e2c32889e8173055de5625757cd5cded0dc6a74d50dc`

New manifest SHA-256:

`eee153dc888f3aefa0f4f4e272a8912265957c9a1bb7b34161efb3a371510c0d`

## Finding 4 — Null runtime fingerprint

**Finding:** the manifest recorded null Python package and accelerator fields because the probe used the system Python rather than the experiment runtime.

**Resolution:**

- `EXPERIMENT_PYTHON` defaults to the actual X1 Pro venv at `/opt/simpleminds/python/.venv/bin/python` when available.
- Execution runtime now records: Python 3.14.4, Torch 2.12.0+rocm7.14.0, Transformers 5.17.0, Tokenizers 0.23.2, NumPy 2.5.4, safetensors 0.8.0, accelerate 1.15.0, huggingface_hub 1.33.0, backend `rocm`, build `rocm`, backend version `7.14.60850`, architecture `gfx1150`, device `AMD Radeon 890M Graphics`, Node v22.22.1.
- Evaluation runtime is recorded separately as CPU test venv (Torch 2.14.1+cpu, Transformers 5.20.0, Tokenizers 0.23.3) because baseline/candidate loss scoring uses the CPU path.
- `assertRuntimeIdentity()` fails closed if required packages, backend, architecture or device identity are missing.

**Verification:** `EXPERIMENT-MANIFEST.json` now contains non-null runtime fields; pre-flight reports both runtime fingerprints; runtime-incompleteness tests pass.

## Finding 5 — Resolved training configuration

**Finding:** not every material trainer parameter was explicit, and candidate evidence did not record the resolved config.

**Resolution:**

- `buildTrainArgs()` now explicitly supplies: config, parent, version, corpora, learning rate, steps, min steps, sequence length, micro/grad batch, warmup, validation blocks, eval interval, document boundary, validation policy, prospective requirement, grad clip, spike factor/consecutive, min delta, log interval, select-best, seed, compute dtype, device and run id.
- Candidate evaluation reads the candidate `train-state.json` and `provenance.json` and records resolved config, corpus split, steps, tokens, selected checkpoint, parent fingerprint, trainer fingerprint, seed, validation split, corpus files and runtime.

**Verification:** argument-construction tests assert mandatory validation policy and no legacy fallback; decision tests use the resolved evidence. No candidate training was run.

## Finding 6 — Mandatory execution pre-flight

**Finding:** training lacked an independently enforced pre-flight for all frozen inputs.

**Resolution:** `preflightTraining()` verifies immediately before training:

- corpus manifest and all artifact hashes;
- parent model hash and weight fingerprint;
- tokenizer hash;
- experiment manifest identity;
- baseline artifact hashes;
- trainer fingerprint;
- execution and evaluation runtime fingerprints;
- isolated experiment store path;
- absence of `active.json`;
- candidate-version collisions.

`optionalTrain()` calls pre-flight even when training is blocked. Training still requires both `EXPERIMENT_ALLOW_TRAINING=1` and `--execute`.

**Verification:** `node scripts/experiment-controlled.mjs preflight` returns `ok: true`; `node scripts/experiment-controlled.mjs train` returns a blocked plan, not training. Tests cover collisions, production-path rejection, baseline drift, manifest/fingerprint change and runtime failure.

## Finding 7 — Automated tests

**Finding:** missing direct tests for the full classifier and integrity failures.

**Resolution:** added direct tests for all documented decision outcomes and integrity conditions.

**Verification:**

- Full Node suite, single-threaded: **745 tests, 738 passed, 0 failed, 7 skipped**.
- Experiment-specific tests: **21 passed**.
- Focused Python tests: passed.
- `git diff --check`: clean.

## Finding 8 — Restrictions

No candidate training, weight update, promotion, activation, corpus change, parent change, seed/budget/threshold change, final-test access, production job/timer/service change, or production deployment occurred.

## Final status

The experiment is now implementation-consistent and ready for a **separate execution authorisation decision**. Training must not start from this correction report alone.

Remaining limitations are unchanged: small corpus for 62M parameters, weak 8-step parent, 20 validation groups, development-set reuse of validation, small generation diagnostic, lexical historical screening, and no durable mid-run optimizer checkpoint.
