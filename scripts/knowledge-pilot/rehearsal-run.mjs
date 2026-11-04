#!/usr/bin/env node
/** Real 62M bounded run with optional deterministic process crash at a boundary. */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../../src/config.js";
import { ArticleStore } from "../../src/storage/article-store.js";
import { RegistryStore } from "../../src/storage/registry-store.js";
import { pythonTrainer } from "../../src/training/python-trainer.js";
import { executeFullRun } from "../../src/training/lifecycle.js";
import { evaluateVersionLoss } from "../../src/training/loss-evaluator.js";

const CRASH = process.env.REHEARSAL_CRASH_POINT ?? null;
const STABLE = process.env.REHEARSAL_STABLE_VERSION ?? "v389";
const WORKING = process.env.REHEARSAL_WORKING_VERSION ?? "v001";
const KILL = () => process.kill(process.pid, "SIGKILL");

function parseArgs(argv) {
  const o = { out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") o.out = argv[++i];
  }
  return o;
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
  const realEvaluate = trainer.evaluateLoss ?? evaluateVersionLoss;
  const evaluateLoss = async (args) => {
    const version = args?.version;
    if (CRASH === "after-training-before-eval" && version && version !== STABLE && version !== WORKING) {
      process.stderr.write(`[rehearsal] crash after training before candidate eval: ${version}\n`);
      KILL();
    }
    return realEvaluate(args);
  };
  let result = null;
  let error = null;
  try {
    result = await executeFullRun({
      registry,
      deps: {
        store,
        trainer,
        evaluateLoss,
        markConsumed: async (ids, runId, meta = {}) => {
          if (CRASH === "after-working-pointer" && meta.checkpointRole === "working") {
            process.stderr.write(`[rehearsal] crash after working pointer before consumption: ${meta.version}\n`);
            KILL();
          }
          return store.markConsumed(ids, { runId, ...meta });
        },
      },
      options: { paths: config.paths, workingGuard: config.workingGuard },
      logger: console,
    });
  } catch (err) {
    error = { message: err.message, code: err.code ?? null };
  }
  const summary = {
    schema: "sma/operational-rehearsal-run@1",
    at: new Date().toISOString(),
    crashPoint: CRASH,
    config: {
      store: config.pythonStore, device: config.studentDevice, snapshotLimit: config.snapshotLimit,
      replayPercent: config.trainReplayPercent, seqLen: config.trainSeqLen, steps: config.trainMaxSteps,
      lr: config.trainLearningRate, epochs: config.trainTargetEpochs,
      workingGuard: config.workingGuard, useWorking: config.trainUseWorkingCheckpoint,
      carryOptimizer: config.trainCarryOptimizer,
    },
    result: result ? {
      decision: result.decision,
      run: result.run,
      snapshot: result.snapshot?.manifest ? {
        datasetId: result.snapshot.manifest.datasetId,
        fresh: result.snapshot.manifest.freshArticleIds?.length,
        replay: result.snapshot.manifest.replayArticleIds?.length,
        validation: result.snapshot.manifest.validationArticleIds?.length,
        hash: result.snapshot.hash,
      } : null,
    } : null,
    error,
    stats: store.getStats(),
    contributions: store.listContributions().slice(-2),
  };
  if (opts.out) await writeFile(opts.out, JSON.stringify(summary, null, 2) + "\n");
  await store.close();
  await registry.close();
  if (error) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
