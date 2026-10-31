import path from "node:path";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { config } from "../config.js";
import { createHash } from "node:crypto";
import { collectRowsFromArticles, buildSnapshot } from "../dataset/snapshot.js";
import { buildPartition, InsufficientValidationError } from "../dataset/partition.js";
import { loadEvaluationSet, makeEvalGuard } from "../dataset/evaluation-set.js";
import { validateCurriculum, fallbackCurriculum } from "../curriculum/validation.js";
import { Evaluator, decidePromotion } from "./evaluator.js";
import { decidePromotionByLoss, evaluateVersionLoss } from "./loss-evaluator.js";
import { setActiveVersion } from "./python-promotion.js";
import { assertTrainer } from "./trainer-interface.js";
import { modelHandle } from "./model-handle.js";
import { baselineCacheKey, cacheEntrySatisfiesEvidence, loadEvalCache, saveEvalCache } from "./eval-cache.js";
import { computeTrainingBudget, checkMinimumTrainingData, computeEvaluationCadence } from "./budget.js";
import { evaluateGenerationQuality } from "./generation-quality.js";

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

/**
 * No reviewed, unconsumed article survived collection and the leak guards. The
 * `NO_ELIGIBLE_MATERIAL` code lets a continuous training job wait for new
 * material instead of failing, while a one-shot run surfaces it as a clear,
 * terminal error.
 */
