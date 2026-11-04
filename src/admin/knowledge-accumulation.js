import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { readPythonStore } from "./python-store.js";
import { validationAvailability } from "../training/validation-status.js";
import { measureValidationAvailability } from "../training/tokenizer-measurement.js";
import { buildLearningEffectiveness } from "../training/learning-effectiveness.js";

function lastEvent(run) {
  return Array.isArray(run?.events) && run.events.length ? run.events.at(-1) : null;
}

function pointerSummary(pointer) {
  if (!pointer) return null;
  return {
    version: pointer.version ?? null,
    artifactName: pointer.artifactName ?? null,
    weightFingerprint: pointer.weightFingerprint ?? null,
    parentVersion: pointer.parentVersion ?? null,
    updatedAt: pointer.updatedAt ?? null,
    activatedAt: pointer.activatedAt ?? null,
    drift: Number.isFinite(pointer.drift) ? pointer.drift : null,
    evalLoss: Number.isFinite(pointer.evalLoss) ? pointer.evalLoss : null,
    runId: pointer.runId ?? null,
    guardDecision: pointer.guardDecision ?? null,
    guardReason: pointer.guardReason ?? null,
    regression: Number.isFinite(pointer.regression) ? pointer.regression : null,
  };
}

function contributionSummary(contribution, versions) {
  if (!contribution) return null;
  const version = contribution.workingVersion ?? contribution.version ?? null;
  const meta = version ? versions.get(version) : null;
  return {
    runId: contribution.runId ?? null,
    status: contribution.decision ?? null,
    stableDecision: contribution.decision ?? contribution.stableDecision ?? null,
    workingDecision: contribution.workingDecision ?? null,
    workingAdvanced: contribution.workingDecision === "accepted",
    version: contribution.version ?? null,
    workingVersion: version,
    parentVersion: contribution.parentVersion ?? null,
    at: contribution.at ?? null,
    freshDocuments: contribution.freshArticleIds?.length ?? null,
    replayDocuments: contribution.replayArticleIds?.length ?? null,
    trainTokens: Number.isFinite(contribution.trainTokensSeen) ? contribution.trainTokensSeen : null,
    replayTokens: Number.isFinite(contribution.replayTokensSeen) ? contribution.replayTokensSeen : null,
    validationTokens: Number.isFinite(contribution.validationTokensSeen) ? contribution.validationTokensSeen : null,
    optimizerMode: meta?.trainState?.optimizerMode ?? null,
    carryOptimizerFrom: meta?.trainState?.carryOptimizerFrom ?? null,
    workingGuard: contribution.workingGuard ?? null,
    checkpointRole: contribution.checkpointRole ?? null,
  };
}

function corpusSummary(contribution, run, config) {
  if (!contribution && !run) return null;
  const trainingTokens = Number.isFinite(contribution?.trainTokensSeen) ? contribution.trainTokensSeen : null;
  const replayTokens = Number.isFinite(contribution?.replayTokensSeen) ? contribution.replayTokensSeen : null;
  const freshTokens = Number.isFinite(trainingTokens) && Number.isFinite(replayTokens) ? trainingTokens - replayTokens : null;
  const validationTokens = Number.isFinite(contribution?.validationTokensSeen) ? contribution.validationTokensSeen : null;
  return {
    runId: contribution?.runId ?? run?.runId ?? null,
    datasetId: run?.datasetId ?? null,
    configuredReplayPercent: Number.isFinite(config?.trainReplayPercent) ? config.trainReplayPercent : null,
    fresh: { documents: contribution?.freshArticleIds?.length ?? run?.corpusPreflight?.freshDocumentCount ?? null, tokens: freshTokens },
    replay: { documents: contribution?.replayArticleIds?.length ?? run?.corpusPreflight?.replayDocumentCount ?? null, tokens: replayTokens },
    validation: { documents: run?.partition?.stats?.validationDocuments ?? null, tokens: validationTokens },
    training: {
      documents: run?.corpusPreflight?.trainBlockCount ?? null,
      tokens: trainingTokens,
      presentedTokens: run?.corpusPreflight?.tokensSeen ?? null,
      uniqueTokens: run?.corpusPreflight?.uniqueTokens ?? null,
    },
    replayShare: Number.isFinite(replayTokens) && Number.isFinite(trainingTokens) && trainingTokens > 0
      ? replayTokens / trainingTokens
      : null,
    prePartitionEstimate: Number.isFinite(run?.corpusStats?.estimatedReplayShare) ? run.corpusStats.estimatedReplayShare : null,
    source: "training-contribution (durable) plus trainer preflight when available",
  };
}

