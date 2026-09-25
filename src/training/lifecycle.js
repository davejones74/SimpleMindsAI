import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { config } from "../config.js";
import { collectRowsFromBuffer, buildSnapshot } from "../dataset/snapshot.js";
import { loadEvaluationSet, makeEvalGuard } from "../dataset/evaluation-set.js";
import { validateCurriculum, fallbackCurriculum } from "../curriculum/validation.js";
import { Evaluator, decidePromotion } from "./evaluator.js";
import { assertTrainer } from "./trainer-interface.js";
import { modelHandle } from "./model-handle.js";

/**
 * Perpetual Training lifecycle — ONE TrainingRun from cradle to grave
 * (requirements #2, #5, #7, #8, #15).
 *
 *   recover → lock → eval-set (immutable) → snapshot (immutable + capped +
 *   leak-guarded) → plan (validated) → createRun → baseline eval →
 *   train → register candidate → candidate eval → decide → promote/reject →
 *   COMMIT consumption → completeRun
 *
 * Crash-safety boundary: `markConsumed` (the exactly-once commit) runs ONLY
 * after training AND evaluation succeeded. If the process dies anywhere before
 * that, the snapshot rows stay UNTRAINED in the buffer and the next invocation
 * re-collects them — no duplicate, no loss. RecoverStaleRuns() marks any run
 * stranded in created/running/evaluating as failed on the next start.
 */
