#!/usr/bin/env node
/**
 * Run one bounded pilot training attempt through the real lifecycle in isolated
 * storage. Environment must point at pilot paths (see the work-package README).
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { config } from "../../src/config.js";
import { ArticleStore } from "../../src/storage/article-store.js";
import { RegistryStore } from "../../src/storage/registry-store.js";
import { pythonTrainer } from "../../src/training/python-trainer.js";
import { executeFullRun } from "../../src/training/lifecycle.js";
import { runPython } from "../../src/brain/python-cli.js";

function parseArgs(argv) {
  const opts = { out: null, label: "pilot-run" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") opts.out = argv[++i];
    else if (arg === "--label") opts.label = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/knowledge-pilot/run-pilot.mjs --out result.json [--label name]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
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
  let result;
  let error = null;
  try {
    result = await executeFullRun({
      registry,
      deps: { store, trainer },
      options: {
        paths: config.paths,
        workingGuard: config.workingGuard,
      },
      logger: console,
    });
  } catch (err) {
    error = { message: err.message, code: err.code ?? null, stack: err.stack };
  }
  const summary = {
    schema: "sma/knowledge-pilot-run@1",
    label: opts.label,
    at: new Date().toISOString(),
    config: {
      store: config.pythonStore,
      pythonBin: config.pythonBin,
      device: config.studentDevice,
      snapshotLimit: config.snapshotLimit,
      snapshotIncludeConsumed: config.snapshotIncludeConsumed,
      trainReplayPercent: config.trainReplayPercent,
      trainSeqLen: config.trainSeqLen,
      trainTargetEpochs: config.trainTargetEpochs,
      trainMaxSteps: config.trainMaxSteps,
      trainMinSteps: config.trainMinSteps,
      trainUseWorkingCheckpoint: config.trainUseWorkingCheckpoint,
      trainCarryOptimizer: config.trainCarryOptimizer,
      workingGuard: config.workingGuard,
      promoteEvalSet: config.promoteEvalSet,
      evalDatasetId: config.evalDatasetId,
    },
    statsBefore: store.getStats(),
    result: result
      ? {
          decision: result.decision,
          run: result.run,
          baseline: result.baseline
            ? { version: result.baseline.version, loss: result.baseline.loss, ok: result.baseline.ok }
            : null,
          candidate: result.candidate
            ? { version: result.candidate.version, loss: result.candidate.loss, ok: result.candidate.ok }
            : null,
          snapshot: result.snapshot?.manifest
            ? {
                datasetId: result.snapshot.manifest.datasetId,
                articleCount: result.snapshot.manifest.articleCount,
                freshArticleIds: result.snapshot.manifest.freshArticleIds,
                replayArticleIds: result.snapshot.manifest.replayArticleIds,
                validationArticleIds: result.snapshot.manifest.validationArticleIds,
                hash: result.snapshot.hash,
                file: result.snapshot.file,
              }
            : null,
        }
      : null,
    error,
    statsAfter: store.getStats(),
    contributions: store.listContributions().slice(-3),
  };
  const bytes = JSON.stringify(summary, null, 2) + "\n";
  if (opts.out) await writeFile(opts.out, bytes, "utf8");
  else process.stdout.write(bytes);
  await store.close();
  await registry.close();
  if (error) process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
