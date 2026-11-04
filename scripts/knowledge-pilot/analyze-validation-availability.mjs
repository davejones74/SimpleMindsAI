#!/usr/bin/env node
import { ArticleStore } from "../../src/storage/article-store.js";
import { RegistryStore } from "../../src/storage/registry-store.js";
import { collectRowsFromArticles, trimReplayToFreshTarget } from "../../src/dataset/snapshot.js";
import { loadEvaluationSet, makeEvalGuard } from "../../src/dataset/evaluation-set.js";
import { buildPartition } from "../../src/dataset/partition.js";
import { config } from "../../src/config.js";
import { isTrainable } from "../../src/domain/article.js";

function exposedIds(registry, store) {
  const snapshots = registry.listSnapshots();
  const runs = registry.listRuns();
  const runDatasetIds = new Set(runs.filter((r) => r?.datasetId && r.status !== "created").map((r) => r.datasetId));
  const ids = new Set();
  for (const snapshot of snapshots) {
    if (!runDatasetIds.has(snapshot.datasetId)) continue;
    for (const id of snapshot.articleIds ?? []) ids.add(id);
  }
  for (const record of store.consumption ?? []) if (record?.articleId) ids.add(record.articleId);
  for (const record of store.contributions ?? []) {
    for (const id of [...(record.freshArticleIds ?? []), ...(record.replayArticleIds ?? [])]) if (id) ids.add(id);
  }
  return ids;
}

const store = await ArticleStore.open(undefined, { readOnly: true });
const registry = await RegistryStore.open(undefined, { readOnly: true });
try {
  const exposed = exposedIds(registry, store);
  const collected = collectRowsFromArticles(store, {
    limit: config.snapshotLimit,
    replayPercent: config.trainReplayPercent,
    validationBlocks: config.trainValBlocks,
    validationSeqLen: config.trainSeqLen,
    corpusMode: config.trainCorpusMode,
    deferValidationPartition: true,
    historicalArticleIds: exposed,
  });
  const freshIds = new Set(collected.freshArticleIds);
  const historicalIds = new Set(exposed);
  for (const row of collected.rows) if (!freshIds.has(row.articleId)) historicalIds.add(row.articleId);
  const evalSet = await loadEvaluationSet();
  const partitionRows = makeEvalGuard(evalSet).filter(collected.rows).kept;
  const target = Math.max(0, config.trainValBlocks * config.trainSeqLen);
  const base = {
    limit: config.snapshotLimit,
    splitSeed: config.trainValidationSeed,
    validationFraction: target > 0 ? 0 : config.trainValidationFraction,
    validationTargetTokens: target,
    minValidationTokens: config.trainMinValidationTokens,
    minValidationClusters: config.trainMinValidationClusters,
    historicalArticleIds: historicalIds,
    requireProspective: true,
  };
  let partition = null;
  let error = null;
  try {
    partition = buildPartition({ ...base, rows: partitionRows });
  } catch (err) {
    error = { name: err.name, code: err.code ?? null, message: err.message, meta: err.meta ?? null };
  }
  let inspection = null;
  if (!partition) {
    const p = buildPartition({ ...base, rows: partitionRows, requireProspective: false, validationTargetTokens: 1, minValidationClusters: 0 });
    const clusters = p.clusters ?? [];
    const prospective = clusters.filter((c) => c.prospective);
    inspection = {
      clusters: clusters.length,
      prospectiveClusters: prospective.length,
      prospectiveClusterTokens: prospective.map((c) => ({ clusterId: c.clusterId, tokens: c.tokens, articles: c.articleIds.length, sourceIds: c.sourceIds, publishers: c.publishers })),
      prospectiveClustersMeetingOneBlock: prospective.filter((c) => c.tokens >= config.trainSeqLen).length,
      largestProspectiveClusterTokens: prospective.reduce((n, c) => Math.max(n, c.tokens), 0),
    };
  }
  const allTrainable = [];
  let after = null;
  for (;;) {
    const page = store.articlesPage({ after, limit: 500 });
    if (!page.items.length) break;
    for (const article of page.items) {
      if (isTrainable(article)) allTrainable.push(article);
    }
    after = page.nextCursor;
    if (!after) break;
  }
  const unexposedTrainable = allTrainable.filter((a) => !exposed.has(a.articleId));
  let replayCorrection = null;
  if (partition) {
    const validationIds = new Set(partition.validationArticleIds);
    for (const row of collected.rows) {
      if (validationIds.has(row.articleId)) row.corpusRole = "validation";
    }
    const trimmed = trimReplayToFreshTarget(collected.rows, { replayPercent: config.trainReplayPercent });
    replayCorrection = {
      before: collected.stats,
      after: {
        freshRows: trimmed.freshRows.length,
        replayRows: trimmed.replayRows.length,
        removedReplayRows: trimmed.removedReplayRows,
        validationRows: partition.validationArticleIds.length,
        freshTokens: trimmed.freshTokens,
        replayTokens: trimmed.replayTokens,
        targetReplayTokens: trimmed.targetTokens,
        replayShare: trimmed.replayShare,
      },
    };
  }
  const output = {
    schema: "sma/validation-availability@1",
    at: new Date().toISOString(),
    store: store.dir,
    config: {
      snapshotLimit: config.snapshotLimit,
      trainReplayPercent: config.trainReplayPercent,
      trainSeqLen: config.trainSeqLen,
      trainValBlocks: config.trainValBlocks,
      validationTargetTokens: target,
      minValidationClusters: config.trainMinValidationClusters,
      minValidationTokens: config.trainMinValidationTokens,
      requireProspective: config.trainValidationRequireProspective,
    },
    stats: store.getStats(),
    trainable: allTrainable.length,
    unexposedTrainable: unexposedTrainable.length,
    unexposedTrainableSamples: unexposedTrainable.slice(0, 20).map((a) => ({ articleId: a.articleId, chars: String(a.text ?? "").length, sourceDomain: a.sourceDomain })),
    collected: { rows: collected.rows.length, fresh: collected.freshArticleIds.length, replay: collected.replayArticleIds.length, validation: collected.validationArticleIds.length, stats: collected.stats },
    partitionRows: partitionRows.length,
    partition: partition ? {
      targetTokens: partition.targetTokens,
      stats: partition.stats,
      exposure: partition.exposure,
      validationClusterCount: partition.validationClusterIds.length,
      validationClusterIds: partition.validationClusterIds,
      validationArticleIds: partition.validationArticleIds,
    } : null,
    error,
    inspection,
    waiting: !partition,
    replayCorrection,
    requiredNewProspectiveClusters: partition ? 0 : Math.max(1, config.trainMinValidationClusters),
    requiredNewProspectiveTokens: partition ? 0 : Math.max(config.trainSeqLen, config.trainMinValidationTokens),
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
} finally {
  await store.close();
  await registry.close();
}
