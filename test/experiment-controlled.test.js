import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertFingerprintUnchanged,
  assertIsolatedExperimentRoot,
  assertManifestIdentity,
  assertRuntimeIdentity,
  buildExperimentManifest,
  buildTrainArgs,
  candidateCollisions,
  classifyCandidateResults,
  optionalTrain,
  parentSnapshot,
  preflightTraining,
  verifyBaselineArtifacts,
  verifyCorpus,
} from "../scripts/experiment-controlled.mjs";

test("frozen corpus verifies and is source/hash/cluster disjoint", () => {
  const corpus = verifyCorpus();
  assert.equal(corpus.manifestSha256, "44fd36ae0ddb1378023e26c299dd16f6d74d9d3d1162e44462e47c863fde6e35");
  assert.equal(corpus.trainDocuments, 87);
  assert.equal(corpus.validationDocuments, 20);
  assert.equal(corpus.trainTokens, 775434);
  assert.equal(corpus.validationTokens, 138571);
  assert.equal(corpus.hashOverlap, 0);
  assert.equal(corpus.sourceOverlap, 0);
  assert.equal(corpus.clusterOverlap, 0);
});

test("manifest verification fails closed on a mismatched manifest", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sma-exp-bad-"));
  writeFileSync(path.join(root, "manifest.json"), JSON.stringify({ files: {} }), "utf8");
  assert.throws(() => verifyCorpus(root), /manifest hash mismatch|missing/);
});

test("isolated parent snapshot has the intended random-rooted lineage", () => {
  const parent = parentSnapshot();
  assert.equal(parent.version, "v389");
  assert.equal(parent.pretrainedWeightsUsed, false);
  assert.equal(parent.parentInitialisationType, "RANDOM");
  assert.equal(parent.parametersTotal, 61839744);
  assert.match(parent.modelSha256, /^[a-f0-9]{64}$/);
  assert.match(parent.weightFingerprint, /^[a-f0-9]{64}$/);
});

test("experiment manifest freezes corpus, parent, tokenizer, protocol and seeds", () => {
  const manifest = buildExperimentManifest();
  assert.equal(manifest.corpus.manifestSha256, "44fd36ae0ddb1378023e26c299dd16f6d74d9d3d1162e44462e47c863fde6e35");
  assert.equal(manifest.parent.version, "v389");
  assert.equal(manifest.parent.pretrainedWeightsUsed, false);
  assert.equal(manifest.tokenizer.sha256, manifest.tokenizer.expectedSha256);
  assert.deepEqual(manifest.protocol.seeds, [17, 29, 43]);
  assert.equal(manifest.protocol.validationPolicy, "document-source-disjoint");
  assert.equal(manifest.protocol.requireProspectiveValidation, true);
  assert.match(manifest.experimentId, /^[a-f0-9]{64}$/);
});

test("training arguments preserve mandatory validation policy and no legacy fallback", () => {
  const args = buildTrainArgs(17, "v390");
  assert.equal(args[0], "train");
  assert.equal(args[args.indexOf("--validation-policy") + 1], "document-source-disjoint");
  assert.ok(args.includes("--require-prospective-validation"));
  assert.ok(!args.includes("legacy-tail-split"));
  assert.equal(args[args.indexOf("--seed") + 1], "17");
  assert.equal(args[args.indexOf("--version") + 1], "v390");
});

test("training is blocked unless explicitly enabled", () => {
  const plan = optionalTrain({ execute: false, allowExistingCandidates: true });
  assert.equal(plan.executed, false);
  assert.equal(plan.candidateVersions.length, 3);
  assert.equal(plan.seeds.length, 3);
  assert.match(plan.reason, /intentionally blocked/);
});

const BASE_GENERATION = { meanRep1: 0.30057471264367813, maxRun: 4 };
const BASE_TRAIN_LOSS = 8.256554264328038;
const BASE_VAL_LOSS = 8.316381543489129;

function decisionRow(seed, {
  improvement = 0.20,
  ciLow = 0.10,
  trainingLoss = 7.90,
  validationLoss = 8.00,
  rep1 = 0.40,
  maxRun = 1,
  pairedOk = true,
  includeGeneration = true,
  version = `v${390 + seed}`,
} = {}) {
  return {
    seed,
    version,
    validation: { evalLoss: validationLoss },
    training: { evalLoss: trainingLoss },
    paired: { ok: pairedOk, pointImprovement: improvement, ciLow, ciHigh: improvement + 0.1 },
    generation: includeGeneration ? { aggregate: { meanRep1: rep1, maxRun } } : null,
  };
}

function classify(rows) {
  return classifyCandidateResults({
    rows,
    baselineGeneration: BASE_GENERATION,
    baselineTrainingLoss: BASE_TRAIN_LOSS,
    baselineValidationLoss: BASE_VAL_LOSS,
    minimumMaterialDelta: 0.15,
    expectedSeeds: [17, 29, 43],
  });
}

test("classifier: two material seeds with all guards pass => success", () => {
  const result = classify([decisionRow(17), decisionRow(29, { improvement: 0.18, ciLow: 0.08 }), decisionRow(43, { improvement: 0.10, ciLow: 0.01 })]);
  assert.equal(result.decision, "success");
  assert.deepEqual(result.successfulSeeds, [17, 29]);
});

test("classifier: a seed regression beyond 0.10 nats => failure", () => {
  const result = classify([decisionRow(17), decisionRow(29), decisionRow(43, { improvement: -0.11, ciLow: -0.2 })]);
  assert.equal(result.decision, "failure");
  assert.deepEqual(result.seedRegressionSeeds, [43]);
});

