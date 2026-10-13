import path from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { config } from "../config.js";
import { createHash } from "node:crypto";
import { collectRowsFromArticles, buildSnapshot } from "../dataset/snapshot.js";
import { loadEvaluationSet, makeEvalGuard } from "../dataset/evaluation-set.js";
import { validateCurriculum, fallbackCurriculum } from "../curriculum/validation.js";
import { Evaluator, decidePromotion } from "./evaluator.js";
import { decidePromotionByLoss, evaluateVersionLoss } from "./loss-evaluator.js";
import { setActiveVersion } from "./python-promotion.js";
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
function computeFileHash(filePath) {
  return createHash("sha256")
    .update(readFileSync(filePath, "utf8"), "utf8")
    .digest("hex");
}



/** Persist the run manifest as JSON for crash recovery and audit. */
async function persistManifest(manifestPath, manifest) {
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
}

/** Read the run manifest if it exists; return null when absent. */
async function readManifest(manifestPath) {
  try {
    const raw = await readFile(manifestPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Update the run manifest with current state. */
async function updateManifest(manifestPath, manifest, fields) {
  const updated = { ...manifest, ...fields };
  await persistManifest(manifestPath, updated);
  return updated;
}

export async function executeFullRun({
  registry,
  deps = {},
  options = {},
  logger = console,
}) {
  const {
    store,                 // ArticleStore-like: articlesPage / getStats / markConsumed
    trainer = null,        // { train(...) -> TrainingResult }
    complete = null,       // async (prompt) => { text }
    markConsumed = null,   // async (articleIds, { runId }) -> { consumed, skipped }
    evalSeed = null,       // () -> rows
    planBuilder = null,    // (stats) -> curriculum
    evaluateLoss = evaluateVersionLoss, // Python loss gate (injectable for tests)
    setActive = setActiveVersion,       // move the serving pointer (injectable)
    worker = null,         // student worker to reload after a promotion
  } = deps;

  const commitConsumption =
    markConsumed ?? ((ids, runId) => store.markConsumed(ids, { runId }));

  const limit = options.snapshotLimit ?? config.snapshotLimit;
  const t = assertTrainer(trainer);
  const pythonMode = t.kind === "python";
  // The legacy token-F1 evaluator is only constructed for the stub path; the
  // real brain is scored by the Python loss gate on the same frozen eval set.
  const evaluator = pythonMode
    ? null
    : new Evaluator({ complete: complete ?? (await import("./model-handle.js")).makeCompletor(), registry });

  // Commit-on-promotion requires a trainer that can stage an unpublished
  // candidate and then publish or discard it. The stub trainer and the fake
  // trainers in tests expose neither, so staging is gated on the capability
  // rather than on `pythonMode` alone; without it the old (immediate-publish)
  // behaviour is preserved exactly.
  const stagingSupported =
    pythonMode &&
    typeof t.publishCandidate === "function" &&
    typeof t.discardCandidate === "function";

  // Recovery is lock-driven: acquiring the lock reclaims a dead owner's run
  // (see RegistryStore.acquireRunLock) without blanket-failing unrelated runs.
  if (!(await registry.acquireRunLock(config.runLockStaleMs))) {
    throw new Error("another training run is already in progress (RUN.lock held)");
  }

  let runId = null;
  let consumption; // defined in each branch, used in trainerNotes
  // Hoisted so the crash-recovery path can re-drive the idempotent commit
  // sequence from the persisted manifest without re-running training.
  let evalSet = null;
  let snapshot = null;
  let trainingResult = null;
  let baselineResult = null;
  let candidateResult = null;
  let decision = null;
  let manifest = null;
  let manifestPath = null;
  try {
    // ---- immutable evaluation set (frozen on first load) ----
    evalSet = await loadEvaluationSet({
      datasetId: options.evalDatasetId,
      dir: options.paths?.evaluation,
      seed: evalSeed,
    });

    // ---- immutable, capped, leak-guarded snapshot ----
    const { rows } = collectRowsFromArticles(store, { limit });
    snapshot = await buildSnapshot({
      registry,
      rowsRaw: rows,
      dir: options.paths?.snapshots,
      evalGuard: makeEvalGuard(evalSet),
    });

    if (!snapshot.rows.length) {
      throw new Error("dataset empty after snapshot guards (no reviewed, unconsumed articles)");
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
    // The Python path resolves its committed parent FIRST: the registry baseline
    // model and the run's baseModel must reference the real serving lineage. An
    // explicit training-parent (from the dashboard selector) is validated
    // fail-closed via resolveVersion and never silently swapped for the active
    // pointer.
    const requestedParent = options.parentVersion ?? null;
    const pythonBaseline = pythonMode
      ? requestedParent
        ? (typeof t.resolveVersion === "function" ? await t.resolveVersion(requestedParent) : null)
        : await t.resolveBaseline()
      : null;
    if (pythonMode && requestedParent && !pythonBaseline) {
      throw new Error(`trainer cannot resolve an explicit parent version (${requestedParent})`);
    }

    // ---- corpus preflight (Python path only) ----
    // A snapshot shorter than one `--seq-len` block cannot train. Sizing it here
    // (tokenizer only, no model load) keeps a too-small snapshot from ever
    // becoming a failed TrainingRun, and lets a continuous job wait for more
    // material instead of crashing with a Python traceback.
    if (pythonMode && typeof t.preflight === "function") {
      const info = await t.preflight({
        datasetFile: snapshot.manifest.file,
        parentVersion: pythonBaseline?.version ?? null,
      });
      if (info && info.ok === false) {
        const err = new Error(
          info.error ?? "insufficient corpus: the snapshot cannot form one training block",
        );
        err.code = info.code ?? "INSUFFICIENT_CORPUS";
        err.blockCount = info.blockCount ?? 0;
        throw err;
      }
    }
    const baselineModel = pythonMode
      ? await ensurePythonBaselineModel(registry, pythonBaseline)
      : await ensureBaselineModel(registry);
    const run = await registry.createRun({
      baseModel: baselineModel.modelId,
      baseModelVersion: pythonBaseline?.version ?? null,
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
    registry.bindRunLock(runId);
    await registry.runEvent(runId, { status: "running", note: "snapshot+plan locked in" });

    // Initialize the run manifest for crash recovery and audit (Refinements #1, #2, #3).
    // The manifest is persisted to disk so that on restart we can recover the
    // last completed stage without double‑consuming or incorrectly activating.
    manifestPath = path.join(options.paths?.snapshots ?? config.paths.snapshots, `${runId}-manifest.json`);
    manifest = {
      runId,
      status: "created",
      snapshotArticleIds: snapshot.rows.map((r) => r.articleId),
      evaluationSetHash: computeFileHash(evalSet.file),
      baselineLoss: null,
      candidateLoss: null,
      decision: null,
      published: false,
      consumed: false,
      activated: false,
      error: null,
    };
    await persistManifest(manifestPath, manifest);
    await updateManifest(manifestPath, manifest, {
      status: "running",
    });

    // ---- BASELINE evaluation (before training) ----
    baselineResult = pythonMode
      ? await evaluateLoss({
          version: pythonBaseline.version,
          evalSetFile: evalSet.file,
          store: config.pythonStore ?? undefined,
          bin: config.pythonBin ?? undefined,
          device: config.studentDevice,
        })
      : await evaluator.evaluate({
          modelId: baselineModel.modelId,
          kind: "baseline",
          evalSet,
          statusLog: () => registry.runEvent(runId, { status: "running", note: "baseline evaluation complete" }),
        });

    // ---- train (never touches the live buffer; reads the snapshot file) ----
    // With a staging-capable trainer the candidate is built as an UNPUBLISHED
    // `vNNN.tmp`; it becomes an immutable `vNNN` only if the loss gate promotes
    // it. Without staging support (stub/fake trainers) the trainer publishes
    // immediately, exactly as before.
    trainingResult = await t.train({
      datasetFile: snapshot.manifest.file,
      baseModel: baselineModel.modelId,
      runId,
      stageOnly: stagingSupported,
      configuration: {
        plan,
        checkpointDir: options.paths?.models ?? config.paths.models,
        recordCount: snapshot.manifest.recordCount,
        parentVersion: pythonBaseline?.version ?? null,
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
      meta: pythonMode
        ? {
            pythonVersion: trainingResult.version,
            parentVersion: trainingResult.parentVersion,
            avgLoss: trainingResult.finalTrainLoss,
            datasetHash: trainingResult.datasetHash,
            tokensSeen: trainingResult.tokensSeen,
          }
        : { avgLoss: trainingResult.avgLoss, importanceMix: trainingResult.importanceMix },
    });

    // ---- AFTER evaluation (candidate) ----
    await registry.runEvent(runId, { status: "evaluating", note: "candidate evaluation running" });
    candidateResult = pythonMode
      ? await evaluateLoss({
          version: trainingResult.version,
          evalSetFile: evalSet.file,
          staged: trainingResult.staged === true,
          store: config.pythonStore ?? undefined,
          bin: config.pythonBin ?? undefined,
          device: config.studentDevice,
        })
      : await evaluator.evaluate({
          modelId: candidate.modelId,
          kind: "candidate",
          evalSet,
          statusLog: () => registry.runEvent(runId, { status: "evaluating", note: "candidate evaluation complete" }),
        });

    // ---- deterministic promote/reject ----
    decision = pythonMode ? decidePromotionByLoss(baselineResult, candidateResult, {}) : decidePromotion(baselineResult, candidateResult, config);

    // Commit-on-promotion: with a staging-capable trainer the candidate is an
    // unpublished `vNNN.tmp` right now. It is promoted into an immutable `vNNN`
    // ONLY on a real promotion, and discarded (provenance retained) otherwise, so
    // a rejected candidate never enters the published lineage nor becomes active.
    const stagedCandidate = stagingSupported && trainingResult.staged === true;
    const published = stagedCandidate || trainingResult.published !== false;

    if (pythonMode) {
      // Record the evaluation-set hash for provenance and the promotion gate.
      await updateManifest(manifestPath, manifest, {
        evaluationSetHash: computeFileHash(evalSet.file),
        baselineLoss: baselineResult.loss,
        candidateLoss: candidateResult.loss,
        decision: decision.decision,
      });
    }

    // Consumption rule (Refinement #1):
    //   - not_evaluated (training/eval failed): do not consume; retry safely.
    //   - rejected: consume the completed run, never promote.
    //   - promoted: publish, activate, complete the manifest, then consume.
    //
    // The ordering publication -> active pointer -> manifest -> consumption is
    // load-bearing: every earlier step is durable and idempotent, and the
    // exactly-once consumption commit runs last, so a crash between any two steps
    // is recoverable by retrying the next one without double-consuming.
    if (decision.decision === "not_evaluated") {
      if (stagedCandidate) await discardRejected(t, trainingResult.version, runId, options, logger);
      await updateManifest(manifestPath, manifest, {
        consumed: false,
        published: false,
        status: "failed",
        error: decision.reason ?? "not_evaluated",
      });
    } else if (decision.decision === "rejected") {
      if (stagedCandidate) await discardRejected(t, trainingResult.version, runId, options, logger);
      await updateManifest(manifestPath, manifest, {
        consumed: false,
        published: false,
        activated: false,
        status: "rejected",
      });
      consumption = await commitConsumption(
        snapshot.manifest.articleIds ?? snapshot.rows.map((r) => r.articleId),
        runId
      );
      manifest.consumed = true;
      manifest.activated = false;
      await updateManifest(manifestPath, manifest, { consumed: true });
    } else {
      // decision.decision === "promoted": 1) publication, 2) active pointer,
      // 3) manifest completion, 4) consumption commit.
      if (stagedCandidate) {
        await t.publishCandidate(trainingResult.version, {
          store: config.pythonStore ?? undefined,
          bin: config.pythonBin ?? undefined,
        });
      }
      if (pythonMode) {
        await setActive(trainingResult.version, {
          store: config.pythonStore ?? undefined,
          bin: config.pythonBin ?? undefined,
          models: options.paths?.models ?? config.paths.models,
        });
        if (worker) await worker.reload();
      }
      await updateManifest(manifestPath, manifest, {
        consumed: false,
        published,
        activated: true,
        status: "promoted",
      });
      consumption = await commitConsumption(
        snapshot.manifest.articleIds ?? snapshot.rows.map((r) => r.articleId),
        runId
      );
      manifest.consumed = true;
      manifest.activated = true;
      await updateManifest(manifestPath, manifest, { consumed: true });
    }

    // ---- persist the decision on the model, then close the run ----
    await registry.modelEvent(candidate.modelId, {
      status: decision.decision === "promoted" ? "promoted" : "rejected",
      evaluationScore: pythonMode ? candidateResult.loss : candidateResult.score100,
      evalRunId: pythonMode ? null : candidateResult.evalRunId,
      note: pythonMode
        ? `loss ${fmt(baselineResult.loss)} -> ${fmt(candidateResult.loss)} (improvement ${fmt(decision.improvement)}); ${decision.reason}`
        : `delta ${decision.delta.toFixed(4)} (${decision.base.toFixed(4)} -> ${decision.candidate.toFixed(4)})`,
    });

    await registry.completeRun(runId, {
      status: decision.decision === "promoted" ? "promoted" : "rejected",
      promotionStatus: decision.decision,
      resultModelId: candidate.modelId,
      examplesProcessed: trainingResult.recordsProcessed ?? snapshot.manifest.recordCount,
      examplesSkipped: Math.max(0, rows.length - snapshot.manifest.recordCount),
      baselineEvaluation: pythonMode
        ? { loss: baselineResult.loss, datasetHash: baselineResult.datasetHash, version: pythonBaseline.version }
        : { evalRunId: baselineResult.evalRunId, score: baselineResult.score, score100: baselineResult.score100 },
      trainedEvaluation: pythonMode
        ? { loss: candidateResult.loss, datasetHash: candidateResult.datasetHash, version: trainingResult.version }
        : { evalRunId: candidateResult.evalRunId, score: candidateResult.score, score100: candidateResult.score100 },
      evaluationDelta: pythonMode ? decision.improvement : decision.delta,
      activatedVersion: pythonMode && decision.decision === "promoted" ? trainingResult.version : null,
      // Run linkage: Node run -> frozen dataset -> Python execution -> committed
      // candidate. Checkpoint path/version stay a secondary integrity check.
      runLinkage: pythonMode
        ? {
            nodeRunId: runId,
            pythonTrainingRunId: trainingResult.trainingRunId,
            pythonVersion: trainingResult.version,
            parentVersion: trainingResult.parentVersion,
            datasetId: snapshot.manifest.datasetId,
            datasetFile: snapshot.manifest.file,
            datasetHash: trainingResult.datasetHash,
            evaluationDatasetHash: candidateResult.datasetHash,
            checkpointPath: trainingResult.checkpointPath,
          }
        : null,
      trainerNotes: {
        note: trainingResult.note ?? (trainer?.kind === "stub" ? "stub trainer (placeholder kernels)" : null),
        checkpointPath: trainingResult.checkpointPath,
        articlesConsumed: commitConsumption,
        alreadyConsumedSkipped: consumption?.skipped?.length ?? 0,
        leakExcluded: snapshot.excluded.length,
      },
    });

    logger.log && logger.log(`[lifecycle] run ${runId} -> ${decision.decision} (delta ${fmt(decision.improvement ?? decision.delta)})`);
    return {
      decision,
      baseline: baselineResult,
      candidate: candidateResult,
      snapshot,
      plan,
      run: registry.getRun(runId),
    };
  } catch (err) {
    // Crash recovery. A crash after the promotion decision but before the
    // exactly-once consumption commit must be re-driven here; every step it
    // retries is durable and idempotent (publishing an already-committed version
    // is a no-op, activating the same version is a no-op, consumption skips what
    // is already consumed), so retrying never duplicates a version or a
    // consumption.
    if (runId) {
      try {
        manifestPath =
          manifestPath ?? path.join(options.paths?.snapshots ?? config.paths.snapshots, `${runId}-manifest.json`);
        const savedManifest = await readManifest(manifestPath);
        if (savedManifest && savedManifest.decision === "promoted" && savedManifest.consumed === false) {
          await completePromotion({
            runId,
            savedManifest,
            manifestPath,
            trainer: t,
            trainerResult: trainingResult,
            options,
            commitConsumption,
            setActive,
            worker,
          });
        } else if (
          savedManifest &&
          savedManifest.decision === "rejected" &&
          savedManifest.consumed === false
        ) {
          // Evaluation completed and rejected the candidate, but consumption was
          // never committed: discard the staged candidate (idempotent) and close
          // the ledger. The candidate is never published.
          if (producedStage(trainingResult, stagingSupported) && trainingResult?.version) {
            await discardRejected(t, trainingResult.version, runId, options, logger);
          }
          consumption = await commitConsumption(savedManifest.snapshotArticleIds ?? [], runId);
          await updateManifest(manifestPath, savedManifest, { consumed: true });
        } else if (savedManifest && savedManifest.status === "failed") {
          // Already terminal; nothing to re-drive.
        } else {
          await registry.runEvent(runId, {
            status: "failed",
            note: "crash recovery: no completed decision to commit",
          });
        }
      } catch (recErr) {
        logger.error && logger.error(`[lifecycle] run ${runId} recovery error: ${recErr.message}`);
      }
    }
    if (runId) {
      try {
        await registry.runEvent(runId, { status: "failed", note: `training run failed: ${err.message}` });
      } catch (eventErr) {
        logger.error && logger.error(`[lifecycle] could not record failure for ${runId}: ${eventErr.message}`);
      }
    }
    throw err;
  } finally {
    try {
      registry.releaseRunLock();
    } catch {
      // releasing a lock that is already gone is not a failure
    }
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

/**
 * The registry model that represents the committed Python parent version. It is
 * found by `meta.pythonVersion`, so the same modelId is reused across every run
 * in a lineage instead of registering a new baseline row each time.
 */
async function ensurePythonBaselineModel(registry, baseline) {
  const existing = registry
    .listModels()
    .find((m) => m.kind === "python" && m.meta?.pythonVersion === baseline.version);
  if (existing) return modelHandle(existing);
  const base = await registry.registerModel({
    kind: "python",
    baseModel: config.baseModel,
    checkpointPath: baseline.path,
    meta: { pythonVersion: baseline.version, adopted: true },
  });
  return modelHandle(base);
}

/** True when this run's trainer produced an unpublished staged candidate. */
function producedStage(trainingResult, stagingSupported) {
  return stagingSupported && trainingResult?.staged === true;
}

/**
 * Discard a rejected staged candidate while retaining its small provenance
 * record. Fail-soft: a discard problem must never turn a clean rejection into a
 * failed run, and the staged directory is re-swept on the next run anyway.
 */
async function discardRejected(trainer, version, runId, options, logger) {
  const recordDir = path.join(
    options.paths?.snapshots ?? config.paths.snapshots,
    "rejected",
    `${runId}-${version}`,
  );
  try {
    return await trainer.discardCandidate(version, {
      store: config.pythonStore ?? undefined,
      bin: config.pythonBin ?? undefined,
      recordDir,
    });
  } catch (err) {
    logger?.error && logger.error(`[lifecycle] discard of staged ${version} failed: ${err.message}`);
    return null;
  }
}

/**
 * Re-drive the idempotent tail of a promotion after a crash: publish (no-op if
 * already committed), move the active pointer, complete the manifest, then
 * commit consumption last. The candidate version is read from the trainer result
 * when in-process, or from the manifest on a restart.
 */
async function completePromotion({
  runId,
  savedManifest,
  manifestPath,
  trainer,
  trainerResult,
  options,
  commitConsumption,
  setActive,
  worker,
}) {
  const version = trainerResult?.version ?? savedManifest.resultVersion ?? null;
  if (!version) {
    await updateManifest(manifestPath, savedManifest, {
      status: "failed",
      error: "promotion recovery found no candidate version",
    });
    return null;
  }
  if (producedStage(trainerResult, true) && typeof trainer.publishCandidate === "function") {
    await trainer.publishCandidate(version, {
      store: config.pythonStore ?? undefined,
      bin: config.pythonBin ?? undefined,
    });
  }
  await setActive(version, {
    store: config.pythonStore ?? undefined,
    bin: config.pythonBin ?? undefined,
    models: options.paths?.models ?? config.paths.models,
  });
  if (worker) await worker.reload();
  await updateManifest(manifestPath, savedManifest, {
    published: true,
    activated: true,
    status: "promoted",
    consumed: false,
  });
  const consumption = await commitConsumption(savedManifest.snapshotArticleIds ?? [], runId);
  await updateManifest(manifestPath, savedManifest, { consumed: true });
  return consumption;
}

function fmt(x) {
  return Number.isFinite(x) ? x.toFixed(4) : String(x ?? "n/a");
}

function flattenPlan(plan, snapshot) {
  return {
    at: new Date().toISOString(),
    source: plan.source ?? "validated",
    curriculum: plan.curriculum,
    datasetId: snapshot.manifest.datasetId,
    datasetVersion: snapshot.manifest.datasetVersion,
    recordCount: snapshot.manifest.recordCount,
    syntheticShare: snapshot.manifest.syntheticShare,
    leakExcluded: snapshot.excluded.length,
  };
}

async function persistPlan(record, dir = config.paths.plans) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `plan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
  await writeFile(file, JSON.stringify(record, null, 2), "utf8");
  return file;
}