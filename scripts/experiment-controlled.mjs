#!/usr/bin/env node
/**
 * Isolated controlled-experiment orchestration.
 *
 * This is NOT the production lifecycle. It reads a frozen corpus, uses an
 * isolated copy of the parent checkpoint, writes candidates only into the
 * experiment workspace, and never activates a model.
 *
 * Training is intentionally hard to start: `train` requires both `--execute`
 * and EXPERIMENT_ALLOW_TRAINING=1. Without them it prints the plan and exits.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeParentWeightFingerprint,
  computeTrainerFingerprint,
  hashFile,
} from "../src/training/candidate-identity.js";
import { computeRuntimeFingerprint } from "../src/training/runtime-fingerprint.js";
import { pairedSourceGroupBootstrap } from "../src/training/loss-evaluator.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS_ROOT = "/home/dave/sma-experiments/prospective-rebalanced-20261030T224516Z";
const CORPUS_MANIFEST_SHA256 = "44fd36ae0ddb1378023e26c299dd16f6d74d9d3d1162e44462e47c863fde6e35";
const EXPERIMENT_ROOT = process.env.EXPERIMENT_ROOT ?? "/home/dave/sma-experiments/controlled-experiment-20261030T230000Z";
const PARENT_VERSION = "v389";
const PYTHON = process.env.EXPERIMENT_PYTHON
  ?? (existsSync("/opt/simpleminds/python/.venv/bin/python")
    ? "/opt/simpleminds/python/.venv/bin/python"
    : existsSync(path.join(REPO_ROOT, "python/.venv_test/bin/python"))
      ? path.join(REPO_ROOT, "python/.venv_test/bin/python")
      : "python3");
const EVAL_PYTHON = process.env.EXPERIMENT_EVAL_PYTHON
  ?? (existsSync(path.join(REPO_ROOT, "python/.venv_test/bin/python"))
    ? path.join(REPO_ROOT, "python/.venv_test/bin/python")
    : PYTHON);
const SEEDS = [17, 29, 43];
const CANDIDATE_VERSIONS = ["v390", "v391", "v392"];
const PROTOCOL = Object.freeze({
  sequenceLength: 128,
  microBatch: 2,
  gradAccum: 2,
  effectiveBatchSize: 4,
  learningRate: 1e-4,
  scheduler: "cosine",
  minLearningRateRatio: 0.1,
  warmupSteps: 150,
  weightDecay: 0.01,
  betas: [0.9, 0.95],
  gradClip: 1.0,
  targetEpochs: 2,
  steps: 3030,
  maxSteps: 4000,
  minSteps: 1000,
  evalEvery: 200,
  validationBlocks: 1082,
  selectBest: true,
  computeDtype: "bfloat16",
  masterDtype: "float32",
  documentBoundary: "separator",
  validationPolicy: "document-source-disjoint",
  requireProspectiveValidation: true,
  seeds: SEEDS,
  candidateVersions: CANDIDATE_VERSIONS,
});

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};
const run = (command, args, options = {}) => execFileSync(command, args, {
  cwd: REPO_ROOT,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  ...options,
});

export function assertRuntimeIdentity(runtime) {
  const packages = runtime?.identity?.python?.packages ?? {};
  const required = ["torch", "transformers", "tokenizers", "numpy", "safetensors"];
  const missing = required.filter((name) => !packages[name]);
  if (missing.length) {
    throw new Error(`RUNTIME_FINGERPRINT_INCOMPLETE: missing package version(s): ${missing.join(", ")}`);
  }
  const backend = runtime.identity.python.backend;
  if (!backend) throw new Error("RUNTIME_FINGERPRINT_INCOMPLETE: accelerator backend unavailable");
  if (backend !== "cpu" && !runtime.identity.python.archString) {
    throw new Error("RUNTIME_FINGERPRINT_INCOMPLETE: accelerator architecture unavailable");
  }
  if (backend !== "cpu" && !runtime.metadata?.deviceName) {
    throw new Error("RUNTIME_FINGERPRINT_INCOMPLETE: accelerator device identity unavailable");
  }
  return runtime;
}

export function candidateCollisions(store, versions = CANDIDATE_VERSIONS) {
  return versions.filter((version) => existsSync(path.join(store, version)));
}

export function assertIsolatedExperimentRoot(root) {
  const resolved = path.resolve(root);
  if (resolved.startsWith("/var/lib/simpleminds") || resolved.startsWith("/opt/simpleminds")) {
    throw new Error("experiment store overlaps production paths");
  }
  if (!resolved.startsWith("/home/dave/sma-experiments/controlled-experiment-")) {
    throw new Error(`experiment store is outside the isolated experiment root: ${resolved}`);
  }
  return resolved;
}

export function assertFingerprintUnchanged(label, expected, actual) {
  if (!expected || !actual || expected !== actual) {
    throw new Error(`${label} fingerprint changed since experiment freeze`);
  }
}

export function assertManifestIdentity(frozen, current) {
  if (!frozen?.experimentId || !current?.experimentId || frozen.experimentId !== current.experimentId) {
    throw new Error(`experiment identity changed: ${current?.experimentId} != ${frozen?.experimentId}`);
  }
}

export function verifyBaselineArtifacts(root, manifest) {
  for (const [name, artifact] of Object.entries(manifest?.baselineArtifacts ?? {})) {
    if (!artifact?.path || !artifact?.sha256) throw new Error(`baseline artifact ${name} is not bound`);
    if (!existsSync(artifact.path)) throw new Error(`baseline artifact missing: ${name}`);
    const actual = hashFile(artifact.path);
    if (actual !== artifact.sha256) throw new Error(`baseline artifact changed: ${name}`);
  }
}

export function verifyCorpus(root = CORPUS_ROOT) {
  const manifestFile = path.join(root, "manifest.json");
  if (!existsSync(manifestFile)) throw new Error(`missing corpus manifest: ${manifestFile}`);
  const manifestBytes = readFileSync(manifestFile);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const observedManifestHash = sha256(manifestBytes);
  if (observedManifestHash !== CORPUS_MANIFEST_SHA256) {
    throw new Error(`corpus manifest hash mismatch: ${observedManifestHash} != ${CORPUS_MANIFEST_SHA256}`);
  }
  const files = [];
  for (const [name, artifact] of Object.entries(manifest.files)) {
    const actual = hashFile(artifact.path);
    if (actual !== artifact.sha256) throw new Error(`corpus artifact mismatch: ${name}`);
    files.push({ name, path: artifact.path, sha256: actual });
  }
  const trainFile = path.join(root, "corpus", "train.jsonl");
  const validationFile = path.join(root, "corpus", "validation.jsonl");
  const train = readFileSync(trainFile, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const validation = readFileSync(validationFile, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  if (train.some((row) => row.corpusRole !== "train")) throw new Error("training file contains non-train roles");
  if (validation.some((row) => row.corpusRole !== "validation")) throw new Error("validation file contains non-validation roles");
  const trainHashes = new Set(train.map((row) => row.contentHash));
  const validationHashes = new Set(validation.map((row) => row.contentHash));
  const trainSources = new Set(train.map((row) => row.sourceId));
  const validationSources = new Set(validation.map((row) => row.sourceId));
  const trainClusters = new Set(train.map((row) => row.clusterId));
  const validationClusters = new Set(validation.map((row) => row.clusterId));
  const hashOverlap = [...validationHashes].filter((hash) => trainHashes.has(hash));
  const sourceOverlap = [...validationSources].filter((source) => trainSources.has(source));
  const clusterOverlap = [...validationClusters].filter((cluster) => trainClusters.has(cluster));
  if (hashOverlap.length || sourceOverlap.length || clusterOverlap.length) {
    throw new Error(`frozen partition overlap detected: hash=${hashOverlap.length} source=${sourceOverlap.length} cluster=${clusterOverlap.length}`);
  }
  return {
    root,
    manifestFile,
    manifestSha256: observedManifestHash,
    files,
    trainDocuments: train.length,
    validationDocuments: validation.length,
    trainTokens: train.reduce((sum, row) => sum + Number(row.actualTokens), 0),
    validationTokens: validation.reduce((sum, row) => sum + Number(row.actualTokens), 0),
    hashOverlap: hashOverlap.length,
    sourceOverlap: sourceOverlap.length,
    clusterOverlap: clusterOverlap.length,
    trainFile,
    validationFile,
  };
}

export function parentSnapshot(root = EXPERIMENT_ROOT) {
  const parentDir = path.join(root, "parent-store", PARENT_VERSION);
  if (!existsSync(parentDir)) throw new Error(`missing isolated parent snapshot: ${parentDir}`);
  const manifest = readJson(path.join(parentDir, "init-manifest.json"));
  const provenance = readJson(path.join(parentDir, "provenance.json"));
  const committed = readJson(path.join(parentDir, "COMMITTED"));
  if (provenance.pretrainedWeightsUsed !== false) throw new Error("parent does not explicitly prohibit pretrained weights");
  if (provenance.parentInitialisationType !== "RANDOM") throw new Error("parent lineage is not recorded as RANDOM-rooted");
  if (committed.version !== PARENT_VERSION) throw new Error("parent COMMITTED version mismatch");
  const modelHash = hashFile(path.join(parentDir, "model.safetensors"));
  return {
    version: PARENT_VERSION,
    path: parentDir,
    modelSha256: modelHash,
    weightFingerprint: computeParentWeightFingerprint(path.join(root, "parent-store"), PARENT_VERSION),
    architecture: manifest.architecture,
    parametersTotal: manifest.sizes?.parametersTotal ?? null,
    initialisationType: provenance.initialisationType,
    parentInitialisationType: provenance.parentInitialisationType,
    pretrainedWeightsUsed: provenance.pretrainedWeightsUsed,
    stepsCompleted: provenance.stepsCompleted,
    tokensSeen: provenance.tokensSeen,
    tokenizerHash: provenance.tokenizerHash,
  };
}

export function buildExperimentManifest({ root = EXPERIMENT_ROOT } = {}) {
  const corpus = verifyCorpus();
  const parent = parentSnapshot(root);
  const tokenizerFile = path.join(root, "parent-store", PARENT_VERSION, "tokenizer.json");
  const runtime = assertRuntimeIdentity(computeRuntimeFingerprint({
    root: REPO_ROOT,
    pythonBin: PYTHON,
    store: path.join(root, "parent-store"),
  }));
  const evaluationRuntime = assertRuntimeIdentity(computeRuntimeFingerprint({
    root: REPO_ROOT,
    pythonBin: EVAL_PYTHON,
    store: path.join(root, "parent-store"),
  }));
  const trainer = computeTrainerFingerprint(REPO_ROOT);
  const inputs = {
    schema: "sma/controlled-experiment-manifest@1",
    experimentRoot: root,
    corpus: {
      root: CORPUS_ROOT,
      manifestSha256: corpus.manifestSha256,
      trainSha256: hashFile(corpus.trainFile),
      validationSha256: hashFile(corpus.validationFile),
      trainDocuments: corpus.trainDocuments,
      validationDocuments: corpus.validationDocuments,
      trainTokens: corpus.trainTokens,
      validationTokens: corpus.validationTokens,
      historicalScreening: "128/128 NO_HISTORICAL_MATCH",
      exposure: "prospective-only",
    },
    parent,
    tokenizer: {
      file: tokenizerFile,
      sha256: hashFile(tokenizerFile),
      expectedSha256: parent.tokenizerHash,
    },
    protocol: PROTOCOL,
    fingerprints: {
      trainer,
      runtime: {
        identity: runtime.identity,
        metadata: runtime.metadata,
        digest: runtime.digest,
      },
      evaluationRuntime: {
        identity: evaluationRuntime.identity,
        metadata: evaluationRuntime.metadata,
        digest: evaluationRuntime.digest,
      },
    },
    baselineArtifacts: {},
    createdAt: new Date().toISOString(),
  };
  for (const [name, rel] of Object.entries({
    parentValidationEval: "baseline/parent-validation-eval.json",
    parentTrainEval: "baseline/parent-train-eval.json",
    parentGenerationQuality: "baseline/parent-generation-quality.json",
    parentBaselineSummary: "baseline/parent-baseline-summary.json",
  })) {
    const file = path.join(root, rel);
    if (existsSync(file)) inputs.baselineArtifacts[name] = { path: file, sha256: hashFile(file) };
  }
  inputs.experimentId = sha256(JSON.stringify({
    corpus: inputs.corpus,
    parent: inputs.parent,
    tokenizer: inputs.tokenizer,
    protocol: inputs.protocol,
    trainer: inputs.fingerprints.trainer.digest,
    runtime: inputs.fingerprints.runtime.digest,
    evaluationRuntime: inputs.fingerprints.evaluationRuntime.digest,
  }));
  return inputs;
}

export function preflightTraining({ root = EXPERIMENT_ROOT, allowExistingCandidates = false } = {}) {
  const corpus = verifyCorpus();
  const parent = parentSnapshot(root);
  const tokenizerFile = path.join(root, "parent-store", PARENT_VERSION, "tokenizer.json");
  const tokenizerHash = hashFile(tokenizerFile);
  if (tokenizerHash !== parent.tokenizerHash) throw new Error("tokenizer hash does not match parent");
  const manifestFile = path.join(REPO_ROOT, "EXPERIMENT-MANIFEST.json");
  if (!existsSync(manifestFile)) throw new Error("EXPERIMENT-MANIFEST.json is missing");
  const frozen = readJson(manifestFile);
  const current = buildExperimentManifest({ root });
  assertManifestIdentity(frozen, current);
  assertFingerprintUnchanged("trainer", frozen.fingerprints.trainer.digest, current.fingerprints.trainer.digest);
  assertFingerprintUnchanged("execution runtime", frozen.fingerprints.runtime.digest, current.fingerprints.runtime.digest);
  assertFingerprintUnchanged("evaluation runtime", frozen.fingerprints.evaluationRuntime.digest, current.fingerprints.evaluationRuntime.digest);
  verifyBaselineArtifacts(root, frozen);
  const resolvedRoot = assertIsolatedExperimentRoot(root);
  const store = path.join(root, "parent-store");
  if (existsSync(path.join(store, "active.json"))) {
    throw new Error("experiment store contains an active.json pointer; refusing to train");
  }
  const collisions = candidateCollisions(store);
  if (collisions.length && !allowExistingCandidates) {
    throw new Error(`candidate version collision: ${collisions.join(", ")}`);
  }
  return {
    ok: true,
    experimentId: frozen.experimentId,
    corpusManifestSha256: corpus.manifestSha256,
    parentModelSha256: parent.modelSha256,
    parentWeightFingerprint: parent.weightFingerprint,
    tokenizerSha256: tokenizerHash,
    trainerFingerprint: current.fingerprints.trainer.digest,
    runtimeFingerprint: current.fingerprints.runtime.digest,
    evaluationRuntimeFingerprint: current.fingerprints.evaluationRuntime.digest,
    baselineArtifactsVerified: Object.keys(frozen.baselineArtifacts ?? {}),
    isolatedStore: store,
    candidateVersions: CANDIDATE_VERSIONS,
    collisions,
  };
}

function summarizeBaseline(root) {
  const validation = readJson(path.join(root, "baseline/parent-validation-eval.json"));
  const train = readJson(path.join(root, "baseline/parent-train-eval.json"));
  const generation = readJson(path.join(root, "baseline/parent-generation-quality.json"));
  const groupStats = (result) => {
    const groups = result.groups ?? [];
    const total = groups.reduce((sum, group) => sum + Number(group.tokens), 0);
    const mean = groups.reduce((sum, group) => sum + Number(group.loss) * Number(group.tokens), 0) / total;
    const variance = groups.reduce((sum, group) => sum + Number(group.tokens) * ((Number(group.loss) - mean) ** 2), 0) / total;
    return { groups: groups.length, tokenWeightedMean: mean, groupStdDev: Math.sqrt(variance), groupNaiveStandardError: Math.sqrt(variance / groups.length), group95HalfWidth: 1.96 * Math.sqrt(variance / groups.length) };
  };
  return {
    schema: "sma/experiment-baseline-summary@1",
    parentVersion: PARENT_VERSION,
    validationLoss: validation.evalLoss,
    trainingLoss: train.evalLoss,
    validation: groupStats(validation),
    training: groupStats(train),
    generation: generation.aggregate,
    generationSamples: generation.samples,
    weightsVerified: validation.weights?.verified === true,
    materialDeltaBasis: {
      validationGroup95HalfWidth: groupStats(validation).group95HalfWidth,
      selectedMinimumMaterialDelta: 0.15,
      rationale: "0.15 nats is the measured validation group-level 95% half-width on the frozen parent baseline; it is larger than the per-document standard error and is pre-registered before candidate training.",
    },
  };
}

export function buildTrainArgs(seed, version) {
  return [
    "train",
    "--parent", PARENT_VERSION,
    "--version", version,
    "--corpus",
    path.join(CORPUS_ROOT, "corpus", "train.jsonl"),
    path.join(CORPUS_ROOT, "corpus", "validation.jsonl"),
    "--config", "small",
    "--lr", String(PROTOCOL.learningRate),
    "--steps", String(PROTOCOL.steps),
    "--min-steps", String(PROTOCOL.minSteps),
    "--seq-len", String(PROTOCOL.sequenceLength),
    "--micro-batch", String(PROTOCOL.microBatch),
    "--grad-accum", String(PROTOCOL.gradAccum),
    "--warmup", String(PROTOCOL.warmupSteps),
    "--val-blocks", String(PROTOCOL.validationBlocks),
    "--eval-every", String(PROTOCOL.evalEvery),
    "--document-boundary", PROTOCOL.documentBoundary,
    "--validation-policy", PROTOCOL.validationPolicy,
    "--require-prospective-validation",
    "--grad-clip", String(PROTOCOL.gradClip),
    "--spike-factor", "2.5",
    "--spike-consecutive", "3",
    "--min-delta", "1e-7",
    "--log-every", "1",
    "--select-best",
    "--seed", String(seed),
    "--compute-dtype", PROTOCOL.computeDtype,
    "--device", process.env.EXPERIMENT_DEVICE ?? "cuda",
    "--run-id", `experiment-seed-${seed}`,
  ];
}

export function runBaseline({ root = EXPERIMENT_ROOT, reuse = false } = {}) {
  verifyCorpus();
  parentSnapshot(root);
  const baselineDir = path.join(root, "baseline");
  mkdirSync(baselineDir, { recursive: true });
  const outputs = {
    validation: path.join(baselineDir, "parent-validation-eval.json"),
    train: path.join(baselineDir, "parent-train-eval.json"),
    generation: path.join(baselineDir, "parent-generation-quality.json"),
  };
  if (!reuse) {
    const common = ["eval", "--out", path.join(root, "parent-store"), "--version", PARENT_VERSION, "--seq-len", "128", "--micro-batch", "2", "--device", process.env.EXPERIMENT_DEVICE ?? "cpu", "--verify-weights", "--per-document"];
    writeFileSync(outputs.validation, run(EVAL_PYTHON, ["-m", "sma.brain", ...common, "--eval-set", path.join(CORPUS_ROOT, "corpus", "validation.jsonl")], { cwd: path.join(REPO_ROOT, "python") }), "utf8");
    writeFileSync(outputs.train, run(EVAL_PYTHON, ["-m", "sma.brain", ...common, "--eval-set", path.join(CORPUS_ROOT, "corpus", "train.jsonl")], { cwd: path.join(REPO_ROOT, "python") }), "utf8");
    writeFileSync(outputs.generation, run(EVAL_PYTHON, ["-m", "sma.brain", "generate-quality", "--out", path.join(root, "parent-store"), "--version", PARENT_VERSION, "--max-new-tokens", "32", "--device", process.env.EXPERIMENT_DEVICE ?? "cpu"], { cwd: path.join(REPO_ROOT, "python") }), "utf8");
  }
  const summary = summarizeBaseline(root);
  writeJson(path.join(baselineDir, "parent-baseline-summary.json"), summary);
  return summary;
}

export function optionalTrain({ execute = false, allowExistingCandidates = false } = {}) {
  const preflight = preflightTraining({ allowExistingCandidates });
  if (!execute || process.env.EXPERIMENT_ALLOW_TRAINING !== "1") {
    return {
      executed: false,
      reason: "training intentionally blocked; pass --execute and set EXPERIMENT_ALLOW_TRAINING=1",
      preflight,
      candidateVersions: CANDIDATE_VERSIONS,
      seeds: SEEDS,
      protocol: PROTOCOL,
      commands: SEEDS.map((seed, index) => ({ seed, version: CANDIDATE_VERSIONS[index], argv: buildTrainArgs(seed, CANDIDATE_VERSIONS[index]) })),
    };
  }
  const results = [];
  for (let index = 0; index < SEEDS.length; index += 1) {
    const seed = SEEDS[index];
    const version = CANDIDATE_VERSIONS[index];
    const out = run(PYTHON, ["-m", "sma.brain", ...buildTrainArgs(seed, version)], {
      cwd: path.join(REPO_ROOT, "python"),
      env: { ...process.env, SMA_STORE: path.join(EXPERIMENT_ROOT, "parent-store") },
    });
    results.push({ seed, version, output: out });
  }
  return { executed: true, results };
}

export function classifyCandidateResults({
  rows,
  baselineGeneration,
  baselineTrainingLoss,
  baselineValidationLoss,
  minimumMaterialDelta = 0.15,
  expectedSeeds = SEEDS,
} = {}) {
  const expected = [...expectedSeeds];
  const seedCounts = new Map();
  for (const row of rows ?? []) seedCounts.set(row.seed, (seedCounts.get(row.seed) ?? 0) + 1);
  const missingSeeds = expected.filter((seed) => !seedCounts.has(seed));
  const duplicateSeeds = [...seedCounts.entries()].filter(([, count]) => count > 1).map(([seed]) => seed);
  const unexpectedSeeds = [...seedCounts.keys()].filter((seed) => !expected.includes(seed));
  const incompleteEvidence = [];
  if (missingSeeds.length) incompleteEvidence.push(`missing seeds: ${missingSeeds.join(", ")}`);
  if (duplicateSeeds.length) incompleteEvidence.push(`duplicate seeds: ${duplicateSeeds.join(", ")}`);
  if (unexpectedSeeds.length) incompleteEvidence.push(`unexpected seeds: ${unexpectedSeeds.join(", ")}`);

  const perSeed = (rows ?? []).map((row) => {
    const validationLoss = Number(row.validation?.evalLoss);
    const trainingLoss = Number(row.training?.evalLoss);
    const improvement = Number(row.paired?.pointImprovement);
    const ciLow = Number(row.paired?.ciLow);
    const ciHigh = Number(row.paired?.ciHigh);
    const gaps = {
      candidate: Number.isFinite(validationLoss) && Number.isFinite(trainingLoss) ? validationLoss - trainingLoss : null,
      parent: Number.isFinite(baselineValidationLoss) && Number.isFinite(baselineTrainingLoss) ? baselineValidationLoss - baselineTrainingLoss : null,
    };
    const generation = row.generation?.aggregate ?? null;
    const complete = Number.isFinite(validationLoss)
      && Number.isFinite(trainingLoss)
      && row.paired?.ok === true
      && Number.isFinite(improvement)
      && Number.isFinite(ciLow)
      && Number.isFinite(ciHigh)
      && generation !== null;
    if (!complete) incompleteEvidence.push(`incomplete evidence for seed ${row.seed}`);
    return {
      seed: row.seed,
      version: row.version,
      validationLoss: Number.isFinite(validationLoss) ? validationLoss : null,
      trainingLoss: Number.isFinite(trainingLoss) ? trainingLoss : null,
      pairedImprovement: Number.isFinite(improvement) ? improvement : null,
      pairedCiLow: Number.isFinite(ciLow) ? ciLow : null,
      pairedCiHigh: Number.isFinite(ciHigh) ? ciHigh : null,
      validationTrainingGap: gaps.candidate,
      parentValidationTrainingGap: gaps.parent,
      gapIncrease: gaps.candidate != null && gaps.parent != null ? gaps.candidate - gaps.parent : null,
      trainingLossImproved: Number.isFinite(trainingLoss) && Number.isFinite(baselineTrainingLoss) ? trainingLoss < baselineTrainingLoss : null,
      generation,
      generationRegression: generation === null
        || Number(generation.meanRep1) < Number(baselineGeneration?.meanRep1) - 0.05
        || Number(generation.maxRun) > 8,
      seedRegression: Number.isFinite(improvement) && improvement < -0.10,
      gapRegression: gaps.candidate != null && gaps.parent != null ? gaps.candidate - gaps.parent > 0.50 : null,
      successful: complete
        && Number.isFinite(improvement)
        && improvement >= minimumMaterialDelta
        && Number.isFinite(ciLow)
        && ciLow > 0
        && trainingLoss < baselineTrainingLoss
        && gaps.candidate - gaps.parent <= 0.50
        && !(Number(generation.meanRep1) < Number(baselineGeneration?.meanRep1) - 0.05)
        && Number(generation.maxRun) <= 8,
    };
  });

  const completeSeeds = perSeed.filter((row) => row.validationLoss != null && row.trainingLoss != null && row.pairedImprovement != null && row.generation);
  const improvements = completeSeeds.map((row) => row.pairedImprovement).sort((a, b) => a - b);
  const median = improvements.length
    ? (improvements.length % 2 ? improvements[(improvements.length - 1) / 2] : (improvements[improvements.length / 2 - 1] + improvements[improvements.length / 2]) / 2)
    : null;
  const successfulSeeds = perSeed.filter((row) => row.successful);
  const seedRegressions = perSeed.filter((row) => row.seedRegression);
  const gapRegressions = perSeed.filter((row) => row.gapRegression === true);
  const generationRegressions = perSeed.filter((row) => row.generationRegression);
  const trainingLossFailures = perSeed.filter((row) => row.trainingLossImproved !== true);
  const accounted = missingSeeds.length === 0 && duplicateSeeds.length === 0 && unexpectedSeeds.length === 0 && incompleteEvidence.length === 0;

  let decision = "inconclusive";
  const reasons = [];
  if (!accounted) {
    reasons.push(...incompleteEvidence);
  } else if (seedRegressions.length) {
    decision = "failure";
    reasons.push(`seed regression beyond 0.10 nats: ${seedRegressions.map((row) => row.seed).join(", ")}`);
  } else if (gapRegressions.length) {
    decision = "failure";
    reasons.push(`train/validation gap increased by more than 0.50 nats: ${gapRegressions.map((row) => row.seed).join(", ")}`);
  } else if (generationRegressions.length) {
    decision = "failure";
    reasons.push(`generation guard failed: ${generationRegressions.map((row) => row.seed).join(", ")}`);
  } else if (median != null && median <= 0) {
    decision = "failure";
    reasons.push(`median validation improvement is not positive (${median})`);
  } else if (trainingLossFailures.length) {
    reasons.push(`training-corpus loss did not improve for seed(s): ${trainingLossFailures.map((row) => row.seed).join(", ")}`);
  } else if (successfulSeeds.length >= 2 && median != null && median >= minimumMaterialDelta) {
    decision = "success";
    reasons.push(`at least two seeds meet the material paired improvement and all success guards pass`);
  } else {
    reasons.push(`only ${successfulSeeds.length} seed(s) meet the material paired improvement; median=${median}`);
  }

  return {
    decision,
    reasons,
    minimumMaterialDelta,
    medianImprovement: median,
    accounted,
    missingSeeds,
    duplicateSeeds,
    unexpectedSeeds,
    incompleteEvidence,
    successfulSeeds: successfulSeeds.map((row) => row.seed),
    seedRegressionSeeds: seedRegressions.map((row) => row.seed),
    gapRegressionSeeds: gapRegressions.map((row) => row.seed),
    generationRegressionSeeds: generationRegressions.map((row) => row.seed),
    trainingLossFailureSeeds: trainingLossFailures.map((row) => row.seed),
    perSeed,
  };
}

function readCandidateResolvedConfig(root, version) {
  const dir = path.join(root, "parent-store", version);
  if (!existsSync(dir)) throw new Error(`candidate version missing: ${version}`);
  const state = readJson(path.join(dir, "train-state.json"));
  const provenance = readJson(path.join(dir, "provenance.json"));
  if (provenance.parentVersion !== PARENT_VERSION) throw new Error(`candidate ${version} parent mismatch`);
  if (provenance.pretrainedWeightsUsed !== false) throw new Error(`candidate ${version} pretrained-weight flag is not false`);
  return {
    version,
    config: state.config,
    corpusSplit: state.corpusSplit,
    stepsCompleted: state.stepsCompleted,
    tokensSeen: state.tokensSeen,
    selectedStep: state.selectedStep,
    selectedValidationLoss: state.selectedValidationLoss,
    provenance: {
      parentVersion: provenance.parentVersion,
      parentWeightFingerprint: provenance.parentWeightFingerprint,
      trainerCodeFingerprint: provenance.trainerCodeFingerprint,
      trainingSeed: provenance.trainingSeed,
      validationSplit: provenance.validationSplit,
      corpusFiles: provenance.corpusFiles,
      runtime: provenance.runtime,
    },
  };
}

function evaluateCandidates({ root = EXPERIMENT_ROOT } = {}) {
  const baselineValidation = readJson(path.join(root, "baseline/parent-validation-eval.json"));
  const rows = [];
  for (let index = 0; index < CANDIDATE_VERSIONS.length; index += 1) {
    const version = CANDIDATE_VERSIONS[index];
    const seed = SEEDS[index];
    const dir = path.join(root, "candidates", `seed-${seed}`);
    mkdirSync(dir, { recursive: true });
    const common = ["eval", "--out", path.join(root, "parent-store"), "--version", version, "--seq-len", "128", "--micro-batch", "2", "--device", process.env.EXPERIMENT_DEVICE ?? "cpu", "--verify-weights", "--per-document"];
    const validation = JSON.parse(run(EVAL_PYTHON, ["-m", "sma.brain", ...common, "--eval-set", path.join(CORPUS_ROOT, "corpus", "validation.jsonl")], { cwd: path.join(REPO_ROOT, "python") }));
    const training = JSON.parse(run(EVAL_PYTHON, ["-m", "sma.brain", ...common, "--eval-set", path.join(CORPUS_ROOT, "corpus", "train.jsonl")], { cwd: path.join(REPO_ROOT, "python") }));
    const generation = JSON.parse(run(EVAL_PYTHON, ["-m", "sma.brain", "generate-quality", "--out", path.join(root, "parent-store"), "--version", version, "--max-new-tokens", "32", "--device", process.env.EXPERIMENT_DEVICE ?? "cpu"], { cwd: path.join(REPO_ROOT, "python") }));
    const paired = pairedSourceGroupBootstrap(
      { version: PARENT_VERSION, datasetHash: baselineValidation.evaluationSet.datasetHash, perDocument: baselineValidation.perDocument },
      { version, datasetHash: validation.evaluationSet.datasetHash, perDocument: validation.perDocument },
      { minGroups: 20, samples: 4000 },
    );
    const resolvedConfig = readCandidateResolvedConfig(root, version);
    const evidence = { seed, version, resolvedConfig, validation, training, generation, paired };
    writeJson(path.join(dir, "evidence.json"), evidence);
    rows.push(evidence);
  }
  const baselineGeneration = readJson(path.join(root, "baseline/parent-generation-quality.json")).aggregate;
  const baselineSummary = readJson(path.join(root, "baseline/parent-baseline-summary.json"));
  const decision = classifyCandidateResults({
    rows,
    baselineGeneration,
    baselineTrainingLoss: baselineSummary.trainingLoss,
    baselineValidationLoss: baselineSummary.validationLoss,
    minimumMaterialDelta: 0.15,
    expectedSeeds: SEEDS,
  });
  const result = { schema: "sma/experiment-candidate-evaluation@1", generatedAt: new Date().toISOString(), decision, rows };
  writeJson(path.join(root, "candidates", "evaluation-summary.json"), result);
  writeJson(path.join(root, "candidates", "decision.json"), decision);
  return result;
}

function main() {
  const [command = "verify", ...rest] = process.argv.slice(2);
  if (command === "verify") {
    const result = { corpus: verifyCorpus(), parent: parentSnapshot(EXPERIMENT_ROOT) };
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "manifest") {
    const manifest = buildExperimentManifest();
    const manifestPath = path.join(REPO_ROOT, "EXPERIMENT-MANIFEST.json");
    const allowChange = rest.includes("--allow-identity-change");
    if (existsSync(manifestPath)) {
      const existing = readJson(manifestPath);
      const baselineChanged = JSON.stringify(existing.baselineArtifacts ?? {}) !== JSON.stringify(manifest.baselineArtifacts ?? {});
      if ((existing.experimentId !== manifest.experimentId || baselineChanged) && !allowChange) {
        throw new Error(`experiment manifest changed (${existing.experimentId} -> ${manifest.experimentId}); pass --allow-identity-change to record the change explicitly`);
      }
      if (existing.experimentId === manifest.experimentId && !baselineChanged) {
        console.log(JSON.stringify({ ok: true, unchanged: true, experimentId: manifest.experimentId, manifest: manifestPath }, null, 2));
        return;
      }
      if (allowChange) {
        writeJson(path.join(EXPERIMENT_ROOT, "manifests", `identity-change-${new Date().toISOString().replace(/[:.]/g, "-")}.json`), {
          previousExperimentId: existing.experimentId,
          previousManifestSha256: hashFile(manifestPath),
          newExperimentId: manifest.experimentId,
          reason: "explicit --allow-identity-change",
        });
        manifest.identityChange = {
          previousExperimentId: existing.experimentId,
          previousManifestSha256: hashFile(manifestPath),
        };
      }
    }
    writeJson(path.join(EXPERIMENT_ROOT, "manifests", "experiment-manifest.json"), manifest);
    writeJson(manifestPath, manifest);
    console.log(JSON.stringify({ ok: true, experimentId: manifest.experimentId, manifest: manifestPath }, null, 2));
  } else if (command === "preflight") {
    console.log(JSON.stringify(preflightTraining({ allowExistingCandidates: rest.includes("--allow-existing-candidates") }), null, 2));
  } else if (command === "baseline") {
    console.log(JSON.stringify(runBaseline({ reuse: rest.includes("--reuse") }), null, 2));
  } else if (command === "train") {
    console.log(JSON.stringify(optionalTrain({ execute: rest.includes("--execute") }), null, 2));
  } else if (command === "evaluate") {
    console.log(JSON.stringify(evaluateCandidates(), null, 2));
  } else {
    console.error("usage: experiment-controlled.mjs {verify|manifest [--allow-identity-change]|preflight [--allow-existing-candidates]|baseline [--reuse]|train [--execute]|evaluate}");
    process.exit(2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
