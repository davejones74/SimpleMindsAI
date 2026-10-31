# EXPERIMENT-IMPLEMENTATION — Architecture and Isolation

## Components

| Component | Purpose |
|---|---|
| `scripts/experiment-controlled.mjs` | Isolated experiment CLI: verify corpus/parent, build manifest, baseline, optional training, candidate evaluation, pre-registered decision |
| `EXPERIMENT-MANIFEST.json` | Frozen inputs, identities, protocol, execution/evaluation fingerprints, baseline artifact hashes |
| `python/sma/brain.py` | Existing trainer/evaluator/generation CLI under the experiment store |
| `src/training/loss-evaluator.js` | Existing paired source-group bootstrap |
| `src/training/candidate-identity.js` | Parent, trainer and file fingerprints |
| `src/training/runtime-fingerprint.js` | Node/Python/accelerator dependency identity |
| `test/experiment-controlled.test.js` | Manifest, lineage, partition, CLI and fail-closed tests |

No new training algorithm was introduced. The experiment reuses the reviewed Python trainer with an isolated store and frozen JSONL corpora.

## Workspace

`/home/dave/sma-experiments/controlled-experiment-20261030T230000Z`

```text
parent-store/v389/                 isolated copy of the production parent
baseline/                          parent loss, per-document, generation, summary
manifests/                         experiment manifest and verification snapshot
candidates/                        per-seed candidate evidence (empty until execution)
logs/                              baseline/evaluation logs
```

The production store, active pointer, registry, article store and corpus are not written.

## Commands

```bash
# Verify corpus hashes, disjointness and parent lineage
node scripts/experiment-controlled.mjs verify

# Freeze experiment manifest (refuses silent identity change)
node scripts/experiment-controlled.mjs manifest

# Mandatory pre-flight (also called by train)
node scripts/experiment-controlled.mjs preflight

# Reproduce baseline from existing evidence, or omit --reuse to rerun inference
node scripts/experiment-controlled.mjs baseline --reuse

# Training is blocked unless both are supplied
EXPERIMENT_ALLOW_TRAINING=1 node scripts/experiment-controlled.mjs train --execute

# Evaluate v390/v391/v392 and write paired/bootstrap/generation evidence + decision
node scripts/experiment-controlled.mjs evaluate
```

Training is deliberately hard to start: `optionalTrain()` calls `preflightTraining()` and returns a plan without executing unless `--execute` and `EXPERIMENT_ALLOW_TRAINING=1` are present. Pre-flight verifies corpus/parent/tokenizer/identity/baseline/trainer/runtime/isolation/collision conditions.

## Isolation boundaries

- Parent checkpoint copied with `cp -a` into the experiment workspace and re-hashed.
- Corpus loaded read-only from the frozen rebalanced pilot.
- Candidate versions `v390`, `v391`, `v392` live only in the experiment parent store.
- No `active.json` is created by the experiment.
- No production registry, article store, timer, job or model pointer is touched.
- No final-test corpus is accessed.
- No candidate training has been executed.

## Manifest and verification

`buildExperimentManifest()` binds:

- corpus root, manifest SHA-256, train/validation SHA-256 and token counts;
- partition/split identity and historical-screening identity;
- parent model SHA-256, weight fingerprint, architecture, parameter count, lineage;
- tokenizer path and hash;
- full protocol, seeds and candidate versions;
- trainer code fingerprint;
- execution runtime identity (actual X1 Pro: Python/Torch/Transformers/Tokenizers/NumPy/safetensors, ROCm/gfx1150, device identity, Node version, lockfile hashes);
- evaluation runtime identity (CPU test venv; recorded separately);
- baseline artifact paths and SHA-256.

The experiment ID is a deterministic SHA-256 of corpus, parent, tokenizer, complete resolved protocol, trainer fingerprint, execution runtime fingerprint and evaluation runtime fingerprint. Existing manifests are not overwritten with a changed identity unless `--allow-identity-change` is passed; the change is recorded in `manifests/identity-change-*.json`.

## Baseline orchestration

`runBaseline()` uses the existing `sma.brain eval` with `--per-document --verify-weights` and `sma.brain generate-quality`, writing all evidence to the isolated workspace. `--reuse` summarizes existing evidence without rerunning inference.

## Training orchestration

`buildTrainArgs()` constructs the exact CLI invocation:

- frozen train and validation JSONL files;
- `document-source-disjoint` + `--require-prospective-validation`;
- 128 sequence length, micro-batch 2, grad accumulation 2;
- 3,030 steps, min 1,000, warmup 150, eval every 200, 1,082 validation blocks;
- best-checkpoint selection enabled;
- explicit seed and candidate version.

The Python trainer writes only to the isolated store. Candidate versions are not published to production and are not activated.

## Evaluation orchestration

`evaluateCandidates()` runs each candidate through the same parent/tokenizer/eval conditions, captures per-document losses, training-corpus loss, generation quality, paired source-group bootstrap, and the resolved candidate train-state configuration. It writes per-seed `evidence.json`, an `evaluation-summary.json`, and a pre-registered `decision.json`. The classifier enforces every documented success/inconclusive/failure condition, including seed regression, training-loss improvement, train/validation gap, generation, and complete seed accounting.

## Recovery and failure handling

- Corpus manifest mismatch, parent hash mismatch, lineage mismatch, tokenizer mismatch, partition overlap, baseline artifact drift, trainer/runtime drift, production-path overlap, `active.json` presence or candidate-version collision fail closed before training.
- Python training failure is recorded; no partial candidate is activated.
- The current Python trainer does not persist a durable mid-run optimizer checkpoint. An interrupted run restarts from the parent; it must not be silently treated as a resumed run.
- Candidate evaluation verifies weights (`--verify-weights`) before scoring.
- No production fallback, promotion or activation path exists in the experiment CLI.

## Non-goals

This implementation does not add a final-test harness, multi-node training, a new optimizer, a new tokenizer, or production deployment. Those remain separate work.
