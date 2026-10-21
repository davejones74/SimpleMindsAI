import { collectRowsFromArticles, buildSnapshot } from "../dataset/snapshot.js";
import { loadEvaluationSet, makeEvalGuard } from "../dataset/evaluation-set.js";
import { isTrainable, normalizeImportance } from "../domain/article.js";
import { config } from "../config.js";

/**
 * GraphQL resolvers. Context: { store: ArticleStore, registry: RegistryStore }.
 *
 * Enum mapping is explicit: the domain keeps human-readable TitleCase importance
 * ("Normal") while GraphQL exposes SCREAMING enum names (NORMAL). Status and the
 * verdict/authority enums share their names with the domain values.
 */

const impToEnum = (v) => (v ? String(v).toUpperCase() : null); // "Normal" -> "NORMAL"
const impToDomain = (v) => {
  if (!v) return undefined;
  const name = String(v);
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase(); // "NORMAL" -> "Normal"
};
const verdictToEnum = (v) => (v ? String(v).toUpperCase() : null); // "approve" -> "APPROVE"
const verdictToDomain = (v) => (v ? String(v).toLowerCase() : undefined);
const authToEnum = (v) => (v ? String(v).toUpperCase() : null);
const authToDomain = (v) => (v ? String(v).toLowerCase() : undefined);

export const resolvers = {
  Article: {
    importance: (a) => impToEnum(a.importance),
    suggestedImportance: (a) => (a.suggestedImportance ? impToEnum(a.suggestedImportance) : null),
    decidedBy: (a) => (a.decidedBy ? authToEnum(a.decidedBy) : null),
    reviewCount: (a, _, { store }) => (typeof a.reviewCount === "number" ? a.reviewCount : store.reviewsFor(a.articleId).length),
    trainable: (a) => isTrainable(a),
    quarantined: (a) => a.status === "QUARANTINED",
    reviews: (a, _, { store }) => store.reviewsFor(a.articleId),
    events: (a, _, { store }) => store.events.filter((e) => e.articleId === a.articleId),
  },

  ArticleStats: {
    // `getStats().byStatus` is keyed by the domain's SCREAMING status names;
    // map them to the GraphQL camelCase fields so the counts (including the
    // retired and quarantined categories) are actually representable.
    byStatus: (s) => {
      const b = s.byStatus ?? {};
      return {
        ingested: b.INGESTED ?? 0,
        pendingReview: b.PENDING_REVIEW ?? 0,
        reviewed: b.REVIEWED ?? 0,
        rejected: b.REJECTED ?? 0,
        retired: b.RETIRED ?? 0,
        quarantined: b.QUARANTINED ?? 0,
      };
    },
  },

  ReviewVerdict: {
    verdict: (r) => verdictToEnum(r.verdict),
    authority: (r) => authToEnum(r.authority),
    suggestedImportance: (r) => (r.suggestedImportance ? impToEnum(r.suggestedImportance) : null),
  },

  Query: {
    stats: (_, __, { store }) => store.getStats(),
    articles: (_, { after, limit, status, importance, consumed, domain }, { store }) =>
      store.articlesPage({ after, limit: limit ?? 100, status, importance: impToDomain(importance), consumed, domain }),
    article: (_, { articleId }, { store }) => store.getArticle(articleId),
    trainableArticles: (_, { after, limit }, { store }) => store.trainablePage({ after, limit: limit ?? 100 }),
    reviewQueue: (_, { after, limit }, { store }) => store.reviewQueue({ after, limit: limit ?? 100 }),

    // ---- registry reads ----
    datasetSnapshots: (_, __, { registry }) => (registry?.listSnapshots() ?? []).map(toSnapshot),
    models: (_, __, { registry }) => (registry?.listModels() ?? []).map(toModel),
    model: (_, { modelId }, { registry }) => (registry?.getModel(modelId) ? toModel(registry.getModel(modelId)) : null),
    activeModel: (_, __, { registry }) => {
      const m = registry?.getActiveModel();
      return m ? toModel(m) : null;
    },
    trainingRuns: (_, __, { registry }) => (registry?.listRuns() ?? []).map(toRun),
    trainingRun: (_, { runId }, { registry }) => {
      const r = registry?.getRun(runId);
      return r ? toRun(r) : null;
    },
    evaluations: (_, __, { registry }) => registry?.listEvaluations() ?? [],
  },

  Mutation: {
    ingestArticle: async (_, { input }, { store }) => {
      const r = await store.ingestArticle({
        text: input.text,
        domain: input.domain,
        tags: input.tags,
        importance: input.importance ? impToDomain(input.importance) : undefined,
        source: input.source,
        rawText: input.rawText,
        sourceUrl: input.sourceUrl,
        htmlLang: input.htmlLang,
        uncertainty: input.uncertainty,
        missionRelevance: input.missionRelevance,
      });
      if (r?.skipped) return null;
      return r;
    },
    recordReview: (_, { input }, { store }) =>
      store.recordReview({
        articleId: input.articleId,
        verdict: verdictToDomain(input.verdict),
        score: input.score,
        rationale: input.rationale,
        authority: input.authority ? authToDomain(input.authority) : undefined,
        reviewerModel: input.reviewerModel,
        reviewerVersion: input.reviewerVersion,
        rubricVersion: input.rubricVersion,
        suggestedImportance: input.suggestedImportance ? impToDomain(input.suggestedImportance) : null,
        reviewCycleId: input.reviewCycleId,
      }),
    setArticleImportance: (_, { articleId, importance }, { store }) =>
      store.setImportance(articleId, impToDomain(importance)),
    setArticleStatus: (_, { articleId, status, reason }, { store }) =>
      store.setStatus(articleId, status, { reason }),
    requestArticleReview: (_, { articleId }, { store }) => store.requestReview(articleId),
    selectArticlesForReview: (_, { limit }, { store }) => store.selectForReview({ limit: limit ?? 500 }),

    markConsumed: (_, { input }, { store }) =>
      store.markConsumed(input.articleIds, { runId: input.runId, allowReuse: input.allowReuse ?? false }),
    purgeBuffer: (_, __, { store }) => store.purgeBuffer().then(() => true),

    // ---- registry writes ----
    createDatasetSnapshot: async (_, { input }, { store, registry }) => {
      const evalSet = await loadEvaluationSet({});
      const { rows, freshArticleIds, replayArticleIds, validationArticleIds } = collectRowsFromArticles(store, {
        replayPercent: config.trainReplayPercent,
        validationBlocks: config.trainValBlocks,
        validationSeqLen: config.trainSeqLen,
      });
      const { manifest } = await buildSnapshot({
        registry,
        rowsRaw: rows,
        freshArticleIds,
        replayArticleIds,
        validationArticleIds,
        source: input.source,
        evalGuard: makeEvalGuard(evalSet),
      });
      return toSnapshot(manifest);
    },
    registerModel: async (_, { input }, { registry }) => toModel(await registry.registerModel(input)),
    recordEvaluation: (_, { input }, { registry }) =>
      registry.recordEvaluation({
        evalRunId: input.evalRunId ?? registry.nextEvalId(),
        modelId: input.modelId,
        kind: input.kind,
        datasetId: input.datasetId,
        datasetVersion: input.datasetVersion,
        evaluatorVersion: input.evaluatorVersion,
        score: input.score,
        score100: +(Number(input.score) * 100).toFixed(2),
        createdAt: new Date().toISOString(),
      }),
    promoteModel: async (_, { modelId }, { registry }) => {
      await registry.modelEvent(modelId, { status: "promoted" });
      return toModel(registry.getModel(modelId));
    },
    rejectModel: async (_, { modelId }, { registry }) => {
      await registry.modelEvent(modelId, { status: "rejected" });
      return toModel(registry.getModel(modelId));
    },
    runEvent: async (_, { input }, { registry }) => {
      await registry.runEvent(input.runId, { status: input.status, note: input.note ?? null });
      return toRun(registry.getRun(input.runId));
    },
    recoverInterruptedRuns: async (_, __, { registry }) => registry.recoverStaleRuns(),
  },
};

