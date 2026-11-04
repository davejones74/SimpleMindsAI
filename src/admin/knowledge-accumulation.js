import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { readPythonStore } from "./python-store.js";
import { validationAvailability } from "../training/validation-status.js";

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
  const validation = await validationAvailability(store, registry, config);
  const jobs = typeof supervisor?.listJobs === "function" ? supervisor.listJobs() : [];
  const trainingJob = jobs.filter((job) => job.kind === "training").sort((a, b) => String(a.jobId).localeCompare(String(b.jobId), undefined, { numeric: true })).at(-1) ?? null;
  const learningJob = jobs.filter((job) => job.kind === "learning").sort((a, b) => String(a.jobId).localeCompare(String(b.jobId), undefined, { numeric: true })).at(-1) ?? null;
  const activeVersionMeta = versions.get(py.activeVersion) ?? null;
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
  };
}
