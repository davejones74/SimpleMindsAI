import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { config as defaultConfig } from "../config.js";
import { collectRowsFromArticles, trimReplayToFreshTarget } from "../dataset/snapshot.js";
import { loadActiveValidationBank } from "../dataset/validation-bank.js";
import { applyDiversityCaps } from "../dataset/diversity.js";
import { measureDocuments } from "../training/tokenizer-measurement.js";
import { loadEvaluationSet, makeEvalGuard } from "../dataset/evaluation-set.js";
import { historicallyExposedArticleIds } from "../training/exposure.js";
import { replayShareWithinTolerance, selectReplayWithinBudget } from "../training/replay-budget.js";

const SCHEMA = "sma/knowledge-pipeline@1";
const SELECTION_VERSION = "training-selection-v2";
const QUEUE_STATUSES = ["INGESTED", "PENDING_REVIEW", "REVIEWED", "REJECTED", "RETIRED", "UNRESOLVED", "QUARANTINED"];

function tokenizerPathFor(storeRoot) {
  if (!storeRoot) return null;
  for (const pointer of ["active.json", "working.json"]) {
    try {
      const rec = JSON.parse(readFileSync(path.join(storeRoot, pointer), "utf8"));
      if (!rec?.version) continue;
      const candidate = path.join(storeRoot, rec.version, "tokenizer.json");
      if (existsSync(candidate)) return candidate;
    } catch { /* try next */ }
  }
  return null;
}

function safeReadRows(file) {
  if (!file || !existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip corrupt tail */ }
  }
  return out;
}

function lastRun(registry) {
  try {
    const runs = registry?.listRuns?.() ?? [];
    return runs.length ? runs[runs.length - 1] : null;
  } catch { return null; }
}

/**
 * Authoritative knowledge pipeline view.
 *
 * Fresh-trainable and ready-for-training are computed by the SAME selector
 * functions the lifecycle uses (collection, validation-bank exclusion, actual
 * tokenizer measurement and diversity caps), not by a second simplified count.
 */