function optimizerSummary(py, workingVersion) {
  const meta = (py.versions ?? []).find((version) => version.version === workingVersion) ?? null;
  const stateFile = workingVersion ? path.join(py.root, "_runs", `${workingVersion}.train-state.pt`) : null;
  let stateBytes = null;
  let stateModifiedAt = null;
  if (stateFile && existsSync(stateFile)) {
    try {
      const stat = statSync(stateFile);
      stateBytes = stat.size;
      stateModifiedAt = new Date(stat.mtimeMs).toISOString();
    } catch {
      stateBytes = null;
      stateModifiedAt = null;
    }
  }
  return {
    version: workingVersion,
    parentVersion: meta?.trainState?.parentVersion ?? null,
    mode: meta?.trainState?.optimizerMode ?? null,
    carryOptimizerFrom: meta?.trainState?.carryOptimizerFrom ?? null,
    stepsCompleted: meta?.trainState?.stepsCompleted ?? null,
    tokensSeen: meta?.trainState?.tokensSeen ?? null,
    stateFile,
    stateBytes,
    stateModifiedAt,
    statePresent: Boolean(stateBytes),
    wallSeconds: meta?.trainState?.wallSeconds ?? null,
    source: "train-state.json plus _runs/<working>.train-state.pt",
  };
}

function jobSummary(job) {
  if (!job) return null;
  return {
    jobId: job.jobId,
    kind: job.kind,
    mode: job.mode,
    status: job.status,
    phase: job.phase ?? null,
    note: job.note ?? null,
    meta: job.meta ?? null,
    progress: job.progress ?? null,
    updatedAt: job.updatedAt ?? null,
  };
}

function groupChanges(registry, runId) {
  if (!runId || typeof registry?.listEvaluations !== "function") return null;
  const records = registry.listEvaluations().filter((record) => record.runId === runId);
  const candidate = records.find((record) => record.kind === "candidate");
  const parent = records.find((record) => record.kind === "working-parent") ?? records.find((record) => record.kind === "baseline");
  if (!candidate?.evidenceFile || !parent?.evidenceFile) return null;
  try {
    const candidateEvidence = JSON.parse(readFileSync(path.join(registry.dir, candidate.evidenceFile), "utf8"));
    const parentEvidence = JSON.parse(readFileSync(path.join(registry.dir, parent.evidenceFile), "utf8"));
    const parentByGroup = new Map((parentEvidence.groups ?? []).map((group) => [group.group, group]));
    const groups = (candidateEvidence.groups ?? [])
      .map((group) => {
        const before = parentByGroup.get(group.group);
        if (!before) return null;
        return {
          group: group.group,
          tokens: group.tokens ?? before.tokens ?? null,
          parentLoss: before.loss ?? null,
          candidateLoss: group.loss ?? null,
          improvement: Number.isFinite(before.loss) && Number.isFinite(group.loss) ? before.loss - group.loss : null,
        };
      })
      .filter(Boolean);
    const ordered = groups.filter((group) => Number.isFinite(group.improvement)).sort((a, b) => a.improvement - b.improvement);
    return {
      runId,
      groupsCompared: groups.length,
      worst: ordered.slice(0, 8),
      best: ordered.slice(-8).reverse(),
      evidenceFile: candidate.evidenceFile,
      parentEvidenceFile: parent.evidenceFile,
    };
  } catch {
    return null;
  }
}