test("classifier: train/validation gap increase beyond 0.50 nats => failure", () => {
  const result = classify([decisionRow(17), decisionRow(29), decisionRow(43, { trainingLoss: 6.50, validationLoss: 8.00 })]);
  assert.equal(result.decision, "failure");
  assert.deepEqual(result.gapRegressionSeeds, [43]);
});

test("classifier: generation regression => failure", () => {
  const result = classify([decisionRow(17), decisionRow(29), decisionRow(43, { rep1: 0.20 })]);
  assert.equal(result.decision, "failure");
  assert.deepEqual(result.generationRegressionSeeds, [43]);
});

test("classifier: median improvement <= 0 => failure", () => {
  const result = classify([decisionRow(17, { improvement: 0.10, ciLow: 0.01 }), decisionRow(29, { improvement: -0.01, ciLow: -0.1 }), decisionRow(43, { improvement: -0.02, ciLow: -0.1 })]);
  assert.equal(result.decision, "failure");
});

test("classifier: training loss not improved prevents success => inconclusive", () => {
  const result = classify([decisionRow(17, { trainingLoss: 8.30 }), decisionRow(29, { trainingLoss: 8.30 }), decisionRow(43)]);
  assert.equal(result.decision, "inconclusive");
  assert.deepEqual(result.trainingLossFailureSeeds, [17, 29]);
});

test("classifier: fewer than two material seeds => inconclusive", () => {
  const result = classify([decisionRow(17), decisionRow(29, { improvement: 0.10, ciLow: 0.01 }), decisionRow(43, { improvement: 0.10, ciLow: 0.01 })]);
  assert.equal(result.decision, "inconclusive");
  assert.deepEqual(result.successfulSeeds, [17]);
});

test("classifier: missing seed evidence => inconclusive, never success", () => {
  const result = classify([decisionRow(17), decisionRow(29)]);
  assert.equal(result.decision, "inconclusive");
  assert.deepEqual(result.missingSeeds, [43]);
  assert.equal(result.accounted, false);
});

test("classifier: duplicate seed evidence => inconclusive", () => {
  const result = classify([decisionRow(17), decisionRow(17), decisionRow(29), decisionRow(43)]);
  assert.equal(result.decision, "inconclusive");
  assert.deepEqual(result.duplicateSeeds, [17]);
});

test("classifier: incomplete generation/paired evidence => inconclusive", () => {
  const result = classify([decisionRow(17, { includeGeneration: false }), decisionRow(29), decisionRow(43)]);
  assert.equal(result.decision, "inconclusive");
  assert.ok(result.incompleteEvidence.some((reason) => reason.includes("seed 17")));
});

test("pre-flight verifies frozen inputs and refuses candidate collisions", () => {
  const preflight = preflightTraining({ allowExistingCandidates: true });
  assert.equal(preflight.ok, true);
  assert.equal(preflight.corpusManifestSha256, "44fd36ae0ddb1378023e26c299dd16f6d74d9d3d1162e44462e47c863fde6e35");
  assert.equal(preflight.parentModelSha256, "4ca50873039fa3d0f5af92fc004c368e6a5c40c33a5122b05b337e98627627ff");
  assert.deepEqual(preflight.candidateVersions, ["v390", "v391", "v392"]);
  assert.deepEqual(preflight.collisions, ["v390", "v391", "v392"]);
});

test("manifest identity and fingerprint tampering fail closed", () => {
  assert.doesNotThrow(() => assertManifestIdentity({ experimentId: "a" }, { experimentId: "a" }));
  assert.throws(() => assertManifestIdentity({ experimentId: "a" }, { experimentId: "b" }), /identity changed/);
  assert.doesNotThrow(() => assertFingerprintUnchanged("trainer", "a", "a"));
  assert.throws(() => assertFingerprintUnchanged("trainer", "a", "b"), /fingerprint changed/);
});

test("runtime fingerprint failure is explicit", () => {
  assert.throws(() => assertRuntimeIdentity({ identity: { python: { packages: {}, backend: "rocm" } } }), /RUNTIME_FINGERPRINT_INCOMPLETE/);
  assert.throws(() => assertRuntimeIdentity({ identity: { python: { packages: { torch: "1", transformers: "1", tokenizers: "1", numpy: "1", safetensors: "1" }, backend: "rocm", archString: null } } }), /architecture unavailable/);
  assert.doesNotThrow(() => assertRuntimeIdentity({ identity: { python: { packages: { torch: "1", transformers: "1", tokenizers: "1", numpy: "1", safetensors: "1" }, backend: "cpu", archString: null } }, metadata: {} }));
});

test("baseline artifact changes fail closed", () => {
  const root = mkdtempSync(path.join(tmpdir(), "sma-exp-baseline-"));
  const file = path.join(root, "baseline.json");
  writeFileSync(file, "one", "utf8");
  assert.throws(() => verifyBaselineArtifacts(root, { baselineArtifacts: { baseline: { path: file, sha256: "wrong" } } }), /baseline artifact changed/);
  assert.throws(() => verifyBaselineArtifacts(root, { baselineArtifacts: { missing: { path: path.join(root, "missing"), sha256: "x" } } }), /missing/);
});

test("candidate collisions and production paths are rejected", () => {
  const store = mkdtempSync(path.join(tmpdir(), "sma-exp-store-"));
  assert.deepEqual(candidateCollisions(store), []);
  mkdirSync(path.join(store, "v390"));
  assert.deepEqual(candidateCollisions(store), ["v390"]);
  assert.throws(() => assertIsolatedExperimentRoot("/var/lib/simpleminds/store"), /production/);
  assert.throws(() => assertIsolatedExperimentRoot("/opt/simpleminds"), /production/);
  assert.doesNotThrow(() => assertIsolatedExperimentRoot("/home/dave/sma-experiments/controlled-experiment-test"));
});