export async function buildKnowledgePipeline({
  store,
  registry,
  frontier = null,
  supervisor = null,
  config = defaultConfig,
  pythonStorePath = null,
  tokenizerPath = null,
  measure = measureDocuments,
  snapshotsDir = null,
} = {}) {
  if (!store?.getStats) throw new Error("buildKnowledgePipeline requires the article store");
  const stats = store.getStats();
  const runs = registry?.listRuns?.() ?? [];
  let evalGuard = null;
  try {
    const evalDir = config.paths.evaluation;
    const sets = [];
    sets.push(await loadEvaluationSet({ datasetId: config.evalDatasetId, dir: evalDir, seed: null }));
    if (config.promoteBroadEvalSet) {
      sets.push(await loadEvaluationSet({ datasetId: config.broadEvalDatasetId, dir: evalDir, seed: null }));
    }
    evalGuard = makeEvalGuard(sets.filter((set) => set?.items?.length));
  } catch { evalGuard = null; }
  const latestRun = runs.length ? runs[runs.length - 1] : null;
  const learning = supervisor?.activeJobOfKind?.("learning") ?? null;
  const training = supervisor?.activeJobOfKind?.("training") ?? null;
  const review = supervisor?.activeJobOfKind?.("review") ?? null;
  const now = Date.now();

  // Lifecycle prefers unexposed rows when prospective validation is required;
  // the readiness selector MUST use the same preference or it selects a
  // different 512-row window from the same store.
  const priorExposed = config.trainValidationPolicy === "document-source-disjoint"
    ? historicallyExposedArticleIds(registry, store)
    : null;
  const collected = collectRowsFromArticles(store, {
    limit: config.snapshotLimit,
    replayPercent: config.trainReplayPercent,
    validationBlocks: 0,
    corpusMode: config.trainCorpusMode,
    deferValidationPartition: true,
    historicalArticleIds: priorExposed,
    evalGuard,
  });

  let rows = collected.rows;
  let freshIds = [...collected.freshArticleIds];
  let replayIds = [...collected.replayArticleIds];
  let bankRemovedArticles = 0;
  let bank = null;
  if (config.validationBank?.enabled) {
    try { bank = loadActiveValidationBank({ dir: config.paths.validationBanks }); } catch { bank = null; }
    if (bank) {
      const reservedIds = new Set(bank.manifest.articleIds ?? []);
      const reservedSources = new Set(bank.manifest.sourceIds ?? []);
      const removed = new Set();
      rows = rows.filter((row) => {
        const drop = reservedIds.has(row.articleId) || (row.sourceId && reservedSources.has(row.sourceId));
        if (drop) removed.add(row.articleId);
        return !drop;
      });
      freshIds = freshIds.filter((id) => !removed.has(id));
      replayIds = replayIds.filter((id) => !removed.has(id));
      bankRemovedArticles = removed.size;
    }
  }

  // Match lifecycle order: the estimate-based replay trim happens BEFORE the
  // tokenizer-measured source/publisher cap pass. Applying caps first can make a
  // publisher look less concentrated and report a batch the trainer cannot use.
  if (replayIds.length > 0 && config.trainReplayPercent > 0) {
    const trimmed = trimReplayToFreshTarget(rows, {
      replayPercent: config.trainReplayPercent,
      validationArticleIds: bank?.manifest?.articleIds ?? null,
    });
    rows = trimmed.rows;
    replayIds = trimmed.replayRows.map((row) => row.articleId);
    freshIds = freshIds.filter((id) => rows.some((row) => row.articleId === id));
  }
  const trainingRows = rows.filter((row) => row.corpusRole !== "validation");
  const tokenizerPathResolved = tokenizerPath ?? tokenizerPathFor(pythonStorePath ?? config.pythonStore);
  let measured = { authoritative: false, reason: "tokenizer unavailable", documents: [] };
  if (tokenizerPathResolved && trainingRows.length) {
    try {
      const out = await measure(trainingRows.map((row) => ({ itemId: row.articleId, text: row.text })), {
        tokenizerPath: tokenizerPathResolved,
        seqLen: config.trainSeqLen,
      });
      measured = { authoritative: true, reason: null, documents: out.documents ?? [], totalTokens: out.totalTokens ?? 0 };
    } catch (err) {
      measured = { authoritative: false, reason: err.message, documents: [] };
    }
  }
  const tokenById = new Map((measured.documents ?? []).map((row) => [row.itemId, Number(row.tokens) || 0]));
  let measuredRows = trainingRows.map((row) => ({
    ...row,
    measuredTokens: measured.authoritative ? (tokenById.get(row.articleId) ?? 0) : undefined,
  }));
  // Match the lifecycle tokenizer-authoritative replay budget before applying
  // source/publisher caps.
  let replayBudget = null;
  if (measured.authoritative && replayIds.length && config.trainReplayPercent > 0) {
    const freshRowsForBudget = measuredRows.filter((row) => row.corpusRole !== "replay");
    const replayRowsForBudget = measuredRows.filter((row) => row.corpusRole === "replay");
    const freshTokensForBudget = freshRowsForBudget.reduce((n, row) => n + (row.measuredTokens ?? 0), 0);
    const replayTokensForBudget = replayRowsForBudget.reduce((n, row) => n + (row.measuredTokens ?? 0), 0);
    const check = replayShareWithinTolerance({
      freshTokens: freshTokensForBudget,
      replayTokens: replayTokensForBudget,
      replayPercent: config.trainReplayPercent,
      tolerancePoints: config.trainReplayTolerancePoints,
    });
    replayBudget = { share: check.share, withinTolerance: check.withinTolerance, removedRows: 0 };
    if (!check.withinTolerance) {
      const selected = selectReplayWithinBudget({
        replayRows: replayRowsForBudget,
        tokenById,
        freshTokens: freshTokensForBudget,
        replayPercent: config.trainReplayPercent,
      });
      const keptReplayIds = new Set(selected.keptRows.map((row) => row.articleId));
      measuredRows = measuredRows.filter((row) => row.corpusRole !== "replay" || keptReplayIds.has(row.articleId));
      replayIds = [...keptReplayIds];
      replayBudget.removedRows = selected.removedRows;
      replayBudget.afterShare = selected.replayShare;
    }
  }
  const capped = applyDiversityCaps(measuredRows, {
    maxSourceTokenShare: config.trainMaxSourceTokenShare,
    maxPublisherTokenShare: config.trainMaxPublisherTokenShare,
    maxUnitsPerSource: config.curatorMaxUnitsPerSource,
  });
  const keptIds = new Set(capped.kept.map((row) => row.articleId));
  const freshRows = capped.kept.filter((row) => row.corpusRole !== "replay");
  const replayRows = capped.kept.filter((row) => row.corpusRole === "replay");
  const freshPublisherIds = [...new Set(freshRows.map((row) => row.publisherId).filter(Boolean))].sort();
  const freshSubjectIds = [...new Set(freshRows.map((row) => row.domain).filter(Boolean))].sort();
  const tokenFor = (row) => measured.authoritative ? Number(row.measuredTokens ?? 0) : Math.ceil(String(row.text ?? "").length / 4);
  let freshTokens = freshRows.reduce((n, row) => n + tokenFor(row), 0);
  let replayTokens = replayRows.reduce((n, row) => n + tokenFor(row), 0);
  let freshArticleIds = freshRows.map((row) => row.articleId);
  let replayArticleIds = replayRows.map((row) => row.articleId);
  const selectorFreshArticleIds = [...freshArticleIds];
  const selectorFreshTokens = freshTokens;
  const selectorReplayArticleIds = [...replayArticleIds];
  const selectorReplayTokens = replayTokens;
  const snapshotSelection = await latestSnapshotSelection({
    dir: snapshotsDir ?? config.paths.snapshots,
    tokenizerPath: tokenizerPathResolved,
    measure,
    seqLen: config.trainSeqLen,
  });
  // A snapshot is the last *training batch*, not the next batch. Once the run
  // that consumed it has completed, its fresh IDs are historical; comparing them
  // with the next selector result would be meaningless and would make readiness
  // look permanently "ready" for an already-consumed batch.
  const snapshotIsHistorical = Boolean(snapshotSelection) && snapshotSelection.freshArticleIds.every((id) => {
    const article = typeof store.getArticle === "function" ? store.getArticle(id) : null;
    return Boolean(article?.consumedAt);
  });
  const useSnapshot = Boolean(snapshotSelection) && !snapshotIsHistorical;
  if (useSnapshot) {
    freshArticleIds = snapshotSelection.freshArticleIds;
    freshTokens = snapshotSelection.freshTokens;
    replayArticleIds = snapshotSelection.replayArticleIds;
    replayTokens = snapshotSelection.replayTokens;
  }
  const requiredFreshTokens = Number(config.trainMinFreshTokens) || 0;
  const validationBlocks = bank?.manifest?.selectedBlocks ?? null;
  const requiredValidationBlocks = Number(config.trainValBlocks) || 0;
  const validationReady = !config.validationBank?.enabled || (validationBlocks !== null && validationBlocks >= requiredValidationBlocks);
  const ready = freshTokens >= requiredFreshTokens && validationReady;
  const trainingFreshTokens = training?.status === "waiting" && Number.isFinite(Number(training.meta?.tokens))
    ? Number(training.meta.tokens)
    : null;
  const trainingPreflightMissing = trainingFreshTokens == null ? null : Math.max(0, requiredFreshTokens - trainingFreshTokens);
  const missingFreshTokens = Math.max(0, requiredFreshTokens - freshTokens);
  const limitingCondition = !validationReady
    ? "validation-bank"
    : missingFreshTokens > 0
      ? "fresh-tokens"
      : "ready";

  const byStatus = stats.byStatus ?? {};
  const awaitingReview = (byStatus.INGESTED ?? 0) + (byStatus.PENDING_REVIEW ?? 0) + (byStatus.UNRESOLVED ?? 0);
  const reviewedCompleted = (byStatus.REVIEWED ?? 0) + (byStatus.REJECTED ?? 0) + (byStatus.RETIRED ?? 0) + (byStatus.QUARANTINED ?? 0);
  const queues = {
    collected: stats.totalArticles ?? 0,
    awaitingReview,
    reviewed: reviewedCompleted,
    freshTrainable: freshArticleIds.length,
    replayEligible: stats.replayEligible ?? 0,
    deferred: stats.deferredFresh ?? 0,
    quarantined: byStatus.QUARANTINED ?? 0,
    rejected: byStatus.REJECTED ?? 0,
    retired: byStatus.RETIRED ?? 0,
    consumed: stats.uniqueConsumed ?? 0,
  };

  const exclusions = {
    contentQuality: collected.stats?.contentQualityExcludedReasons ?? {},
    contentQualityTotal: collected.stats?.contentQualityExcluded ?? 0,
    samples: collected.stats?.contentQualityExcludedSamples ?? [],
    sourceCap: capped.removedByReason?.["source-cap"] ?? 0,
    publisherCap: capped.removedByReason?.["publisher-cap"] ?? 0,
    sourceUnitCap: capped.removedByReason?.["source-unit-cap"] ?? 0,
    sourceCapArticleIds: (capped.removed ?? []).filter((item) => item.reason === "source-cap").map((item) => item.articleId),
    publisherCapArticleIds: (capped.removed ?? []).filter((item) => item.reason === "publisher-cap").map((item) => item.articleId),
    sourceUnitCapArticleIds: (capped.removed ?? []).filter((item) => item.reason === "source-unit-cap").map((item) => item.articleId),
    validationBankArticles: bankRemovedArticles,
    collectedFreshBeforeCaps: collected.freshArticleIds.length,
    collectedReplayBeforeCaps: collected.replayArticleIds.length,
  };

  const learningProgress = learning?.progress ?? {};
  const discovery = learningProgress.discovery?.bootstrap ?? null;
  const funnel = {
    discovered: frontier?.summary?.().total ?? frontier?.summary?.()?.total ?? null,
    frontier: frontier ? {
      ...frontier.summary(),
      publisherClaims: typeof frontier.publisherClaimSummary === "function" ? frontier.publisherClaimSummary().slice(0, 25) : [],
    } : null,
    rawDocs: learningProgress.rawDocs ?? null,
    ingested: learningProgress.ingested ?? null,
    reviewed: learningProgress.reviewed ?? null,
    trainableReported: stats.trainable ?? null,
    proseAndContentEligible: collected.freshArticleIds.length,
    capEligible: freshArticleIds.length,
    freshTokens,
    conversion: {
      reviewedToProseEligible: stats.reviewed ? collected.freshArticleIds.length / stats.reviewed : null,
      proseToCapEligible: collected.freshArticleIds.length ? freshArticleIds.length / collected.freshArticleIds.length : null,
    },
    discovery,
    exclusions,
  };

  const latestRunAt = latestRun?.completedAt ?? latestRun?.startedAt ?? null;
  const lastTrainingAt = runs.filter((run) => run.status === "promoted" || run.status === "rejected" || run.status === "inconclusive").at(-1)?.completedAt ?? null;
  const noProgressStreak = learningProgress.noProgressStreak ?? learning?.meta?.noProgressStreak ?? 0;
  const stalls = [];
  if (learning) {
    stalls.push({
      stage: "discovery/acquisition",
      status: learning.status,
      phase: learning.phase,
      lastProgressAt: learning.updatedAt ?? null,
      noProgressStreak,
      limitingCondition: learning.phase === "waiting-for-new-material" || noProgressStreak > 0 ? "no-new-material" : null,
      nextAttemptAt: learning.meta?.nextAttemptAt ?? null,
    });
  }
  if (review) {
    stalls.push({ stage: "review", status: review.status, phase: review.phase, lastProgressAt: review.updatedAt ?? null, pending: stats.pendingReview ?? 0, nextAttemptAt: review.meta?.nextAttemptAt ?? null });
  }
  if (training) {
    stalls.push({ stage: "training", status: training.status, phase: training.phase, lastProgressAt: training.updatedAt ?? null, limitingCondition, missingFreshTokens });
  }
  if (!training) stalls.push({ stage: "training", status: "absent", limitingCondition: "no-training-job" });

  const integrityWarnings = [];
  const statusTotal = QUEUE_STATUSES.reduce((n, key) => n + (byStatus[key] ?? 0), 0);
  if (statusTotal !== (stats.totalArticles ?? 0)) {
    integrityWarnings.push(`status totals ${statusTotal} do not reconcile with collected ${stats.totalArticles ?? 0}`);
  }
  if (new Set(freshArticleIds).size !== freshArticleIds.length) integrityWarnings.push("duplicate article IDs in fresh-trainable selection");
  if (freshArticleIds.length > (stats.trainable ?? 0)) integrityWarnings.push("fresh-trainable selection exceeds store trainable count");
  if (!measured.authoritative) integrityWarnings.push(`fresh-token count is estimated: ${measured.reason}`);
  if (trainingFreshTokens != null && Math.abs(trainingFreshTokens - freshTokens) > 1) {
    integrityWarnings.push(`latest-snapshot fresh tokens (${freshTokens}) differ from the training preflight (${trainingFreshTokens})`);
  }
  const sameFreshIds = selectorFreshArticleIds.length === freshArticleIds.length
    && [...selectorFreshArticleIds].sort().join(",") === [...freshArticleIds].sort().join(",");
  if (useSnapshot && (selectorFreshTokens !== freshTokens || !sameFreshIds)) {
    integrityWarnings.push(`selector-derived fresh tokens (${selectorFreshTokens}) differ from the pending training snapshot (${freshTokens})`);
  }

  return {
    schema: SCHEMA,
    at: new Date(now).toISOString(),
    lineage: {
      active: readPointer(pythonStorePath ?? config.pythonStore, "active.json"),
      working: readPointer(pythonStorePath ?? config.pythonStore, "working.json"),
      lastGood: readPointer(pythonStorePath ?? config.pythonStore, "working-last-good.json"),
      latestRun: latestRun ? { runId: latestRun.runId, status: latestRun.status, completedAt: latestRun.completedAt, startedAt: latestRun.startedAt } : null,
      lastTrainingAt,
    },
    queues,
    readiness: {
      ready,
      limitingCondition,
      freshArticles: freshArticleIds.length,
      freshTokens,
      freshPublishers: freshPublisherIds.length,
      freshPublisherIds,
      freshSubjects: freshSubjectIds.length,
      freshSubjectIds,
      selectorFreshArticles: selectorFreshArticleIds.length,
      selectorFreshTokens,
      selectorFreshArticleIds,
      selectionVersion: SELECTION_VERSION,
      selectionSource: useSnapshot ? "pending-snapshot" : "selector",
      selectionAt: useSnapshot ? snapshotSelection.at : null,
      lastSnapshot: snapshotSelection ? {
        at: snapshotSelection.at,
        freshArticles: snapshotSelection.freshArticleIds.length,
        freshTokens: snapshotSelection.freshTokens,
        historical: snapshotIsHistorical,
      } : null,
      requiredFreshTokens,
      missingFreshTokens,
      trainingPreflightTokens: trainingFreshTokens,
      trainingPreflightMissingTokens: trainingPreflightMissing,
      replayArticles: replayArticleIds.length,
      replayTokens,
      selectorReplayArticles: selectorReplayArticleIds.length,
      selectorReplayTokens,
      combinedTokens: freshTokens + replayTokens,
      measuredWithTokenizer: measured.authoritative,
      measurementReason: measured.reason,
      replayBudget,
      validationBank: {
        enabled: Boolean(config.validationBank?.enabled),
        bankVersion: bank?.manifest?.bankVersion ?? null,
        blocks: validationBlocks,
        requiredBlocks: requiredValidationBlocks,
        ready: validationReady,
      },
      freshArticleIds,
      replayArticleIds,
    },
    exclusions,
    funnel,
    stalls,
    integrity: { ok: integrityWarnings.length === 0, warnings: integrityWarnings },
    jobs: {
      learning: learning ? { jobId: learning.jobId, status: learning.status, phase: learning.phase, note: learning.note, progress: learning.progress, meta: learning.meta } : null,
      review: review ? { jobId: review.jobId, status: review.status, phase: review.phase, note: review.note, progress: review.progress, meta: review.meta } : null,
      training: training ? { jobId: training.jobId, status: training.status, phase: training.phase, note: training.note, progress: training.progress, meta: training.meta } : null,
    },
  };
}