function toSnapshot(s) {
  return {
    datasetId: s.datasetId,
    datasetVersion: s.datasetVersion,
    source: s.source ?? "store",
    recordCount: s.recordCount ?? 0,
    articleCount: s.articleCount ?? s.recordCount ?? 0,
    syntheticCount: s.syntheticCount ?? 0,
    syntheticShare: s.syntheticShare ?? 0,
    file: s.file,
    hash: s.hash,
    categories: s.categories ? Object.entries(s.categories).map(([domain, count]) => ({ domain, count })) : [],
    createdAt: s.createdAt,
  };
}

function toModel(m) {
  return {
    modelId: m.modelId,
    kind: m.kind,
    baseModel: m.baseModel,
    parentModelId: m.parentModelId,
    trainingRunId: m.trainingRunId,
    datasetId: m.datasetId,
    checkpointPath: m.checkpointPath,
    status: m.status,
    evaluationScore: m.evaluationScore,
    createdAt: m.createdAt,
  };
}

function toRun(r) {
  return {
    runId: r.runId,
    status: r.status,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    baseModel: r.baseModel,
    resultModelId: r.resultModelId,
    datasetId: r.datasetId,
    datasetVersion: r.datasetVersion,
    datasetFile: r.datasetFile,
    recordCount: r.recordCount,
    criticModel: r.criticModel,
    criticVersion: r.criticVersion,
    rubricVersion: r.rubricVersion,
    curriculumVersion: r.curriculumVersion,
    trainerVersion: r.trainerVersion,
    trainerKind: r.trainerKind,
    examplesProcessed: r.examplesProcessed,
    baselineScore: r.baselineEvaluation?.score,
    trainedScore: r.trainedEvaluation?.score,
    evaluationDelta: r.evaluationDelta,
    promotionStatus: r.promotionStatus,
    note: r.note,
    events: r.events ?? [],
  };
}
