export function historicallyExposedArticleIds(registry, store) {
  const priorSnapshots = typeof registry.listSnapshots === "function" ? registry.listSnapshots() : [];
  const priorRuns = typeof registry.listRuns === "function" ? registry.listRuns() : [];
  const runDatasetIds = new Set(
    priorRuns
      .filter((run) => run?.datasetId && run.status !== "created")
      .map((run) => run.datasetId),
  );
  const ids = new Set();
  for (const prior of priorSnapshots) {
    if (!runDatasetIds.has(prior.datasetId)) continue;
    for (const id of prior.articleIds ?? []) ids.add(id);
  }
  for (const record of store.consumption ?? []) {
    if (record?.articleId) ids.add(record.articleId);
  }
  for (const record of store.contributions ?? []) {
    for (const id of [...(record.freshArticleIds ?? []), ...(record.replayArticleIds ?? [])]) {
      if (id) ids.add(id);
    }
  }
  return ids;
}
