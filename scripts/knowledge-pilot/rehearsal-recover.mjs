#!/usr/bin/env node
/** Run the real recovery path over an isolated rehearsal store. */
import { writeFile } from "node:fs/promises";
import { config } from "../../src/config.js";
import { ArticleStore } from "../../src/storage/article-store.js";
import { RegistryStore } from "../../src/storage/registry-store.js";
import { pythonTrainer } from "../../src/training/python-trainer.js";
import { recoverPendingPromotions } from "../../src/training/lifecycle.js";

const out = process.argv[2] ?? null;
async function main() {
  const store = await ArticleStore.open(config.paths.articles);
  const registry = await RegistryStore.open(config.paths.registry);
  const trainer = pythonTrainer({
    store: config.pythonStore ?? undefined,
    bin: config.pythonBin ?? undefined,
    device: config.studentDevice,
    learningRate: config.trainLearningRate,
    seqLen: config.trainSeqLen,
    microBatch: config.trainMicroBatch,
    gradAccum: config.trainGradAccum,
    warmup: config.trainWarmup,
    valBlocks: config.trainValBlocks,
    evalEvery: config.trainEvalEvery,
    documentBoundary: config.trainDocumentBoundary,
    validationPolicy: config.trainValidationPolicy,
    seed: config.trainSeed,
    computeDtype: config.trainComputeDtype,
    selectBest: config.trainSelectBest,
    carryOptimizer: config.trainCarryOptimizer,
    timeoutMs: config.trainTimeoutMs,
  });
  const recovered = await recoverPendingPromotions({
    registry, store, trainer,
    options: { paths: config.paths },
    logger: { error: console.error, log: console.log },
  });
  const summary = {
    schema: "sma/operational-rehearsal-recovery@1",
    at: new Date().toISOString(),
    recovered,
    stats: store.getStats(),
    contributions: store.listContributions().slice(-2),
  };
  if (out) await writeFile(out, JSON.stringify(summary, null, 2) + "\n");
  else console.log(JSON.stringify(summary, null, 2));
  await store.close();
  await registry.close();
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
