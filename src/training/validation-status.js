import { existsSync } from "node:fs";
import path from "node:path";
import { config as defaultConfig } from "../config.js";
import { collectRowsFromArticles } from "../dataset/snapshot.js";
import { loadEvaluationSet, makeEvalGuard } from "../dataset/evaluation-set.js";
import { buildPartition } from "../dataset/partition.js";
import { historicallyExposedArticleIds } from "./exposure.js";
import { loadActiveValidationBank } from "../dataset/validation-bank.js";

export async function validationAvailability(store, registry, cfg = defaultConfig) {
  if (cfg.validationBank?.enabled) {
    let bank = null;
    try { bank = loadActiveValidationBank({ dir: cfg.paths.validationBanks }); } catch (err) {
      return {
        schema: "sma/validation-availability@1",
        at: new Date().toISOString(),
        available: false,
        waiting: true,
        error: { name: err.name, code: err.code ?? null, message: err.message },
        source: "validation-bank",
        targetTokens: Math.max(0, cfg.trainValBlocks * cfg.trainSeqLen),
        validationArticleCount: 0,
        validationClusterCount: 0,
        validationArticleIds: [],
      };
    }
    if (bank) {
      return {
        schema: "sma/validation-availability@1",
        at: new Date().toISOString(),
        available: bank.manifest.selectedBlocks >= cfg.trainValBlocks,
        waiting: bank.manifest.selectedBlocks < cfg.trainValBlocks,
        error: null,
        source: "validation-bank",
        bankVersion: bank.manifest.bankVersion,
        bankManifestHash: bank.manifest.manifestHash,
        bankContentHash: bank.manifest.contentHash,
        targetTokens: Math.max(0, cfg.trainValBlocks * cfg.trainSeqLen),
        targetBlocks: cfg.trainValBlocks,
        actualTokens: bank.manifest.tokens,
        actualBlocks: bank.manifest.selectedBlocks,
        validationArticleCount: bank.manifest.articleIds.length,
        validationClusterCount: bank.manifest.clusterIds.length,
        validationArticleIds: bank.manifest.articleIds,
        sourceIds: bank.manifest.sourceIds,
        splitHash: bank.manifest.manifestHash,
      };
    }
    return {
      schema: "sma/validation-availability@1",
      at: new Date().toISOString(),
      available: false,
      waiting: true,
      error: { name: "ValidationBankMissing", code: "INSUFFICIENT_VALIDATION_BANK", message: "validation bank is enabled but no active bank exists" },
      source: "validation-bank",
      targetTokens: Math.max(0, cfg.trainValBlocks * cfg.trainSeqLen),
      validationArticleCount: 0,
      validationClusterCount: 0,
      validationArticleIds: [],
    };
  }
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