function noEligibleMaterial() {
  const err = new Error("dataset empty after snapshot guards (no reviewed, unconsumed articles)");
  err.code = "NO_ELIGIBLE_MATERIAL";
  return err;
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
    measureGenerationQuality = evaluateGenerationQuality, // repetition check (injectable)
  } = deps;

  const commitConsumption =
    markConsumed ?? ((ids, runId) => store.markConsumed(ids, { runId }));

  const limit = options.snapshotLimit ?? config.snapshotLimit;
  // Corpus-only retraining is an EXPLICIT candidate workflow. It is never the
  // default: normal production learning still requires a fresh delta. When
  // enabled, the snapshot is built from accumulated REVIEWED material and the
  // run consumes no articles because there are no fresh ids.
  const corpusOnly = options.allowCorpusOnly === true;
  const validationPolicy = options.validationPolicy ?? config.trainValidationPolicy;
  const requireProspectiveValidation = options.requireProspectiveValidation ?? config.trainValidationRequireProspective;
  const corpusPolicy = corpusOnly ? "accumulated-reviewed-corpus" : "fresh-delta";
  const t = assertTrainer(trainer);
  const pythonMode = t.kind === "python";
  if (pythonMode) {
    if (validationPolicy !== "document-source-disjoint") {
      const err = new Error(
        `production Python training requires TRAIN_VALIDATION_POLICY=document-source-disjoint ` +
          `(got ${validationPolicy})`,
      );
      err.code = "INVALID_VALIDATION_POLICY";
      throw err;
    }
    if (requireProspectiveValidation !== true) {
      const err = new Error(
        "production Python training requires TRAIN_VALIDATION_REQUIRE_PROSPECTIVE=true; " +
          "historical exposure must not be relabelled as prospective",
      );
      err.code = "PROSPECTIVE_VALIDATION_REQUIRED";
      throw err;
    }
  }
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
    // A held RUN.lock is a NORMAL, expected condition when several processes
    // train (the Observatory's jobs and `npm run perpetual` share this lock).
    // Throw a TYPED error so callers can distinguish "wait and retry" from a
    // genuine training fault; the best-effort holder diagnostics are attached
    // for operators, but the lock token is never included.
    const info = typeof registry.runLockInfo === "function" ? registry.runLockInfo() : null;
    const who = info
      ? `pid ${info.pid ?? "?"} on ${info.host ?? "?"}${info.runId ? ` (run ${info.runId})` : ""}`
      : "another process";
    const err = new Error(`another training run is already in progress (RUN.lock held by ${who})`);
    err.code = "RUN_LOCK_HELD";
    if (info) err.lock = info;
    throw err;
  }

  // Finish any promotion a previous process left uncommitted BEFORE starting new
  // work, so a crash at the publish/activate/consume boundary is transparently
  // healed and never leaves an unpublished-but-decided candidate behind. Every
  // step is idempotent; a failure here is logged, never fatal.
  try {
    // Pass the run's own consumption function so an injected `markConsumed`
    // (tests, alternate stores) is honoured during recovery too.
    await recoverPendingPromotions({
      registry,
      store,
      trainer: t,
      options: { ...options, markConsumed: commitConsumption },
      logger,
      setActive,
      worker,
    });
  } catch (err) {
    logger?.error && logger.error(`[lifecycle] pending-promotion recovery skipped: ${err.message}`);
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
  let generationQuality = null;
  try {
    // ---- immutable evaluation set (frozen on first load) ----
    evalSet = await loadEvaluationSet({
      datasetId: options.evalDatasetId,
      dir: options.paths?.evaluation,
      seed: evalSeed,
    });

    // ---- immutable, capped, leak-guarded snapshot ----
    const collected = collectRowsFromArticles(store, {
      limit,
      replayPercent: config.trainReplayPercent,
      validationBlocks: config.trainValBlocks,
      validationSeqLen: config.trainSeqLen,
      corpusMode: config.trainCorpusMode,
      deferValidationPartition: pythonMode && validationPolicy === "document-source-disjoint",
    });
    const { rows } = collected;
    let { freshArticleIds, replayArticleIds, validationArticleIds } = collected;
    const corpusStats = collected.stats;
    // Refuse BEFORE baking an artifact when there is nothing to collect: a
    // continuous job treats this as a wait condition and polls, so an empty
    // snapshot manifest must not be appended on every cycle.
    if (!rows.length) throw noEligibleMaterial();
    // Corpus backfill (SNAPSHOT_INCLUDE_CONSUMED) may pad the snapshot with
    // already-consumed articles, but an incremental run must still be driven by
    // NEW material. Corpus-only retraining is a separate, explicit workflow;
    // ordinary lifecycle calls keep the fresh-delta guard unchanged.
    if (!freshArticleIds.length && !corpusOnly) throw noEligibleMaterial();

    let partition = null;
    if (pythonMode && validationPolicy === "document-source-disjoint") {
      const priorSnapshots = typeof registry.listSnapshots === "function" ? registry.listSnapshots() : [];
      const priorArticleIds = new Set();
      // A persisted snapshot is NOT by itself proof of training exposure: the
      // manifest is written before baseline evaluation and before `train`, so a
      // run that fails earlier (CLI/preflight) still leaves one behind. Counting
      // such a snapshot would permanently relabel still-unconsumed material as
      // historically exposed, and a retry could never obtain a prospective
      // validation cluster. Only snapshots actually linked to a TrainingRun
      // count; a run is created immediately before training, after the
      // preflight, so an unlinked snapshot was never presented to the trainer.
      const priorRuns = typeof registry.listRuns === "function" ? registry.listRuns() : [];
      const runDatasetIds = new Set(
        priorRuns
          .filter((run) => run?.datasetId && run.status !== "created")
          .map((run) => run.datasetId),
      );
      for (const prior of priorSnapshots) {
        if (!runDatasetIds.has(prior.datasetId)) continue;
        for (const id of prior.articleIds ?? []) priorArticleIds.add(id);
      }
      // Historical exposure is broader than snapshots: the article store's
      // durable consumption and contribution ledgers record material that
      // appeared in completed training runs even when the snapshot record is not
      // available in this workspace. Missing ledgers are reported as uncertainty,
      // never as proof that material was unseen.
      for (const record of store.consumption ?? []) {
        if (record?.articleId) priorArticleIds.add(record.articleId);
      }
      for (const record of store.contributions ?? []) {
        for (const id of [...(record.freshArticleIds ?? []), ...(record.replayArticleIds ?? [])]) {
          if (id) priorArticleIds.add(id);
        }
      }
      const freshIds = new Set(freshArticleIds);
      const historicalArticleIds = new Set(priorArticleIds);
      for (const row of rows) {
        if (!freshIds.has(row.articleId)) historicalArticleIds.add(row.articleId);
      }
      // Keep the Node-held validation cohort aligned with the trainer's
      // requested validation blocks. An explicit token target overrides this;
      // the fraction is used only when neither is configured.
      const derivedValidationTokens = config.trainValidationTargetTokens > 0
        ? config.trainValidationTargetTokens
        : Math.max(0, config.trainValBlocks * config.trainSeqLen);
      partition = buildPartition({
        rows,
        splitSeed: config.trainValidationSeed,
        validationFraction: derivedValidationTokens > 0 ? 0 : config.trainValidationFraction,
        validationTargetTokens: derivedValidationTokens,
        minValidationTokens: config.trainMinValidationTokens,
        minValidationClusters: config.trainMinValidationClusters,
        historicalArticleIds,
        requireProspective: requireProspectiveValidation,
      });
      const validationIds = new Set(partition.validationArticleIds);
      for (const row of rows) {
        if (validationIds.has(row.articleId)) row.corpusRole = "validation";
        else if (row.corpusRole === "validation") delete row.corpusRole;
      }
      validationArticleIds = partition.validationArticleIds;
      // Validation rows are reserved, not consumed. Removing them from the fresh
      // set also prevents a later promotion from consuming the holdout.
      freshArticleIds = freshArticleIds.filter((id) => !validationIds.has(id));
      if (!freshArticleIds.length && !corpusOnly) throw noEligibleMaterial();
    }

    snapshot = await buildSnapshot({
      registry,
      rowsRaw: rows,
      freshArticleIds,
      dir: options.paths?.snapshots,
      evalGuard: makeEvalGuard(evalSet),
      replayArticleIds,
      validationArticleIds,
      partition,
      corpusMode: config.trainCorpusMode,
      corpusStats,
      corpusPolicy,
    });

    // The evaluation leak guard can still empty a non-empty collection (every
    // row colliding with the frozen eval set): same condition, same code.
    if (!snapshot.rows.length) throw noEligibleMaterial();

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
    // material instead of crashing with a Python traceback. The same response
    // carries the authoritative training-token/block counts that size the epoch
    // budget and enforce the minimum-data gate.
    let corpusPreflight = null;
    let trainingBudget = null;
    let minimumData = null;
    if (pythonMode && typeof t.preflight === "function") {
      const info = await t.preflight({
        datasetFile: snapshot.manifest.file,
        parentVersion: pythonBaseline?.version ?? null,
        valBlocks: config.trainValBlocks,
      });
      if (info && info.ok === false) {
        const err = new Error(
          info.error ?? "insufficient corpus: the snapshot cannot form one training block",
        );
        err.code = info.code ?? "INSUFFICIENT_CORPUS";
        err.blockCount = info.blockCount ?? 0;
        throw err;
      }
      corpusPreflight = info ?? null;
      minimumData = checkMinimumTrainingData({
        trainTokensSeen: info?.trainTokensSeen,
        minUniqueTokens: config.trainMinUniqueTokens,
      });
      if (!minimumData.ok) {
        const err = new Error(minimumData.reason);
        err.code = "INSUFFICIENT_TRAINING_DATA";
        err.tokens = minimumData.tokens;
        err.minUniqueTokens = minimumData.floor;
        throw err;
      }
      const trainBlockCount = Number(info?.trainBlockCount);
      if (Number.isInteger(trainBlockCount) && trainBlockCount > 0) {
        trainingBudget = computeTrainingBudget({
          trainBlockCount,
          targetEpochs: config.trainTargetEpochs,
          maxSteps: config.trainMaxSteps,
          microBatch: config.trainMicroBatch,
          gradAccum: config.trainGradAccum,
          minSteps: config.trainMinSteps,
          seqLen: config.trainSeqLen,
        });
        if (!trainingBudget.meetsMinimum) {
          const err = new Error(trainingBudget.minimumReason);
          err.code = "INSUFFICIENT_TRAINING_STEPS";
          err.trainingBudget = trainingBudget;
          err.corpusStats = corpusStats;
          throw err;
        }
      }
    }
    // The replay share is SIZED by token estimate in Node but only MEASURED by
    // the tokenizer here. Record the measured share on the run (never silently
    // claim the target was hit) and warn when it overshoots the configured cap,
    // so a corpus where fresh material is dwarfed by the replay pool is visible.
    if (pythonMode && corpusPreflight && Number.isFinite(corpusPreflight.trainTokensSeen) && corpusPreflight.trainTokensSeen > 0) {
      const measuredReplayShare = (Number(corpusPreflight.replayTokensSeen) || 0) / corpusPreflight.trainTokensSeen;
      const cap = (Number(config.trainReplayPercent) || 0) / 100;
      if (Number.isFinite(measuredReplayShare) && cap > 0 && measuredReplayShare > cap + 0.02) {
        logger?.warn?.(
          `[lifecycle] replay token share ${(measuredReplayShare * 100).toFixed(1)}% exceeds configured TRAIN_REPLAY_PERCENT=${config.trainReplayPercent}% (measured, not enforced)`,
        );
      }
    }
    // The fixed cadence was sized for 60-step runs. Tighten it to the ACTUAL
    // budget so a short run still records enough finite validation observations
    // to classify a trend (the configured value remains a cap; 0 stays disabled).
    const effectiveEvalEvery = computeEvaluationCadence({
      steps: trainingBudget?.steps ?? config.trainSteps,
      configuredEvalEvery: config.trainEvalEvery,
    });
    if (trainingBudget) trainingBudget.effectiveEvalEvery = effectiveEvalEvery;
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
      // Advisory only (e.g. an undersized frozen evaluation set). Recorded on
      // the run so the shortfall stays explainable after the fact; it never
      // gates the run or the promotion decision.
      evaluationSetSize: evalSet.size,
      evaluationWarnings: evalSet.warnings ?? [],
      trainingBudget,
      corpusMode: config.trainCorpusMode,
      corpusPolicy,
      corpusStats,
      candidateIdentity: options.candidateIdentity ?? null,
      validationPolicy,
      partition: partition
        ? {
            policyVersion: partition.policyVersion,
            clusterPolicyVersion: partition.clusterPolicyVersion,
            splitSeed: partition.splitSeed,
            splitHash: partition.splitHash,
            exposure: partition.exposure,
            stats: partition.stats,
          }
        : null,
      corpusPreflight: corpusPreflight
        ? {
            trainBlockCount: corpusPreflight.trainBlockCount ?? null,
            blockCount: corpusPreflight.blockCount ?? null,
            trainTokensSeen: corpusPreflight.trainTokensSeen ?? null,
            tokensSeen: corpusPreflight.tokensSeen ?? null,
            validationBlockCount: corpusPreflight.validationBlockCount ?? null,
            validationTokensSeen: corpusPreflight.validationTokensSeen ?? null,
            freshTokensSeen: corpusPreflight.freshTokensSeen ?? null,
            replayTokensSeen: corpusPreflight.replayTokensSeen ?? null,
            freshDocumentCount: corpusPreflight.freshDocumentCount ?? null,
            replayDocumentCount: corpusPreflight.replayDocumentCount ?? null,
            validationShortfall: corpusPreflight.validationShortfall ?? null,
            corpusSplitMode: corpusPreflight.corpusSplitMode ?? null,
          }
        : null,
      minimumTrainingData: minimumData,
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
      candidateIdentity: options.candidateIdentity ?? null,
      validationPolicy,
      partition: partition
        ? {
            policyVersion: partition.policyVersion,
            clusterPolicyVersion: partition.clusterPolicyVersion,
            splitSeed: partition.splitSeed,
            splitHash: partition.splitHash,
            exposure: partition.exposure,
            stats: partition.stats,
          }
        : null,
      snapshotArticleIds: snapshot.rows.map((r) => r.articleId),
      evaluationSetHash: computeFileHash(evalSet.file),
      // Written as soon as the candidate version exists; the durable link that
      // lets a restarted process re-drive a promotion whose in-process
      // `trainingResult` is gone. Without it, recovery could not name the version.
      resultVersion: null,
      resultParentVersion: pythonBaseline?.version ?? null,
      resultModelId: null,
      baselineLoss: null,
      candidateLoss: null,
      decision: null,
      published: false,
      consumed: false,
      activated: false,
      error: null,
    };
    await persistManifest(manifestPath, manifest);
    manifest = await updateManifest(manifestPath, manifest, { status: "running" });

    // ---- BASELINE evaluation (before training) ----
    // The parent (active) version is immutable, so its loss on the frozen eval set
    // is immutable for a given eval configuration. Cache it so a run only ever
    // evaluates the CANDIDATE; a miss (or a changed config / re-frozen set) just
    // re-evaluates. The key includes the eval-set content hash + hyperparameters.
    const baselineKey = pythonMode
      ? baselineCacheKey({
          version: pythonBaseline.version,
          evalSetHash: computeFileHash(evalSet.file),
          seqLen: config.promoteEvalSeqLen,
          microBatch: config.promoteEvalMicroBatch,
          device: config.studentDevice,
          perDocument: config.promotePerDocument,
          codeFingerprint: options.candidateIdentity?.trainer?.fingerprint ?? null,
        })
      : null;
    if (pythonMode && baselineKey) {
      const cached = loadEvalCache(registry.dir)[baselineKey];
      if (cached?.ok && cacheEntrySatisfiesEvidence(cached, { perDocument: config.promotePerDocument })) {
        baselineResult = cached;
      } else if (cached?.ok) {
        logger?.warn?.(
          `[lifecycle] ignoring stale baseline cache entry for ${pythonBaseline.version}: per-document evidence ${config.promotePerDocument ? "missing" : "not required"}`,
        );
      }
    }
    if (!baselineResult) {
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
      if (
        pythonMode &&
        baselineKey &&
        baselineResult?.ok &&
        cacheEntrySatisfiesEvidence(baselineResult, { perDocument: config.promotePerDocument })
      ) {
        const cache = loadEvalCache(registry.dir);
        cache[baselineKey] = baselineResult;
        saveEvalCache(registry.dir, cache);
      }
    }
    if (pythonMode) {
      await recordPythonEvaluation(registry, {
        runId,
        kind: "baseline",
        version: pythonBaseline.version,
        modelId: baselineModel.modelId,
        result: baselineResult,
        evalSet,
        identity: options.candidateIdentity ?? null,
      });
    }

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
        // Data-derived budget when the preflight could size the corpus; the
        // adapter falls back to its fixed legacy default when it could not.
        steps: trainingBudget?.steps ?? null,
        minSteps: trainingBudget?.minSteps ?? 0,
        documentBoundary: config.trainDocumentBoundary,
        valBlocks: config.trainValBlocks,
        evalEvery: effectiveEvalEvery,
        targetEpochs: config.trainTargetEpochs,
        maxSteps: config.trainMaxSteps,
        trainBlockCount: trainingBudget?.trainBlockCount ?? null,
        seed: config.trainSeed,
        validationPolicy,
      },
    });

    if (pythonMode && trainingBudget && trainingBudget.minSteps > 0) {
      const actualSteps = Number(trainingResult.stepsCompleted ?? 0);
      if (actualSteps < trainingBudget.minSteps) {
        if (stagingSupported && trainingResult.staged === true) {
          await discardRejected(t, trainingResult.version, runId, options, logger);
        }
        const err = new Error(
          `training completed ${actualSteps} step(s), below the required minimum of ${trainingBudget.minSteps}; candidate discarded`,
        );
        err.code = "INSUFFICIENT_TRAINING_STEPS";
        err.actualSteps = actualSteps;
        err.requiredSteps = trainingBudget.minSteps;
        throw err;
      }
    }

    // Persist the candidate version the MOMENT it exists. Everything after this
    // (evaluation, decision, publish, activate, consumption) is recoverable from
    // the manifest alone on a restart, because the crash-recovery path can now
    // name the version without the in-process `trainingResult`.
    if (pythonMode) {
      manifest = await updateManifest(manifestPath, manifest, {
        status: "trained",
        resultVersion: trainingResult.version ?? null,
        resultParentVersion: trainingResult.parentVersion ?? pythonBaseline?.version ?? null,
      });
    }

    // ---- candidate model registered ----
    const candidate = await registry.registerModel({
      kind: trainer?.kind ?? config.trainerKind,
      baseModel: config.ollamaModel,
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
    if (pythonMode) manifest = await updateManifest(manifestPath, manifest, { resultModelId: candidate.modelId });

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

    if (pythonMode) {
      await recordPythonEvaluation(registry, {
        runId,
        kind: "candidate",
        version: trainingResult.version,
        modelId: candidate.modelId,
        result: candidateResult,
        evalSet,
        identity: options.candidateIdentity ?? null,
        baselineResult,
        decision,
        trainingResult,
      });
    }

    // Commit-on-promotion: with a staging-capable trainer the candidate is an
    // unpublished `vNNN.tmp` right now. It is promoted into an immutable `vNNN`
    // ONLY on a real promotion, and discarded (provenance retained) otherwise, so
    // a rejected candidate never enters the published lineage nor becomes active.
    const stagedCandidate = stagingSupported && trainingResult.staged === true;
    const published = stagedCandidate || trainingResult.published !== false;

    if (pythonMode) {
      // Record the evaluation-set hash for provenance and the promotion gate.
      manifest = await updateManifest(manifestPath, manifest, {
        evaluationSetHash: computeFileHash(evalSet.file),
        baselineLoss: baselineResult.loss,
        candidateLoss: candidateResult.loss,
        decision: decision.decision,
      });
    }

    // Consumption rule (Refinement #1, §8 of the diagnostic report):
    //   - not_evaluated (training/eval failed): do not consume; retry safely.
    //   - rejected: do NOT consume; defer the batch for bounded retry.
    //   - inconclusive: do NOT consume; no defensible basis to activate, so the
    //     batch follows the same deferral path as a rejection.
    //   - promoted: publish, activate, complete the manifest, then consume.
    //
    // The ordering publication -> active pointer -> manifest -> consumption is
    // load-bearing: every earlier step is durable and idempotent, and the
    // exactly-once consumption commit runs last, so a crash between any two steps
    // is recoverable by retrying the next one without double-consuming.
    if (decision.decision === "not_evaluated") {
      if (stagedCandidate) await discardRejected(t, trainingResult.version, runId, options, logger);
      manifest = await updateManifest(manifestPath, manifest, {
        consumed: false,
        published: false,
        status: "failed",
        error: decision.reason ?? "not_evaluated",
      });
    } else if (decision.decision === "rejected" || decision.decision === "inconclusive") {
      // Neither a rejection nor an inconclusive outcome may consume articles.
      // They are deferred with a retry count so they remain eligible for future
      // selection alongside new material. The active model must never be altered.
      if (stagedCandidate) await discardRejected(t, trainingResult.version, runId, options, logger);
      manifest = await updateManifest(manifestPath, manifest, {
        consumed: false,
        published: false,
        activated: false,
        status: decision.decision,
        // Durable deferral provenance — survives process crash/restart because
        // it is written to the manifest, the persistent recovery anchor.
        deferralReason: decision.reason ?? `${decision.decision} by promotion gate`,
        deferralRunId: runId,
        deferralRetries: 1,
      });
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
      // Repetition regression check, recorded (never gated): after the pointer
      // moves, measure the newly active model's generation quality so a
      // degenerate-output drift ("The 6 is a 6") is visible in the ledger. Only
      // the real (staging-capable) trainer drives this; fake trainers in tests
      // inject a measurement seam instead of spawning Python.
      if (stagingSupported) {
        try {
          generationQuality = await measureGenerationQuality({
            version: trainingResult.version,
            store: config.pythonStore ?? undefined,
            bin: config.pythonBin ?? undefined,
            device: config.studentDevice,
          });
        } catch (err) {
          logger?.warn?.(`[lifecycle] generation-quality check for ${trainingResult.version} failed: ${err.message}`);
        }
      }
      manifest = await updateManifest(manifestPath, manifest, {
        consumed: false,
        published,
        activated: true,
        status: "promoted",
      });
      consumption = await commitConsumption(
        snapshot.manifest.freshArticleIds ?? snapshot.manifest.articleIds ?? snapshot.rows.map((r) => r.articleId),
        runId
      );
      manifest = await updateManifest(manifestPath, manifest, { consumed: true, activated: true });
    }

    // -------------------------------------------------------------------
    // Deferral / retry / retire bookkeeping (Refinement #6).
    //
    // This runs for EVERY decision branch, which is why it lives here and not
    // inside one of them. It is durable: the article store appends an event per
    // transition, so the retry counters and retirements replay identically
    // after a restart. A `not_evaluated` run changes nothing — training or
    // evaluation never produced a verdict about the material.
    // -------------------------------------------------------------------
    // Bookkeeping targets only the newly-collected (previously unconsumed)
    // articles. When a snapshot backfills already-consumed material (see
    // `snapshotIncludeConsumed`), those retained rows are trained on but must
    // NOT be re-deferred or re-consumed: they are owned by the active version.
    const bookkeepingIds =
      snapshot.manifest.freshArticleIds ?? snapshot.manifest.articleIds ?? snapshot.rows.map((r) => r.articleId);
    if ((decision.decision === "rejected" || decision.decision === "inconclusive") && typeof store.deferArticles === "function") {
      // Defer the batch with a cooldown so it is not immediately retried with
      // the same companion material. The candidate WEIGHTS were rejected; the
      // SOURCE KNOWLEDGE is not retired — once its fresh retries are exhausted it
      // moves to the replay pool, still learnable under an improved strategy.
      await store.deferArticles(bookkeepingIds, {
        runId,
        reason: decision.reason ?? `${decision.decision} by promotion gate`,
        maxRetries: config.jobs.training.maxRejectedRetries,
        cooldownBaseMs: config.trainDeferralCooldownBaseMs,
        cooldownMaxMs: config.trainDeferralCooldownMaxMs,
      });
    } else if (decision.decision === "promoted" && typeof store.clearDeferral === "function") {
      // Articles consumed by the promoted model are owned by the active
      // version and must not be reconsidered under a different run.
      await store.clearDeferral(
        bookkeepingIds.filter((id) => store.getArticle?.(id)?.consumedAt),
        { runId },
      );
    }

    // Record the run's ACTUAL learning contribution, durably. This is the source
    // of truth for "appeared in a batch" vs "contributed to the active model":
    // fresh rows are the run's real input; replay rows are historical material
    // the run sampled; and the decision records whether either reached a
    // published model. Best-effort — a ledger write must never fail a valid run.
    if (typeof store.recordTrainingContribution === "function") {
      try {
        await store.recordTrainingContribution({
          runId,
          decision: decision.decision,
          version: pythonMode ? trainingResult.version ?? null : null,
          parentVersion: pythonMode ? trainingResult.parentVersion ?? null : null,
          freshArticleIds: snapshot.manifest.freshArticleIds ?? [],
          replayArticleIds: snapshot.manifest.replayArticleIds ?? [],
          trainTokensSeen: trainingResult.trainTokensSeen ?? null,
          replayTokensSeen: trainingResult.replayTokensSeen ?? null,
          validationTokensSeen: trainingResult.validationTokensSeen ?? null,
        });
      } catch (err) {
        logger?.warn?.(`[lifecycle] contribution record for ${runId} failed: ${err.message}`);
      }
    }

    // ---- persist the decision on the model, then close the run ----
    await registry.modelEvent(candidate.modelId, {
      status: decision.decision === "promoted" ? "promoted" : decision.decision === "inconclusive" ? "inconclusive" : "rejected",
      evaluationScore: pythonMode ? candidateResult.loss : candidateResult.score100,
      evalRunId: pythonMode ? null : candidateResult.evalRunId,
      note: pythonMode
        ? `loss ${fmt(baselineResult.loss)} -> ${fmt(candidateResult.loss)} (improvement ${fmt(decision.improvement)}); ${decision.reason}`
        : `delta ${decision.delta.toFixed(4)} (${decision.base.toFixed(4)} -> ${decision.candidate.toFixed(4)})`,
    });

    await registry.completeRun(runId, {
      // Persist the gate's actual terminal decision. Inconclusive is a real
      // terminal outcome, not a rejection: it means there was no defensible
      // evidence either way, and the batch must not be consumed.
      status: terminalRunStatus(decision.decision),
      promotionStatus: decision.decision,
      note:
        decision.reason ??
        (decision.decision === "promoted"
          ? "promotion gate passed"
          : decision.decision === "inconclusive"
            ? "promotion gate inconclusive"
            : "promotion gate rejected candidate"),
      resultModelId: candidate.modelId,
      examplesProcessed: trainingResult.recordsProcessed ?? snapshot.manifest.recordCount,
      examplesSkipped: Math.max(0, rows.length - snapshot.manifest.recordCount),
      baselineEvaluation: pythonMode
        ? {
            loss: baselineResult.loss,
            datasetHash: baselineResult.datasetHash,
            version: pythonBaseline.version,
            lossStdErr: estimatedLossStdErr(baselineResult.evaluationSet?.tokensSeen),
          }
        : { evalRunId: baselineResult.evalRunId, score: baselineResult.score, score100: baselineResult.score100 },
      trainedEvaluation: pythonMode
        ? {
            loss: candidateResult.loss,
            datasetHash: candidateResult.datasetHash,
            version: trainingResult.version,
            lossStdErr: estimatedLossStdErr(candidateResult.evaluationSet?.tokensSeen),
          }
        : { evalRunId: candidateResult.evalRunId, score: candidateResult.score, score100: candidateResult.score100 },
      evaluationDelta: pythonMode ? decision.improvement : decision.delta,
      // A conservative 95% band for the loss DIFFERENCE (independent estimates):
      // ~1.96 * sqrt(SE_base^2 + SE_cand^2). Reported only; the gate ignores it.
      promotionNoiseBand: pythonMode
        ? (() => {
            const sb = estimatedLossStdErr(baselineResult.evaluationSet?.tokensSeen);
            const sc = estimatedLossStdErr(candidateResult.evaluationSet?.tokensSeen);
            return sb != null && sc != null ? 1.96 * Math.sqrt(sb * sb + sc * sc) : null;
          })()
        : null,
      evaluationWarnings: evalSet.warnings ?? [],
      trainingBudget: trainingBudget
        ? {
            ...trainingBudget,
            completedSteps: trainingResult.stepsCompleted ?? null,
            actualEffectiveEpochs:
              trainingResult.stepsCompleted != null && trainingBudget.trainBlockCount > 0
                ? (trainingResult.stepsCompleted * trainingBudget.effectiveBatchSize) /
                  trainingBudget.trainBlockCount
                : null,
            tokensPresented: trainingResult.tokensSeen ?? null,
            uniqueTokens: trainingResult.trainTokensSeen ?? null,
            optimizerState: "fresh",
          }
        : null,
      corpusPolicy,
      corpusAccounting: pythonMode
        ? {
            freshDocumentCount: trainingResult.freshDocumentCount ?? corpusPreflight?.freshDocumentCount ?? null,
            replayDocumentCount: trainingResult.replayDocumentCount ?? corpusPreflight?.replayDocumentCount ?? null,
            trainTokensSeen: trainingResult.trainTokensSeen ?? corpusPreflight?.trainTokensSeen ?? null,
            replayTokensSeen: trainingResult.replayTokensSeen ?? corpusPreflight?.replayTokensSeen ?? null,
            validationTokensSeen: trainingResult.validationTokensSeen ?? corpusPreflight?.validationTokensSeen ?? null,
            trainBlockCount: trainingResult.trainBlockCount ?? corpusPreflight?.trainBlockCount ?? null,
            validationBlockCount:
              trainingResult.validationBlockCount ?? corpusPreflight?.validationBlockCount ?? null,
            replayShare:
              trainingResult.replayTokensSeen != null && trainingResult.trainTokensSeen
                ? trainingResult.replayTokensSeen / trainingResult.trainTokensSeen
                : null,
            corpusSplitMode: trainingResult.corpusSplit?.mode ?? corpusPreflight?.corpusSplitMode ?? null,
            validationShortfall:
              trainingResult.corpusSplit?.shortfall ?? corpusPreflight?.validationShortfall ?? null,
            corpusMode: config.trainCorpusMode,
            corpusStats: corpusStats ?? null,
            documentBoundary: trainingResult.documentBoundary ?? config.trainDocumentBoundary,
            eosTokenId: trainingResult.eosTokenId ?? null,
            tokensPresented: trainingResult.tokensSeen ?? null,
            uniqueTokens: trainingResult.trainTokensSeen ?? null,
          }
        : null,
      // Which checkpoint the trainer published (best-checkpoint selection vs the
      // final step). Recorded so the promotion decision is attributable to a
      // specific training step, not just "the run".
      checkpointSelection: pythonMode
        ? {
            selectBest: trainingResult.selectBest ?? null,
            selectedStep: trainingResult.selectedStep ?? null,
            selectedValidationLoss: trainingResult.selectedValidationLoss ?? null,
            finalStep: trainingResult.stepsCompleted ?? null,
          }
        : null,
      // Repetitive-generation check on the promoted model (recorded, never gated).
      generationQuality: generationQuality
        ? {
            version: generationQuality.version,
            ok: generationQuality.ok === true,
            aggregate: generationQuality.aggregate ?? null,
            samples: generationQuality.samples ?? [],
            promptCount: generationQuality.promptCount ?? null,
            promptBankVersion: generationQuality.promptBankVersion ?? null,
            promptIds: generationQuality.promptIds ?? [],
            decoding: generationQuality.decoding ?? null,
            modelFingerprint: generationQuality.modelFingerprint ?? null,
            error: generationQuality.error ?? null,
          }
        : null,
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
          // `completePromotion` commits consumption but does not close the run;
          // record the terminal event here so the run is not left dangling.
          await registry.runEvent(runId, { status: "promoted", note: "promotion completed during crash recovery" });
        } else if (
          savedManifest &&
          (savedManifest.decision === "rejected" || savedManifest.decision === "inconclusive") &&
          savedManifest.consumed === false
        ) {
          // The candidate was rejected/inconclusive but the deferral bookkeeping
          // did not complete. The retry policy says the batch must NOT be
          // consumed: discard the staged candidate (idempotent) and defer the
          // batch (idempotent per run). The candidate is never published.
          if (producedStage(trainingResult, stagingSupported) && trainingResult?.version) {
            await discardRejected(t, trainingResult.version, runId, options, logger);
          }
          const ids = savedManifest.snapshotArticleIds ?? [];
          if (typeof store?.deferArticles === "function") {
            await store.deferArticles(ids, {
              runId,
              reason: savedManifest.deferralReason ?? `${savedManifest.decision} by promotion gate`,
              maxRetries: config.jobs.training.maxRejectedRetries,
              cooldownBaseMs: config.trainDeferralCooldownBaseMs,
              cooldownMaxMs: config.trainDeferralCooldownMaxMs,
            });
          }
          await updateManifest(manifestPath, savedManifest, { consumed: false, settled: true });
          await registry.runEvent(runId, {
            status: savedManifest.decision,
            note:
              savedManifest.decision === "inconclusive"
                ? "inconclusive batch deferred during crash recovery (not consumed)"
                : "rejection deferred during crash recovery (not consumed)",
          });
        } else if (
          savedManifest &&
          (savedManifest.decision === "promoted" || savedManifest.decision === "rejected") &&
          savedManifest.consumed === true
        ) {
          // The commit already completed; only a later bookkeeping step (model
          // event / run close) threw. Terminal state stands — do not fail it.
          await registry.runEvent(runId, {
            status: savedManifest.decision,
            note: "already consumed before the error; terminal state retained",
          });
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
        const after = await readManifest(manifestPath);
        // Never overwrite a terminal decision the recovery path just committed.
        if (!after || !(after.consumed === true && (after.decision === "promoted" || after.decision === "rejected"))) {
          await registry.runEvent(runId, { status: "failed", note: `training run failed: ${err.message}` });
        }
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
  const base = await registry.registerModel({ kind: "base", baseModel: config.ollamaModel });
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
    baseModel: config.ollamaModel,
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
  // Publish unless the manifest already records it as published. On a restart
  // there is no `trainerResult`, so the manifest's own `published` flag is the
  // signal that the `.tmp` candidate still needs committing. Publishing an
  // already-committed version is a no-op Python-side.
  if (savedManifest.published !== true || producedStage(trainerResult, true)) {
    if (typeof trainer?.publishCandidate === "function") {
      await trainer.publishCandidate(version, {
        store: config.pythonStore ?? undefined,
        bin: config.pythonBin ?? undefined,
      });
    }
  }
  await setActive(version, {
    store: config.pythonStore ?? undefined,
    bin: config.pythonBin ?? undefined,
    models: options.paths?.models ?? config.paths.models,
  });
  if (worker) await worker.reload();
  // Accumulate: each write must carry forward everything already recorded, or a
  // later write would drop an earlier field (the whole file is rewritten).
  let next = await updateManifest(manifestPath, savedManifest, {
    resultVersion: version,
    published: true,
    activated: true,
    status: "promoted",
    consumed: false,
  });
  const consumption = await commitConsumption(next.snapshotArticleIds ?? savedManifest.snapshotArticleIds ?? [], runId);
  next = await updateManifest(manifestPath, next, { consumed: true });
  return consumption;
}

/**
 * Commit a durable evaluation record for a Python-path baseline or candidate.
 *
 * The smoke tests and the promotion gate read these records; previously the
 * Python path produced NO evaluation records at all (`evaluations.ndjson` stayed
 * empty), so a promotion could not be reconstructed from the ledger. Best-effort:
 * a record-writing failure must never fail an otherwise valid run — the run's
 * own manifest and model event remain the authoritative evidence.
 */
/**
 * ESTIMATED standard error of the mean per-token loss: sigma / sqrt(tokens).
 *
 * The frozen eval set packs into whole `seqLen` blocks and only the token count
 * is recorded, so a true per-block standard error is not available here. This is
 * a deliberately conservative estimate that makes the noise floor visible in the
 * run record and the report; it NEVER changes the promotion decision.
 */
export function estimatedLossStdErr(tokensSeen, sigma = config.evalLossTokenStd) {
  const n = Number(tokensSeen);
  const s = Number(sigma);
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(s) || s <= 0) return null;
  return s / Math.sqrt(n);
}

async function recordPythonEvaluation(registry, {
  runId,
  kind,
  version,
  modelId = null,
  result,
  evalSet,
  identity = null,
  baselineResult = null,
  decision = null,
  trainingResult = null,
}) {
  if (!registry || typeof registry.recordEvaluation !== "function") return null;
  const evaluationSet = result?.evaluationSet ?? null;
  try {
    const evalRunId = `${runId}:${kind}`;
    const manifestHash = evalSet?.manifest
      ? createHash("sha256").update(JSON.stringify(evalSet.manifest)).digest("hex")
      : null;
    const items = (evalSet?.items ?? []).map((item) => ({
      articleId: item.articleId ?? null,
      promptId: item.promptId ?? null,
      contentHash: item.contentHash ?? null,
    }));
    const comparisonInputs = baselineResult && result
      ? {
          parent: {
            version: baselineResult.version ?? null,
            datasetHash: baselineResult.datasetHash ?? null,
            perDocument: baselineResult.perDocument ?? [],
            groups: baselineResult.groups ?? [],
          },
          candidate: {
            version: version ?? null,
            datasetHash: result.datasetHash ?? null,
            perDocument: result.perDocument ?? [],
            groups: result.groups ?? [],
          },
        }
      : null;
    const evidence = {
      schema: "sma/eval-evidence@1",
      evalRunId,
      kind,
      createdAt: new Date().toISOString(),
      evaluationSet: {
        datasetId: evalSet?.datasetId ?? null,
        datasetVersion: evalSet?.datasetVersion ?? null,
        file: evalSet?.file ?? null,
        fileHash: evalSet?.file ? computeFileHash(evalSet.file) : null,
        manifestHash,
        items,
      },
      metric: evaluationSet
        ? {
            name: "causal-cross-entropy",
            strategy: evaluationSet.strategy ?? null,
            sequenceLength: evaluationSet.sequenceLength ?? config.promoteEvalSeqLen,
            microBatch: config.promoteEvalMicroBatch,
            computeDtype: "float32",
          }
        : null,
      metricSignature: result?.metricSignature ?? null,
      model: {
        version: version ?? null,
        modelId,
        fingerprint: identity?.candidateKey ?? null,
        parentWeightFingerprint: identity?.parent?.weightFingerprint ?? null,
      },
      candidateIdentity: identity,
      trainingSeed: identity?.training?.seed ?? trainingResult?.trainingSeed ?? null,
      codeFingerprint: identity?.trainer?.fingerprint ?? trainingResult?.trainerCodeFingerprint?.digest ?? null,
      evaluationLoss: Number.isFinite(result?.loss) ? result.loss : null,
      perDocument: result?.perDocument ?? [],
      groups: result?.groups ?? [],
      comparisonInputs,
      paired: decision?.paired ?? null,
      bootstrap: decision?.paired
        ? {
            method: decision.paired.method ?? null,
            methodVersion: decision.paired.methodVersion ?? null,
            bootstrapSeed: decision.paired.bootstrapSeed ?? null,
            ciLevel: decision.paired.level ?? config.promoteCiLevel,
            samples: decision.paired.samples ?? config.promoteBootstrapSamples,
            minGroups: config.promoteMinGroups,
          }
        : null,
    };
    return await registry.recordEvaluation({
      evalRunId,
      runId,
      kind,
      version: version ?? null,
      modelId,
      at: new Date().toISOString(),
      loss: Number.isFinite(result?.loss) ? result.loss : null,
      ok: result?.ok === true,
      error: result?.ok === true ? null : (result?.error ?? null),
      datasetHash: result?.datasetHash ?? evaluationSet?.datasetHash ?? null,
      metricSignature: result?.metricSignature ?? null,
      metric: evidence.metric,
      tokenizerHash: evaluationSet?.tokenizerHash ?? null,
      documentCount: evaluationSet?.documentCount ?? null,
      blockCount: evaluationSet?.blockCount ?? null,
      tokensSeen: evaluationSet?.tokensSeen ?? null,
      lossStdErr: estimatedLossStdErr(evaluationSet?.tokensSeen),
      evaluationSetId: evalSet?.datasetId ?? null,
      evaluationSetVersion: evalSet?.datasetVersion ?? null,
      evaluationSetHash: evalSet?.file ? computeFileHash(evalSet.file) : null,
      candidateIdentity: identity,
      trainingSeed: evidence.trainingSeed,
      codeFingerprint: evidence.codeFingerprint,
      paired: decision?.paired ?? null,
      evidence,
    });
  } catch (err) {
    // records are provenance, not the gate
    return { error: err.message };
  }
}

/**
 * Complete any promotion/rejection that a crashed process left uncommitted.
 *
 * `executeFullRun`'s own catch re-drives the current run in-process, but a hard
 * process death leaves nobody to finish it: the version may already be published
 * and active while its consumption was never committed and its manifest never
 * closed. This scans the snapshot directory for run manifests stuck at
 * `decision` set / `consumed:false` and re-drives the idempotent tail
 * (publish → activate → consume). Every step is a no-op when already done, so it
 * is safe to run on every start.
 */
export async function recoverPendingPromotions({ registry, store, trainer = null, options = {}, logger = console, setActive = setActiveVersion, worker = null } = {}) {
  if (!registry) return [];
  const dir = options.paths?.snapshots ?? config.paths.snapshots;
  let files = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith("-manifest.json"));
  } catch {
    return [];
  }
  const commitConsumption =
    options.markConsumed ?? ((ids, runId) => store.markConsumed(ids, { runId }));
  const recovered = [];
  for (const file of files) {
    const manifestPath = path.join(dir, file);
    const m = await readManifest(manifestPath);
    if (!m || m.consumed === true || m.settled === true) continue;
    if (m.decision !== "promoted" && m.decision !== "rejected" && m.decision !== "inconclusive") continue;
    try {
      if (m.decision === "promoted") {
        await completePromotion({
          runId: m.runId,
          savedManifest: m,
          manifestPath,
          trainer,
          trainerResult: null,
          options,
          commitConsumption,
          setActive,
          worker,
        });
        // `completePromotion` fails closed (status:failed, no consumption) when it
        // cannot name the candidate version. Do NOT report such a run as
        // recovered/consumed — read the manifest back and require the commit.
        const after = await readManifest(manifestPath);
        if (!after || after.consumed !== true) {
          logger?.error && logger.error(`[lifecycle] recovery of ${m.runId} did not commit consumption; left for inspection`);
          continue;
        }
      } else {
        // Rejected / inconclusive: the retry policy says the batch must NOT be
        // consumed. Defer it (idempotent per run) so it stays eligible for a
        // bounded retry alongside new material, then settle the manifest so it
        // is not re-scanned forever. `deferArticles` moves exhausted batches to
        // the replay pool rather than retiring them.
        const ids = m.snapshotArticleIds ?? [];
        if (typeof store?.deferArticles === "function") {
          await store.deferArticles(ids, {
            runId: m.runId,
            reason: m.deferralReason ?? `${m.decision} by promotion gate`,
            maxRetries: config.jobs.training.maxRejectedRetries,
            cooldownBaseMs: config.trainDeferralCooldownBaseMs,
            cooldownMaxMs: config.trainDeferralCooldownMaxMs,
          });
        }
        await updateManifest(manifestPath, m, { settled: true, consumed: false, activated: false });
        try {
          await registry.runEvent(m.runId, {
            status: m.decision,
            note:
              m.decision === "inconclusive"
                ? "inconclusive batch deferred on recovery (retry policy; not consumed)"
                : "rejected batch deferred on recovery (retry policy; not consumed)",
          });
        } catch { /* run may already be terminal */ }
        recovered.push({ runId: m.runId, decision: m.decision, deferred: true });
        continue;
      }
      try {
        await registry.runEvent(m.runId, {
          status: m.decision,
          note: "pending promotion recovered during run-lock acquisition",
        });
      } catch { /* run may already be terminal */ }
      recovered.push({ runId: m.runId, decision: m.decision });
    } catch (err) {
      logger?.error && logger.error(`[lifecycle] recovery of ${m.runId} failed: ${err.message}`);
    }
  }
  return recovered;
}

function terminalRunStatus(decision) {
  if (decision === "promoted") return "promoted";
  if (decision === "inconclusive") return "inconclusive";
  return "rejected";
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