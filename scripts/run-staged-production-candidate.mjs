#!/usr/bin/env node
import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCandidateIdentity } from "../src/training/candidate-identity.js";
import { computeRuntimeFingerprint } from "../src/training/runtime-fingerprint.js";
import { SPLIT_POLICY_VERSION, CLUSTER_POLICY_VERSION } from "../src/dataset/partition.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANDIDATE_ROOT = process.env.CANDIDATE_ROOT ?? "/home/dave/sma-experiments/production-candidate";
const ARTICLE_DIR = process.env.ARTICLE_DIR ?? "/var/lib/simpleminds/data/articles";
const PYTHON_STORE = process.env.SMA_STORE ?? "/home/dave/sma-experiments/stage1/store";
const PARENT_VERSION = process.env.CANDIDATE_PARENT ?? "v389";
const CORPUS_ONLY = process.env.CANDIDATE_CORPUS_ONLY === "1";
const FORCE = process.env.CANDIDATE_FORCE === "1";

process.env.SMA_STORE = PYTHON_STORE;
process.env.SMA_PYTHON ??= "/opt/simpleminds/python/.venv/bin/python";
process.env.SMA_DEVICE ??= "cuda";
process.env.SNAPSHOT_INCLUDE_CONSUMED ??= "true";
process.env.SNAPSHOT_LIMIT ??= "10000";
process.env.TRAIN_REPLAY_PERCENT ??= "0";
process.env.TRAIN_CORPUS_MODE ??= "raw-text";
process.env.TRAIN_CORPUS_MIN_CHARS ??= "1000";
process.env.TRAIN_CORPUS_MIN_SENTENCE_RATIO ??= "0.4";
process.env.TRAIN_CORPUS_COMMON_LINE_DOCS ??= "10";
process.env.TRAIN_MIN_STEPS ??= "1000";
process.env.TRAIN_MIN_UNIQUE_TOKENS ??= "500000";
process.env.TRAIN_TARGET_EPOCHS ??= "2";
process.env.TRAIN_MAX_STEPS ??= "4000";
process.env.TRAIN_WARMUP ??= "200";
process.env.TRAIN_SEED ??= "0";
process.env.TRAIN_VALIDATION_POLICY ??= "document-source-disjoint";
process.env.TRAIN_VALIDATION_REQUIRE_PROSPECTIVE ??= "true";
process.env.TRAIN_EVAL_EVERY ??= "100";
process.env.TRAIN_DOCUMENT_BOUNDARY ??= "separator";
process.env.TRAIN_SELECT_BEST ??= "1";
process.env.EVAL_DATASET_ID ??= "eval-002";

const paths = {
  snapshots: path.join(CANDIDATE_ROOT, "snapshots"),
  models: path.join(CANDIDATE_ROOT, "models"),
  plans: path.join(CANDIDATE_ROOT, "plans"),
  evaluation: path.join(CANDIDATE_ROOT, "evaluation"),
};
const registryDir = path.join(CANDIDATE_ROOT, "registry");
for (const dir of Object.values(paths)) await mkdir(dir, { recursive: true });
await mkdir(registryDir, { recursive: true });

const evalSource = path.join("/var/lib/simpleminds/data/evaluation", `${process.env.EVAL_DATASET_ID}.jsonl`);
const evalTarget = path.join(paths.evaluation, `${process.env.EVAL_DATASET_ID}.jsonl`);
if (existsSync(evalSource) && !existsSync(evalTarget)) await copyFile(evalSource, evalTarget);

const { ArticleStore } = await import(path.join(REPO_ROOT, "src/storage/article-store.js"));
const { collectRowsFromArticles } = await import(path.join(REPO_ROOT, "src/dataset/snapshot.js"));
const { RegistryStore } = await import(path.join(REPO_ROOT, "src/storage/registry-store.js"));
const { executeFullRun } = await import(path.join(REPO_ROOT, "src/training/lifecycle.js"));
const { selectTrainer } = await import(path.join(REPO_ROOT, "src/training/trainer-interface.js"));
const { config } = await import(path.join(REPO_ROOT, "src/config.js"));
const { defaultEvalSeed } = await import(path.join(REPO_ROOT, "src/cli/report.js"));

