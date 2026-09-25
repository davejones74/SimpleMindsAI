import { collectRowsFromBuffer, buildSnapshot } from "../dataset/snapshot.js";
import { loadEvaluationSet, makeEvalGuard } from "../dataset/evaluation-set.js";

/**
 * GraphQL resolvers. Context: { store: BufferStore, registry: RegistryStore }.
 *
 * Buffer mutations pass straight through (transient belt). Registry resolvers
 * are thin read/write wrappers over the append-only store — the *lifecycle*
 * module is the only thing allowed to run a TrainingRun end-to-end; these are
 * for inspection and explicit external promotion (never automatic).
 */
export const resolvers = {
  Query: {
    stats: (_, __, { store }) => store.getStats(),
    prompts: (_, { after = null, limit = 100, trained }, { store }) =>
      store.promptsPage({ after, limit, trained }),
    completions: (_, { promptId }, { store }) => store.completionsFor(promptId),
    trainingLogs: (_, __, { store }) => store.runs,
    consumeBatch: (_, { input }, { store }) => store.consumeBatch(input),

    // ---- Phase 2 registry reads ----
    datasetSnapshots: (_, __, { registry }) => (
      registry?.listSnapshots().map(toSnapshot) ?? []
    ),
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
    ingestPrompt: (_, { input }, { store }) => store.ingestPrompt(input),
    ingestCompletion: (_, { input }, { store }) => store.ingestCompletion(input),
    scoreCompletion: (_, { input }, { store }) => store.scoreCompletion(input),
    commitConsumption: (_, { input }, { store }) =>
      store.markTrained(input.ids, input.runId).then(() => true),
    recordTrainingRun: (_, { input }, { store }) => store.recordTrainingRun(input),
    purgeBuffer: (_, __, { store }) => store.purgeBuffer().then(() => true),

    // ---- Phase 2 registry writes ----
    createDatasetSnapshot: async (_, { input }, { store, registry }) => {
      const evalSet = await loadEvaluationSet({});
      const { rows } = collectRowsFromBuffer(store);
      const { manifest } = await buildSnapshot({
        registry,
        rowsRaw: rows,
        source: input.source,
        evalGuard: makeEvalGuard(evalSet),
      });
      return toSnapshot(manifest);
    },
    registerModel: async (_, { input }, { registry }) => {
      const rec = await registry.registerModel(input);
      return toModel(rec);
    },
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
    source: s.source ?? "buffer",
    recordCount: s.recordCount ?? 0,
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