export async function executeFullRun({
  registry,
  deps = {},
  options = {},
  logger = console,
}) {
  const {
    store,                 // BufferStore-like: promptsPage / getStats
    trainer = null,        // { train(...) -> TrainingResult }
    complete = null,       // async (prompt) => { text }
    markConsumed = null,   // async (promptIds, runId) -> void
    evalSeed = null,       // () -> rows, only consulted if eval set missing
    planBuilder = null,    // async ({stats}) -> raw LLM plan
  } = deps;

  const limit = options.snapshotLimit ?? config.snapshotLimit;
  const evaluator = new Evaluator({ complete: complete ?? (await import("./model-handle.js")).makeCompletor(), registry });

  await registry.recoverStaleRuns(config.runLockStaleMs);
  if (!(await registry.acquireRunLock(config.runLockStaleMs))) {
    throw new Error("another training run is already in progress (RUN.lock held)");
  }

  let runId = null;
  try {
    // ---- immutable evaluation set (frozen on first load) ----
    const evalSet = await loadEvaluationSet({
      datasetId: options.evalDatasetId,
      dir: options.paths?.evaluation,
      seed: evalSeed,
    });

    // ---- immutable, capped, leak-guarded snapshot ----
    const { rows, stats } = collectRowsFromBuffer(store, { limit });
    const snapshot = await buildSnapshot({
      registry,
      rowsRaw: rows,
      dir: options.paths?.snapshots,
      evalGuard: makeEvalGuard(evalSet),
    });

    if (!snapshot.rows.length) {
      throw new Error("dataset empty after snapshot guards (no new scored rows)");
    }

    // ---- validated curriculum plan ----
    const storeStats = typeof store.getStats === "function" ? store.getStats() : {};
    let plan;
    if (planBuilder) {
      const raw = await planBuilder(storeStats);
      const validated = validateCurriculum(raw?.plan ?? raw, { maxTotalExamples: limit });
      plan = validated.ok && validated.normalized ? validated : fallbackCurriculum(storeStats, { maxTotalExamples: limit });
    } else {
      plan = fallbackCurriculum(storeStats, { maxTotalExamples: limit });
    }
    const planRecord = flattenPlan(plan, snapshot);
    const planFile = await persistPlan(planRecord, options.paths?.plans ?? config.paths.plans);

    // ---- TrainingRun record (status: created) ----
    const baselineModel = await ensureBaselineModel(registry);
    const run = await registry.createRun({
      baseModel: baselineModel.modelId,
      datasetId: snapshot.manifest.datasetId,
      datasetVersion: snapshot.manifest.datasetVersion,
      datasetFile: snapshot.manifest.file,
      recordCount: snapshot.manifest.recordCount,
      criticModel: config.criticModel,
      criticVersion: config.criticVersion,
      rubricVersion: config.rubricVersion,
      curriculumVersion: config.curriculumVersion,
      curriculum: plan.curriculum,
      planFile,
      trainerVersion: trainer?.version ?? config.trainerVersion,
      trainerKind: trainer?.kind ?? config.trainerKind,
      examplesAvailable: rows.length,
    });
    runId = run.runId;
    await registry.runEvent(runId, { status: "running", note: "snapshot+plan locked in" });

    // ---- BASELINE evaluation (before training) ----
    const baselineResult = await evaluator.evaluate({
      modelId: baselineModel.modelId,
      kind: "baseline",
      evalSet,
      statusLog: () => registry.runEvent(runId, { status: "running", note: "baseline evaluation complete" }),
    });

    // ---- train (never touches the live buffer; reads the snapshot file) ----
    const t = assertTrainer(trainer);
    const trainingResult = await t.train({
      datasetFile: snapshot.manifest.file,
      baseModel: baselineModel.modelId,
      runId,
      configuration: {
        minReward: config.minReward,
        maxSyntheticShare: config.maxSyntheticShare,
        plan,
        checkpointDir: options.paths?.models ?? config.paths.models,
      },
    });

    // ---- candidate model registered ----
    const candidate = await registry.registerModel({
      kind: trainer?.kind ?? config.trainerKind,
      baseModel: config.baseModel,
      parentModelId: baselineModel.modelId,
      trainingRunId: runId,
      datasetId: snapshot.manifest.datasetId,
      checkpointPath: trainingResult.checkpointPath,
      meta: { avgReward: trainingResult.avgReward, avgLoss: trainingResult.avgLoss },
    });

    // ---- AFTER evaluation (candidate) ----
    await registry.runEvent(runId, { status: "evaluating", note: "candidate evaluation running" });
    const candidateResult = await evaluator.evaluate({
      modelId: candidate.modelId,
      kind: "candidate",
      evalSet,
      statusLog: () => registry.runEvent(runId, { status: "evaluating", note: "candidate evaluation complete" }),
    });

    // ---- deterministic promote/reject ----
    const decision = decidePromotion(baselineResult, candidateResult, config);

    // ---- the exactly-once commit: only after training + eval succeeded ----
    await markConsumed(snapshot.manifest.rowIds ?? snapshot.rows.map((r) => r.promptId), runId);

    // ---- persist the decision on the model, then close the run ----
    await registry.modelEvent(candidate.modelId, {
      status: decision.decision === "promoted" ? "promoted" : "rejected",
      evaluationScore: candidateResult.score100,
      evalRunId: candidateResult.evalRunId,
      note: `delta ${decision.delta.toFixed(4)} (${decision.base.toFixed(4)} -> ${decision.candidate.toFixed(4)})`,
    });

    await registry.completeRun(runId, {
      status: decision.decision,
      resultModelId: candidate.modelId,
      examplesProcessed: trainingResult.recordsProcessed ?? snapshot.manifest.recordCount,
      examplesSkipped: rows.length - snapshot.manifest.recordCount,
      baselineEvaluation: { evalRunId: baselineResult.evalRunId, score: baselineResult.score, score100: baselineResult.score100 },
      trainedEvaluation: { evalRunId: candidateResult.evalRunId, score: candidateResult.score, score100: candidateResult.score100 },
      evaluationDelta: decision.delta,
      promotionStatus: decision.decision,
      trainerNotes: {
        note: trainingResult.note ?? (trainer?.kind === "stub" ? "stub trainer (placeholder kernels)" : null),
        checkpointPath: trainingResult.checkpointPath,
        droppedSynthetic: snapshot.dropped.length,
        leakExcluded: snapshot.excluded.length,
        lowRewardSkipped: stats.lowReward + stats.noCompletion,
      },
    });

    logger.log && logger.log(`[lifecycle] run ${runId} -> ${decision.decision} (delta ${decision.delta.toFixed(4)})`);
    return {
      decision,
      baseline: baselineResult,
      candidate: candidateResult,
      snapshot,
      plan,
      run: registry.getRun(runId),
    };
  } catch (err) {
    if (runId) {
      await registry.runEvent(runId, { status: "failed", note: err.message });
      logger.error && logger.error(`[lifecycle] run ${runId} failed: ${err.message}`);
    }
    throw err;
  } finally {
    registry.releaseRunLock();
  }
}

async function ensureBaselineModel(registry) {
  const active = registry.getActiveModel();
  if (active) return modelHandle(active);
  // First promotion ladder: nothing exists yet, so the base model itself is the
  // baseline — registered so the run and evaluations reference a real modelId.
  const base = await registry.registerModel({ kind: "base", baseModel: config.baseModel });
  return modelHandle(base);
}

function flattenPlan(plan, snapshot) {
  return {
    at: new Date().toISOString(),
    source: plan.source ?? "validated",
    curriculum: plan.curriculum,
    maxSyntheticShare: plan.maxSyntheticShare,
    datasetId: snapshot.manifest.datasetId,
    datasetVersion: snapshot.manifest.datasetVersion,
    recordCount: snapshot.manifest.recordCount,
    syntheticShare: snapshot.manifest.syntheticShare,
    droppedSynthetic: snapshot.dropped.length,
    leakExcluded: snapshot.excluded.length,
  };
}

async function persistPlan(record, dir = config.paths.plans) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `plan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
  await writeFile(file, JSON.stringify(record, null, 2), "utf8");
  return file;
}