const source = await ArticleStore.open(ARTICLE_DIR, { readOnly: true });
const store = {
  getStats: (...args) => source.getStats(...args),
  articlesPage: (...args) => source.articlesPage(...args),
  getArticle: (...args) => source.getArticle(...args),
  markConsumed: async (ids) => ({ consumed: [], skipped: (ids ?? []).map((articleId) => ({ articleId, reason: "staged-candidate" })) }),
  deferArticles: async (ids) => ({ deferred: [], skipped: (ids ?? []).map((articleId) => ({ articleId, reason: "staged-candidate" })) }),
  clearDeferral: async () => ({ cleared: 0 }),
  recordTrainingContribution: async () => ({ recorded: 0 }),
  close: () => source.close(),
};
const collected = collectRowsFromArticles(source, {
  limit: config.snapshotLimit,
  includeConsumed: config.snapshotIncludeConsumed,
  replayPercent: config.trainReplayPercent,
  validationBlocks: config.trainValBlocks,
  validationSeqLen: config.trainSeqLen,
  corpusMode: config.trainCorpusMode,
});
// Fingerprint the actual snapshot input rows, including cleaned text and role
// metadata, not just article ids. The immutable snapshot hash is recorded later
// in the run/provenance; this is the pre-run identity used to skip unchanged
// candidate work.
const corpusHash = createHash("sha256")
  .update(collected.rows.map((row) => JSON.stringify(row)).join("\n"))
  .digest("hex");
const evalHash = existsSync(evalTarget)
  ? createHash("sha256").update(await readFile(evalTarget)).digest("hex")
  : null;
const keyConfig = {
  parentVersion: PARENT_VERSION,
  corpusOnly: CORPUS_ONLY,
  corpusMode: config.trainCorpusMode,
  includeConsumed: config.snapshotIncludeConsumed,
  snapshotLimit: config.snapshotLimit,
  replayPercent: config.trainReplayPercent,
  targetEpochs: config.trainTargetEpochs,
  maxSteps: config.trainMaxSteps,
  minSteps: config.trainMinSteps,
  minUniqueTokens: config.trainMinUniqueTokens,
  warmup: config.trainWarmup,
  seqLen: config.trainSeqLen,
  microBatch: config.trainMicroBatch,
  gradAccum: config.trainGradAccum,
  learningRate: config.trainLearningRate,
  documentBoundary: config.trainDocumentBoundary,
  selectBest: config.trainSelectBest,
  evalEvery: config.trainEvalEvery,
  valBlocks: config.trainValBlocks,
  computeDtype: config.trainComputeDtype,
  corpusMinChars: config.trainCorpusMinChars,
  corpusMinSentenceRatio: config.trainCorpusMinSentenceRatio,
  corpusCommonLineDocs: config.trainCorpusCommonLineDocs,
  evalDatasetId: config.evalDatasetId,
  evalHash,
  device: config.studentDevice,
  seed: config.trainSeed,
  validationPolicy: config.trainValidationPolicy,
  validationFraction: config.trainValidationFraction,
  validationTargetTokens: config.trainValidationTargetTokens,
  minValidationTokens: config.trainMinValidationTokens,
  minValidationClusters: config.trainMinValidationClusters,
  validationSeed: config.trainValidationSeed,
  validationRequireProspective: config.trainValidationRequireProspective,
  corpusMaxFallbackTokenShare: config.trainCorpusMaxFallbackTokenShare,
  maxSourceTokenShare: config.trainMaxSourceTokenShare,
  maxPublisherTokenShare: config.trainMaxPublisherTokenShare,
  mergeSourceRawText: config.trainMergeSourceRawText,
  supportedLanguages: config.trainSupportedLanguages,
  languageMinConfidence: config.trainLanguageMinConfidence,
  languageUnknownPolicy: config.trainLanguageUnknownPolicy,
};
const evalManifestSource = path.join("/var/lib/simpleminds/data/evaluation", `${config.evalDatasetId}.manifest.json`);
const evalManifestLocal = path.join(paths.evaluation, `${config.evalDatasetId}.manifest.json`);
const evalManifestFile = existsSync(evalManifestLocal)
  ? evalManifestLocal
  : existsSync(evalManifestSource)
    ? evalManifestSource
    : null;