function latestRunSummary(run, contribution, optimizer) {
  if (!run && !contribution) return null;
  const last = lastEvent(run);
  return {
    runId: contribution?.runId ?? run?.runId ?? null,
    status: contribution?.decision ?? run?.promotionStatus ?? run?.status ?? last?.status ?? null,
    startedAt: run?.startedAt ?? null,
    completedAt: run?.completedAt ?? contribution?.at ?? null,
    parentSelection: run?.parentSelection ?? null,
    stableBaselineVersion: run?.stableBaselineVersion ?? contribution?.stableBaselineVersion ?? null,
    workingParentVersion: contribution?.parentVersion ?? run?.workingParentVersion ?? run?.baseModelVersion ?? null,
    workingVersion: contribution?.workingVersion ?? run?.workingVersion ?? null,
    promotionStatus: contribution?.decision ?? run?.promotionStatus ?? null,
    workingDecision: contribution?.workingDecision ?? run?.workingDecision ?? null,
    workingAdvanced: contribution?.workingDecision === "accepted" || run?.workingAdvanced === true,
    evaluationDelta: Number.isFinite(run?.evaluationDelta) ? run.evaluationDelta : null,
    promotionNoiseBand: Number.isFinite(run?.promotionNoiseBand) ? run.promotionNoiseBand : null,
    baselineLoss: Number.isFinite(run?.baselineEvaluation?.loss) ? run.baselineEvaluation.loss : null,
    candidateLoss: Number.isFinite(run?.trainedEvaluation?.loss) ? run.trainedEvaluation.loss : null,
    note: last?.note ?? contribution?.workingGuard?.reason ?? null,
    optimizerMode: contribution?.optimizerMode ?? optimizer?.mode ?? run?.trainingBudget?.optimizerState ?? null,
    events: Array.isArray(run?.events) ? run.events.slice(-8) : [],
  };
}