async function latestSnapshotSelection({ dir = defaultConfig.paths.snapshots, tokenizerPath = null, measure = measureDocuments, seqLen = defaultConfig.trainSeqLen } = {}) {
  try {
    const files = readdirSync(dir)
      .filter((name) => /^dataset-.*\.jsonl$/.test(name))
      .map((name) => ({ name, at: statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    if (!files.length) return null;
    const file = path.join(dir, files[0].name);
    const rows = safeReadRows(file);
    const freshRows = rows.filter((row) => row.corpusRole !== "replay" && row.corpusRole !== "validation");
    const replayRows = rows.filter((row) => row.corpusRole === "replay");
    if (!freshRows.length) return null;
    let tokenById = new Map();
    let measured = false;
    if (tokenizerPath) {
      const out = await measure([...freshRows, ...replayRows].map((row) => ({ itemId: row.articleId, text: row.text })), { tokenizerPath, seqLen });
      tokenById = new Map((out.documents ?? []).map((row) => [row.itemId, Number(row.tokens) || 0]));
      measured = true;
    }
    const tokensFor = (row) => measured ? (tokenById.get(row.articleId) ?? 0) : Math.ceil(String(row.text ?? "").length / 4);
    return {
      at: new Date(files[0].at).toISOString(),
      file,
      freshArticleIds: freshRows.map((row) => row.articleId),
      replayArticleIds: replayRows.map((row) => row.articleId),
      freshTokens: freshRows.reduce((n, row) => n + tokensFor(row), 0),
      replayTokens: replayRows.reduce((n, row) => n + tokensFor(row), 0),
      measured,
    };
  } catch { return null; }
}

function readPointer(storeRoot, file) {
  if (!storeRoot) return null;
  try { return JSON.parse(readFileSync(path.join(storeRoot, file), "utf8")); } catch { return null; }
}

/** Exact immutable-ish run membership from the contribution ledger/snapshot. */
export function getRunMembership({ store, registry, runId, snapshotsDir = null } = {}) {
  if (!runId) throw new Error("getRunMembership requires runId");
  const contributions = (store?.listContributions?.() ?? []).filter((c) => c.runId === runId);
  const contribution = contributions.at(-1) ?? null;
  const run = (registry?.listRuns?.() ?? []).find((r) => r.runId === runId) ?? null;
  const file = run?.datasetFile ?? (snapshotsDir ? path.join(snapshotsDir, `${runId}.jsonl`) : null);
  const rows = safeReadRows(file).map((row) => ({
    articleId: row.articleId,
    contentHash: row.contentHash ?? null,
    role: row.corpusRole ?? "train",
    sourceUrl: row.sourceUrl ?? null,
    sourceId: row.sourceId ?? null,
    publisherId: row.publisherId ?? null,
    textLength: String(row.text ?? "").length,
  }));
  return {
    runId,
    run: run ? { status: run.status, baseModelVersion: run.baseModelVersion, datasetId: run.datasetId, datasetVersion: run.datasetVersion, datasetFile: run.datasetFile } : null,
    contribution,
    counts: {
      fresh: contribution?.freshArticleIds?.length ?? rows.filter((r) => r.role === "train").length,
      replay: contribution?.replayArticleIds?.length ?? rows.filter((r) => r.role === "replay").length,
      validation: rows.filter((r) => r.role === "validation").length,
    },
    rows,
    source: contribution ? "training-contribution" : rows.length ? "snapshot" : "unavailable",
  };
}

/** Article-centric training history, including rejected candidates. */
export function getArticleTrainingHistory({ store, articleId } = {}) {
  if (!articleId) throw new Error("getArticleTrainingHistory requires articleId");
  const rows = (store?.listContributions?.() ?? []).filter((c) =>
    (c.freshArticleIds ?? []).includes(articleId) || (c.replayArticleIds ?? []).includes(articleId),
  );
  return {
    articleId,
    appearances: rows.map((c) => ({
      runId: c.runId,
      decision: c.decision,
      version: c.version,
      parentVersion: c.parentVersion,
      role: (c.freshArticleIds ?? []).includes(articleId) ? "fresh" : "replay",
      at: c.at,
    })),
  };
}