// A materially different runtime must not silently reuse an old candidate.
// If the runtime cannot be probed, fail closed rather than produce a key that
// pretends the environment is unchanged.
const runtimeFingerprint = computeRuntimeFingerprint({
  root: REPO_ROOT,
  store: PYTHON_STORE,
});
const candidateIdentity = buildCandidateIdentity({
  root: REPO_ROOT,
  parentVersion: PARENT_VERSION,
  storeRoot: PYTHON_STORE,
  corpusFingerprint: corpusHash,
  evaluationFile: evalTarget,
  evaluationManifestFile: evalManifestFile,
  tokenizerFile: path.join(PYTHON_STORE, PARENT_VERSION, "tokenizer.json"),
  trainingConfig: keyConfig,
  seed: config.trainSeed,
  splitPolicy: {
    policyVersion: SPLIT_POLICY_VERSION,
    clusterVersion: CLUSTER_POLICY_VERSION,
    seed: config.trainValidationSeed,
  },
  environmentFingerprint: runtimeFingerprint,
});
const candidateKey = candidateIdentity.candidateKey;
const markerPath = path.join(CANDIDATE_ROOT, "candidate-key.json");
let previous = null;
try { previous = JSON.parse(await readFile(markerPath, "utf8")); } catch { previous = null; }
if (!FORCE && previous?.key === candidateKey) {
  await source.close();
  console.log(JSON.stringify({
    ok: true,
    skipped: true,
    reason: "unchanged corpus and training configuration; set CANDIDATE_FORCE=1 to rerun",
    candidateRoot: CANDIDATE_ROOT,
    parentVersion: PARENT_VERSION,
    corpusOnly: CORPUS_ONLY,
    corpusHash,
    candidateKey,
    candidateIdentity,
    corpusStats: collected.stats,
    previous,
  }, null, 2));
  process.exit(0);
}

const registry = await RegistryStore.open(registryDir);
const trainer = selectTrainer();
let summary;
try {
  const out = await executeFullRun({
    registry,
    options: {
      paths,
      snapshotLimit: config.snapshotLimit,
      parentVersion: PARENT_VERSION,
      allowCorpusOnly: CORPUS_ONLY,
      candidateIdentity,
    },
    deps: {
      store,
      trainer,
      markConsumed: store.markConsumed,
      evalSeed: defaultEvalSeed,
      setActive: async (version) => ({ version, skipped: true, reason: "isolated candidate" }),
      worker: null,
    },
  });
  summary = {
    ok: true,
    candidateRoot: CANDIDATE_ROOT,
    pythonStore: PYTHON_STORE,
    parentVersion: PARENT_VERSION,
    corpusOnly: CORPUS_ONLY,
    corpusHash,
    candidateKey,
    candidateIdentity,
    skipped: false,
    config: {
      corpusMode: config.trainCorpusMode,
      includeConsumed: config.snapshotIncludeConsumed,
      snapshotLimit: config.snapshotLimit,
      replayPercent: config.trainReplayPercent,
      targetEpochs: config.trainTargetEpochs,
      maxSteps: config.trainMaxSteps,
      minSteps: config.trainMinSteps,
      minUniqueTokens: config.trainMinUniqueTokens,
      warmup: config.trainWarmup,
      seqLen: config.trainSeqLen,
      microBatch: config.trainMicroBatch,
      gradAccum: config.trainGradAccum,
      documentBoundary: config.trainDocumentBoundary,
      evalDatasetId: config.evalDatasetId,
    },
    runId: out.run?.runId ?? null,
    status: out.run?.status ?? null,
    decision: out.decision?.decision ?? null,
    reason: out.decision?.reason ?? null,
    baselineVersion: out.run?.baseModelVersion ?? null,
    candidateVersion: out.run?.runLinkage?.pythonVersion ?? null,
    baselineLoss: out.run?.baselineEvaluation?.loss ?? null,
    candidateLoss: out.run?.trainedEvaluation?.loss ?? null,
    evaluationDelta: out.run?.evaluationDelta ?? null,
    promotionNoiseBand: out.run?.promotionNoiseBand ?? null,
    trainingBudget: out.run?.trainingBudget ?? null,
    corpusAccounting: out.run?.corpusAccounting ?? null,
    corpusPreflight: out.run?.corpusPreflight ?? null,
    checkpointSelection: out.run?.checkpointSelection ?? null,
    generationQuality: out.run?.generationQuality ?? null,
    snapshot: out.snapshot?.manifest ?? null,
    run: out.run ?? null,
  };
} catch (err) {
  summary = {
    ok: false,
    candidateRoot: CANDIDATE_ROOT,
    parentVersion: PARENT_VERSION,
    corpusOnly: CORPUS_ONLY,
    corpusHash,
    candidateKey,
    candidateIdentity,
    skipped: false,
    error: err.message,
    code: err.code ?? null,
    stack: err.stack,
  };
  process.exitCode = 1;
} finally {
  try {
    await writeFile(markerPath, JSON.stringify({
      key: candidateKey,
      corpusHash,
      corpusOnly: CORPUS_ONLY,
      config: keyConfig,
      status: summary?.ok ? "completed" : "failed",
      finishedAt: new Date().toISOString(),
      result: summary,
    }, null, 2) + "\n", "utf8");
  } catch {
    /* marker is advisory; never mask the run result */
  }
  await registry.close();
  await store.close();
}
console.log(JSON.stringify(summary, null, 2));