export async function buildKnowledgeAccumulation({ store, registry, pythonStorePath = null, supervisor = null, config }) {
  const py = readPythonStore(pythonStorePath);
  const versions = new Map((py.versions ?? []).map((version) => [version.version, version]));
  const runs = registry.listRuns();
  const contributions = typeof store.listContributions === "function" ? store.listContributions() : (store.contributions ?? []);
  const evaluations = typeof registry.listEvaluations === "function" ? registry.listEvaluations() : [];
  const modelEvents = typeof registry.listModelEvents === "function" ? registry.listModelEvents() : [];
  const stats = typeof store.getStats === "function" ? store.getStats() : {};
  const activeVersionMeta = versions.get(py.activeVersion) ?? null;
  const stableEvaluation = evaluations
    .filter((record) => record.kind === "baseline" && record.ok && record.version === py.activeVersion && Number.isFinite(Number(record.loss)))
    .sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")))
    .at(-1) ?? null;
  const learningEffectiveness = buildLearningEffectiveness({
    contributions,
    evaluations,
    modelEvents,
    stableBaselineVersion: py.activeVersion,
    stableLoss: stableEvaluation ? Number(stableEvaluation.loss) : activeVersionMeta?.trainState?.finalValidationLoss ?? null,
    pointers: { active: py.active, working: py.working, workingLastGood: py.workingLastGood },
  });
  const history = contributions.map((contribution) => contributionSummary(contribution, versions)).filter(Boolean);
  const workingHistory = history.filter((row) => row.workingDecision).slice(-20);
  const stableHistory = history.filter((row) => row.stableDecision).slice(-20);
  const promotions = stableHistory.filter((row) => row.stableDecision === "promoted");
  const latestContribution = contributions.at(-1) ?? null;
  const latestRun = latestContribution
    ? runs.find((run) => run.runId === latestContribution.runId) ?? null
    : runs.at(-1) ?? null;
  const optimizer = optimizerSummary(py, py.workingVersion);
  const latest = latestRunSummary(latestRun, latestContribution, optimizer);
  const validation = config?.knowledgeTokenizerMeasurement && pythonStorePath
    ? await measureValidationAvailability(store, registry, {
        config,
        tokenizerPath: path.join(pythonStorePath, py.workingVersion ?? py.activeVersion ?? "", "tokenizer.json"),
      }).catch(() => validationAvailability(store, registry, config))
    : await validationAvailability(store, registry, config);
  const jobs = typeof supervisor?.listJobs === "function" ? supervisor.listJobs() : [];
  const trainingJob = jobs.filter((job) => job.kind === "training").sort((a, b) => String(a.jobId).localeCompare(String(b.jobId), undefined, { numeric: true })).at(-1) ?? null;
  const learningJob = jobs.filter((job) => job.kind === "learning").sort((a, b) => String(a.jobId).localeCompare(String(b.jobId), undefined, { numeric: true })).at(-1) ?? null;
  const workingVersionMeta = versions.get(py.workingVersion) ?? null;
  const workingAdvances = workingHistory.filter((row) => row.workingDecision === "accepted").length;
  const workingRejections = workingHistory.filter((row) => row.workingDecision === "rejected").length;
  return {
    schema: "sma/knowledge-accumulation-observability@1",
    at: new Date().toISOString(),
    pointers: {
      active: pointerSummary(py.active),
      working: pointerSummary(py.working),
      lastGood: pointerSummary(py.workingLastGood),
    },
    stable: {
      version: py.activeVersion,
      artifactName: activeVersionMeta?.artifactName ?? py.active?.artifactName ?? null,
      weightFingerprint: py.active?.weightFingerprint ?? null,
      activatedAt: py.active?.activatedAt ?? null,
      promotionHistory: promotions.slice(-20),
      promotionCount: promotions.length,
      latestDecision: latest,
    },
    working: {
      version: py.workingVersion,
      artifactName: workingVersionMeta?.artifactName ?? py.working?.artifactName ?? null,
      weightFingerprint: py.working?.weightFingerprint ?? null,
      parentVersion: py.working?.parentVersion ?? null,
      drift: py.working?.drift ?? null,
      evalLoss: py.working?.evalLoss ?? null,
      updatedAt: py.working?.updatedAt ?? null,
      runId: py.working?.runId ?? null,
      lastGoodVersion: py.workingLastGoodVersion,
      lastGoodRunId: py.workingLastGood?.runId ?? null,
      advancementCount: workingAdvances,
      rejectionCount: workingRejections,
      advancementHistory: workingHistory,
      lastGood: pointerSummary(py.workingLastGood),
    },
    optimizer,
    corpus: corpusSummary(latestContribution, latestRun, config),
    training: latest ? {
      runId: latest.runId,
      status: latest.status,
      steps: workingVersionMeta?.trainState?.stepsCompleted ?? latestRun?.trainingBudget?.completedSteps ?? latestRun?.trainingBudget?.steps ?? null,
      plannedSteps: latestRun?.trainingBudget?.steps ?? null,
      tokensPresented: latestRun?.corpusPreflight?.tokensSeen ?? latestContribution?.trainTokensSeen ?? null,
      uniqueTokens: latestRun?.corpusPreflight?.uniqueTokens ?? null,
      wallSeconds: workingVersionMeta?.trainState?.wallSeconds ?? null,
      tokensPerSecond: Number.isFinite(workingVersionMeta?.trainState?.wallSeconds) && Number.isFinite(latestRun?.corpusPreflight?.tokensSeen)
        ? latestRun.corpusPreflight.tokensSeen / workingVersionMeta.trainState.wallSeconds
        : null,
      optimizerMode: latest.optimizerMode,
      carryOptimizerFrom: latestContribution?.carryOptimizerFrom ?? optimizer.carryOptimizerFrom ?? null,
    } : null,
    groupEvaluation: latestContribution?.workingGuard ? {
      runId: latestContribution.runId,
      version: latestContribution.workingGuard.version ?? null,
      thresholds: latestContribution.workingGuard.thresholds ?? null,
      parentLoss: latestContribution.workingGuard.parentLoss ?? null,
      candidateLoss: latestContribution.workingGuard.candidateLoss ?? null,
      stableLoss: latestContribution.workingGuard.stableLoss ?? null,
      decision: latestContribution.workingGuard.decision ?? null,
      reason: latestContribution.workingGuard.reason ?? null,
      metrics: latestContribution.workingGuard.metrics ?? null,
      changes: groupChanges(registry, latestContribution.runId),
    } : null,
    drift: {
      current: Number.isFinite(py.working?.drift) ? py.working.drift : null,
      max: Number.isFinite(config?.workingGuard?.maxDriftNats) ? config.workingGuard.maxDriftNats : null,
      rollback: latestRun?.workingRollback ?? null,
      status: Number.isFinite(py.working?.drift) && Number.isFinite(config?.workingGuard?.maxDriftNats)
        ? (py.working.drift > config.workingGuard.maxDriftNats ? "over-budget" : "within-budget")
        : "unknown",
    },
    validation,
    lifecycle: {
      trainingJob: jobSummary(trainingJob),
      learningJob: jobSummary(learningJob),
      waitingReason: trainingJob?.meta?.waitingReason ?? null,
      waitingNote: trainingJob?.note ?? null,
      recentJobs: jobs.slice(-8).map(jobSummary),
    },
    stableDecision: latest ? {
      runId: latest.runId,
      decision: latest.promotionStatus,
      delta: latest.evaluationDelta,
      noiseBand: latest.promotionNoiseBand,
      explanation: latest.note,
      version: latest.workingVersion,
    } : null,
    counts: {
      runs: runs.length,
      contributions: contributions.length,
      workingAdvances,
      workingRejections,
      stablePromotions: promotions.length,
      stableRejections: stableHistory.filter((row) => row.stableDecision === "rejected").length,
      stableInconclusive: stableHistory.filter((row) => row.stableDecision === "inconclusive").length,
    },
    // Knowledge-to-trainability funnel, licence provenance and cumulative
    // learning effectiveness. These are derived read-only views; none of them
    // feeds the stable promotion gate.
    funnel: {
      totalArticles: stats.totalArticles ?? null,
      reviewed: stats.reviewed ?? null,
      rejected: stats.rejected ?? null,
      retired: stats.retired ?? null,
      trainable: stats.trainable ?? null,
      uniqueConsumed: stats.uniqueConsumed ?? null,
      replayEligible: stats.replayEligible ?? null,
      approvedRetired: stats.approvedRetired ?? null,
      consumedApprovedRetired: stats.consumedApprovedRetired ?? null,
      consumedApprovedRetiredReplayable: stats.consumedApprovedRetiredReplayable ?? null,
      consumedApprovedRetiredNotReplayable: stats.consumedApprovedRetiredNotReplayable ?? null,
      deferredFresh: stats.deferredFresh ?? null,
      recoverable: stats.recoverable ?? null,
    },
    licence: {
      byStatus: stats.byLicenceStatus ?? null,
      safe: stats.licenceSafe ?? null,
      uncertain: stats.licenceUncertain ?? null,
      restricted: stats.licenceRestricted ?? null,
      unknown: stats.licenceUnknown ?? null,
      unresolved: stats.licenceUnresolved ?? null,
    },
    learningEffectiveness: {
      schema: learningEffectiveness.schema,
      references: learningEffectiveness.references,
      activity: learningEffectiveness.activity,
      summary: learningEffectiveness.effect.summary,
      trajectory: learningEffectiveness.effect.trajectory.slice(-20),
      prospective: learningEffectiveness.effect.prospective,
      retention: learningEffectiveness.effect.retention,
      limitations: learningEffectiveness.limitations,
    },
  };
}
