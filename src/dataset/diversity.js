/**
 * Corpus diversity and quality reporting.
 *
 * Everything here is measurement. Caps are applied by the caller and are
 * intentionally separate from the measurement so an operator can see the raw
 * concentration before any sampling/deferral.
 */
export const DIVERSITY_POLICY_VERSION = "corpus-diversity-v1";

function tokenEstimate(row) {
  if (Number.isFinite(Number(row?.estimatedTokens))) return Number(row.estimatedTokens);
  return Math.max(0, Math.ceil(String(row?.text ?? "").length / 4));
}

function distribution(counter, total) {
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, value]) => ({ key, tokens: value, share: total ? value / total : 0 }));
}

function herfindahl(counter, total) {
  if (!total) return 0;
  let sum = 0;
  for (const value of counter.values()) sum += (value / total) ** 2;
  return sum;
}

export function computeCorpusDiversity(rows) {
  const total = rows.reduce((sum, row) => sum + tokenEstimate(row), 0);
  const sources = new Map();
  const publishers = new Map();
  const languages = new Map();
  const quality = new Map();
  let rawTextRows = 0;
  let fallbackRows = 0;
  let curatedRows = 0;
  let tinyRows = 0;
  let tinyTokens = 0;

  for (const row of rows) {
    const tokens = tokenEstimate(row);
    const source = row.sourceId ?? row.fetchedContentHash ?? row.sourceUrl ?? row.articleId ?? "unknown";
    const publisher = row.publisherId ?? row.sourceDomain ?? "unknown";
    const language = row.language ?? "unknown";
    const tier = row.qualityTier ?? "unknown";
    sources.set(source, (sources.get(source) ?? 0) + tokens);
    publishers.set(publisher, (publishers.get(publisher) ?? 0) + tokens);
    languages.set(language, (languages.get(language) ?? 0) + tokens);
    quality.set(tier, (quality.get(tier) ?? 0) + tokens);
    if (tier === "full-text") rawTextRows += 1;
    else if (tier === "fallback") fallbackRows += 1;
    else if (tier === "curated") curatedRows += 1;
    if (tokens < 20) {
      tinyRows += 1;
      tinyTokens += tokens;
    }
  }

  const sourceDist = distribution(sources, total);
  const publisherDist = distribution(publishers, total);
  const topShare = (items, n) => items.slice(0, n).reduce((sum, item) => sum + item.tokens, 0) / (total || 1);

  return {
    version: DIVERSITY_POLICY_VERSION,
    totalRows: rows.length,
    totalTokensEstimated: total,
    distinctSources: sources.size,
    distinctPublishers: publishers.size,
    top1SourceShare: topShare(sourceDist, 1),
    top10SourceShare: topShare(sourceDist, 10),
    top1PublisherShare: topShare(publisherDist, 1),
    top10PublisherShare: topShare(publisherDist, 10),
    sourceHerfindahl: herfindahl(sources, total),
    publisherHerfindahl: herfindahl(publishers, total),
    sources: sourceDist.slice(0, 50),
    publishers: publisherDist.slice(0, 50),
    languages: distribution(languages, total),
    qualityTiers: distribution(quality, total),
    counts: {
      rawTextRows,
      fallbackRows,
      curatedRows,
      tinyRows,
      tinyTokens,
      tinyTokenShare: total ? tinyTokens / total : 0,
    },
  };
}

/**
 * Apply configurable token-share caps by deterministic deferral from this
 * snapshot. The article store is never modified; overrepresented material can
 * re-enter a later snapshot. Zero disables a cap.
 */
export function applyDiversityCaps(rows, {
  maxFallbackTokenShare = 0,
  maxSourceTokenShare = 0,
  maxPublisherTokenShare = 0,
} = {}) {
  const kept = [...rows];
  const removed = [];
  const remove = (row, reason) => {
    removed.push({ articleId: row.articleId, reason });
    return false;
  };

  const total = () => kept.reduce((sum, row) => sum + tokenEstimate(row), 0);

  if (maxFallbackTokenShare > 0) {
    let fallback = kept.filter((row) => row.qualityTier === "fallback");
    let fallbackTokens = fallback.reduce((sum, row) => sum + tokenEstimate(row), 0);
    let allTokens = total();
    for (const row of [...fallback].sort((a, b) => tokenEstimate(a) - tokenEstimate(b))) {
      if (allTokens <= 0 || fallbackTokens / allTokens <= maxFallbackTokenShare) break;
      const index = kept.indexOf(row);
      if (index >= 0) {
        kept.splice(index, 1);
        remove(row, "fallback-cap");
        fallbackTokens -= tokenEstimate(row);
        allTokens -= tokenEstimate(row);
      }
    }
  }

  for (const [cap, field, reason] of [
    [maxSourceTokenShare, "sourceId", "source-cap"],
    [maxPublisherTokenShare, "publisherId", "publisher-cap"],
  ]) {
    if (!(cap > 0)) continue;
    const groups = new Map();
    for (const row of kept) {
      const key = row[field] ?? "unknown";
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
    }
    const allTokens = total();
    for (const list of groups.values()) {
      let groupTokens = list.reduce((sum, row) => sum + tokenEstimate(row), 0);
      if (!allTokens || groupTokens / allTokens <= cap) continue;
      for (const row of [...list].sort((a, b) => tokenEstimate(a) - tokenEstimate(b))) {
        if (groupTokens / allTokens <= cap) break;
        const index = kept.indexOf(row);
        if (index >= 0) {
          kept.splice(index, 1);
          remove(row, reason);
          groupTokens -= tokenEstimate(row);
        }
      }
    }
  }

  return { kept, removed, removedByReason: removed.reduce((acc, item) => {
    acc[item.reason] = (acc[item.reason] ?? 0) + 1;
    return acc;
  }, {}) };
}
