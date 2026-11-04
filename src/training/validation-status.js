import { existsSync } from "node:fs";
import path from "node:path";
import { config as defaultConfig } from "../config.js";
import { collectRowsFromArticles } from "../dataset/snapshot.js";
import { loadEvaluationSet, makeEvalGuard } from "../dataset/evaluation-set.js";
import { buildPartition } from "../dataset/partition.js";
import { historicallyExposedArticleIds } from "./exposure.js";

export async function validationAvailability(store, registry, cfg = defaultConfig) {
  const exposed = historicallyExposedArticleIds(registry, store);
  const collected = collectRowsFromArticles(store, {
    limit: cfg.snapshotLimit,
    replayPercent: cfg.trainReplayPercent,
    validationBlocks: cfg.trainValBlocks,
    validationSeqLen: cfg.trainSeqLen,
    corpusMode: cfg.trainCorpusMode,
    deferValidationPartition: true,
    historicalArticleIds: exposed,
  });
  const freshIds = new Set(collected.freshArticleIds);
  const historicalIds = new Set(exposed);
  for (const row of collected.rows) if (!freshIds.has(row.articleId)) historicalIds.add(row.articleId);
  let partitionRows = collected.rows;
  const evalFile = path.join(cfg.paths.evaluation, `${cfg.evalDatasetId}.jsonl`);
  if (existsSync(evalFile)) {
    try {
      const evalSet = await loadEvaluationSet({ dir: cfg.paths.evaluation, datasetId: cfg.evalDatasetId });
      partitionRows = makeEvalGuard(evalSet).filter(collected.rows).kept;
    } catch {
      partitionRows = collected.rows;
    }
  }
  const targetTokens = Math.max(0, cfg.trainValBlocks * cfg.trainSeqLen);
  const base = {
    rows: partitionRows,
    splitSeed: cfg.trainValidationSeed,
    validationFraction: targetTokens > 0 ? 0 : cfg.trainValidationFraction,
    validationTargetTokens: targetTokens,
    minValidationTokens: cfg.trainMinValidationTokens,
    minValidationClusters: cfg.trainMinValidationClusters,
    historicalArticleIds: historicalIds,
    requireProspective: true,
  };
  let partition = null;
  let error = null;
  try {
    partition = buildPartition(base);
  } catch (err) {
    error = { name: err.name, code: err.code ?? null, message: err.message };
  }
  let inspection = null;
  if (!partition) {
    try {
      const inspected = buildPartition({
        ...base,
        requireProspective: false,
        validationTargetTokens: 1,
        minValidationClusters: 0,
      });
      const prospective = (inspected.clusters ?? []).filter((cluster) => cluster.prospective);
      inspection = {
        prospectiveClusters: prospective.length,
        prospectiveTokens: prospective.reduce((sum, cluster) => sum + cluster.tokens, 0),
        largestProspectiveClusterTokens: prospective.reduce((max, cluster) => Math.max(max, cluster.tokens), 0),
        clustersMeetingOneBlock: prospective.filter((cluster) => cluster.tokens >= cfg.trainSeqLen).length,
      };
    } catch {
      inspection = null;
    }
  }
  const exposure = partition?.exposure ?? null;
  return {
    schema: "sma/validation-availability@1",
    at: new Date().toISOString(),
    available: Boolean(partition),
    waiting: !partition,
    error,
    targetTokens,
    requiredClusters: Math.max(1, cfg.trainMinValidationClusters),
    requiredTokensForOneBlock: cfg.trainSeqLen,
    trainable: store.getStats().trainable,
    freshRows: collected.freshArticleIds.length,
    replayRows: collected.replayArticleIds.length,
    partitionRows: partitionRows.length,
    prospectiveClusters: exposure?.prospectiveClusters ?? inspection?.prospectiveClusters ?? null,
    prospectiveTokens: partition?.stats?.validationEstimatedTokens ?? inspection?.prospectiveTokens ?? null,
    largestProspectiveClusterTokens: inspection?.largestProspectiveClusterTokens ?? null,
    clustersMeetingOneBlock: inspection?.clustersMeetingOneBlock ?? null,
    validationArticleCount: partition?.validationArticleIds?.length ?? 0,
    validationClusterCount: partition?.validationClusterIds?.length ?? 0,
    validationArticleIds: partition?.validationArticleIds ?? [],
    exposure,
    splitHash: partition?.splitHash ?? null,
  };
}
