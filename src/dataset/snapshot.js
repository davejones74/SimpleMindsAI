import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, createReadStream, createWriteStream, renameSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import readline from "node:readline";
import path from "node:path";
import { config } from "../config.js";
import { contentHash, isTrainable } from "../domain/article.js";
import { preScreen } from "../domain/review-gates.js";
import { buildCommonLines, corpusRowForArticle, corpusTextForArticle } from "./corpus-text.js";
import { applyDiversityCaps, computeCorpusDiversity } from "./diversity.js";
import { normalizeSourceUrl } from "./partition.js";

/**
 * Immutable article snapshots (requirement #2 + #17).
 *
 * Training NEVER reads the live article store. A snapshot is baked ONCE into a
 * hash-sealed NDJSON file; the TrainingRun records the exact datasetId +
 * datasetVersion (+ content hash) it consumed, so any historical run is
 * byte-for-byte reproducible. The file is never rewritten.
 *
 * Fresh input is REVIEWED-and-unconsumed. A bounded replay share of consumed
 * REVIEWED rows and separately-packed validation rows may be appended. The
 * replay share is SIZED by estimated training tokens (not article counts), and
 * the authoritative tokenizer-measured share is recorded by the trainer. There is
 * deliberately NO reward-based synthetic cap: the training unit is continuous
 * article text and the training signal is next-token prediction, so there is no
 * reward in the signal to hack and no echo-chamber failure mode to cap. Synthetic share is
 * REPORTED in the manifest for observation, never used to drop rows.
 *
 * The only hard guard is the evaluation leak guard: any article whose content
 * hash collides with the frozen evaluation set is excluded. The eval set can
 * never be trained on.
 */

export function rowForArticle(article, { corpusRole = "train" } = {}) {
  return {
    articleId: article.articleId,
    contentHash: article.contentHash ?? contentHash(article.text),
    text: article.text,
    domain: article.domain ?? "general",
    importance: article.importance ?? "Normal",
    origin: article.origin ?? "curated",
    createdAt: article.createdAt ?? new Date().toISOString(),
    // The trainer packs fresh and replay into one training stream and packs
    // validation separately, so a larger validation set never removes training
    // blocks. Omitted for fresh rows to keep their historical bytes stable.
    ...(corpusRole && corpusRole !== "train" ? { corpusRole } : {}),
    // Source→curated provenance, carried ONLY when the store recorded it: the
    // `text` above is exactly what the trainer tokenises, and these fields tie
    // that trained string back to the original fetch (URL + fetched-content
    // hash) and the teacher that transformed it. Absent fields are omitted so
    // rows written before this existed serialise identically.
    ...(article.sourceUrl ? { sourceUrl: article.sourceUrl } : {}),
    ...(article.fetchedContentHash ? { fetchedContentHash: article.fetchedContentHash } : {}),
    ...(article.model ? { teacherModel: article.model } : {}),
  };
}

/**
 * Cheap, deterministic token estimate used only to SIZE replay/validation
 * selection before the tokenizer is available. The Python preflight reports
 * the authoritative counts afterwards; choosing by characters cannot change
 * what is trained once the snapshot is fixed.
 */
export function estimateTokenCount(text) {
  return Math.max(0, Math.ceil(String(text ?? "").length / 4));
}

/**
 * Eligibility for REUSED (already-consumed) rows selected as replay or
 * validation. The fresh delta is filtered at ingest; this is the same policy
 * applied on the way back in, so historical material cannot bypass it.
 */
export function reuseEligible(article) {
  if (!article || typeof article.text !== "string") return false;
  const gate = preScreen(article.text, {
    sourceUrl: article.sourceUrl ?? null,
    htmlLang: article.htmlLang ?? null,
    languageFilter: config.languageFilter ?? null,
    quality: {
      enabled: true,
      minBigramRatio: config.review.qualityMinBigramRatio,
      maxMojibakeRatio: config.review.qualityMaxMojibakeRatio,
    },
    completeness: { mode: config.review.completenessMode ?? "shadow" },
  });
  return gate.decision !== "reject";
}

function stableOrder(rows) {
  return [...rows].sort((a, b) => {
    const ha = createHash("sha256").update(String(a.contentHash ?? a.articleId)).digest("hex");
    const hb = createHash("sha256").update(String(b.contentHash ?? b.articleId)).digest("hex");
    return ha < hb ? -1 : ha > hb ? 1 : 0;
  });
}

/** Pick a deterministic replay sample sized to the requested token share. */
export function selectReplayRows(freshRows, replayCandidates, {
  replayPercent = 20,
  maxRows = Number.POSITIVE_INFINITY,
} = {}) {
  const pct = Math.max(0, Math.min(100, Number(replayPercent) || 0));
  if (!pct || !freshRows.length || !replayCandidates.length || maxRows <= 0) return [];
  const freshChars = freshRows.reduce((n, r) => n + String(r.text ?? "").length, 0);
  const targetChars = pct >= 100
    ? Number.POSITIVE_INFINITY
    : Math.round((freshChars * pct) / (100 - pct));
  const chosen = [];
  let chars = 0;
  for (const row of stableOrder(replayCandidates)) {
    if (chosen.length >= maxRows) break;
    const n = String(row.text ?? "").length;
    if (chars + n > targetChars) continue;
    chosen.push(row);
    chars += n;
  }
  if (!chosen.length) {
    const smallest = stableOrder(replayCandidates)
      .filter((r) => !chosen.includes(r))
      .sort((a, b) => String(a.text ?? "").length - String(b.text ?? "").length)[0];
    if (smallest) chosen.push(smallest);
  }
  return chosen;
}

/** Pick enough consumed rows to form the requested number of validation blocks. */
export function selectValidationRows(candidates, {
  validationBlocks = 0,
  seqLen = 128,
  excludeIds = new Set(),
} = {}) {
  if (validationBlocks <= 0 || !candidates.length) return [];
  const targetChars = validationBlocks * seqLen * 5;
  const excluded = new Set(excludeIds);
  const chosen = [];
  let chars = 0;
  for (const row of stableOrder(candidates)) {
    if (excluded.has(row.articleId)) continue;
    chosen.push(row);
    chars += String(row.text ?? "").length;
    if (chars >= targetChars) break;
  }
  return chosen;
}

/** Pull up to `limit` REVIEWED articles out of the live store.
 *
 * Default (`includeConsumed: false`) preserves the historical behaviour: only
 * unconsumed material is collected, so each run trains on the delta. With
 * `includeConsumed: true` we page the WHOLE REVIEWED corpus and backfill
 * `limit - fresh` already-consumed articles, so a run trains on the accumulated
 * corpus rather than a handful of rows.
 *
 * Ordering is deterministic and stable: within each group `articlesPage` walks
 * in ascending insertion order (the store's articleOrder, i.e. oldest first),
 * and fresh (previously unconsumed) rows always precede retained ones, so the
 * same store state always yields the same snapshot bytes.
 *
 * The two groups are kept explicitly apart:
 *   - `freshArticleIds` — articles that were UNCONSUMED at bake time. Only these
 *     may be newly consumed or deferred by the run (see lifecycle bookkeeping);
 *     they are the run's real input.
 *   - retained rows — already consumed, owned by an earlier promoted version.
 *     They contribute training text but are NOT re-consumed or re-deferred.
 *
 * Dedupe is by construction: the consumed and unconsumed pages never overlap
 * (the `consumed` filter is exclusive).
 */
export function collectRowsFromArticles(
  store,
  {
    limit = config.snapshotLimit,
    includeConsumed = config.snapshotIncludeConsumed,
    replayPercent = 0,
    validationBlocks = 0,
    validationSeqLen = config.trainSeqLen,
    corpusMode = config.trainCorpusMode,
  } = {},
) {
  if (corpusMode === "raw-text") {
    return collectRawTextRowsFromArticles(store, {
      limit,
      includeConsumed,
      replayPercent,
      validationBlocks,
      validationSeqLen,
      corpusMode,
    });
  }
  const rows = [];
  const freshArticleIds = [];
  let fresh = 0;
  let retained = 0;

  const drain = (consumed, target, { replayOnlyOnly = false } = {}) => {
    const out = [];
    let cursor = null;
    let guard = 0;
    while (out.length < target && guard++ < 200) {
      const { items, nextCursor } = store.articlesPage({
        after: cursor,
        limit: 200,
        status: "REVIEWED",
        consumed,
        ...(replayOnlyOnly ? { replayOnly: true } : {}),
      });
      for (const a of items) {
        // For the unconsumed FRESH group, `isTrainable` excludes RETIRED,
        // cooldown and replayOnly edges. The replay-only drain selects unconsumed
        // REVIEWED rows whose fresh retries are exhausted (they re-enter only
        // through the replay pool); a consumed row is REVIEWED by status filter.
        if (!consumed && !replayOnlyOnly && !isTrainable(a)) continue;
        out.push(a);
        if (out.length >= target) break;
      }
      if (!nextCursor) break;
      cursor = nextCursor;
    }
    return out;
  };

  const allFresh = drain(false, limit);
  // Replay is sized by ESTIMATED TRAINING TOKENS, not by article count: the
  // fresh delta wins the whole row budget, and replay rows are selected (from
  // the consumed/retained pool) until their estimated token mass reaches the
  // configured share of the fresh stream, then trimmed to fit the row cap. The
  // Python packer reports the AUTHORITATIVE token share afterwards, so the
  // selection can only target the proportion — never silently claim it.
  //
  // When the legacy full-backfill switch is on, fresh rows still win the whole
  // budget and retained rows fill only the remainder, preserving the historical
  // semantics.
  const pct = includeConsumed ? 100 : Math.max(0, Math.min(99, Number(replayPercent) || 0));
  const chosenFresh = allFresh.slice(0, limit);
  for (const a of chosenFresh) {
    rows.push(rowForArticle(a));
    fresh += 1;
    freshArticleIds.push(a.articleId);
  }

  let replayRows = [];
  let validationRows = [];
  if (includeConsumed) {
    const remaining = Math.max(0, limit - rows.length);
    const consumedPool = drain(true, remaining);
    const replayOnlyPool = drain(false, Math.max(0, remaining - consumedPool.length), {
      replayOnlyOnly: true,
    });
    for (const a of [...consumedPool, ...replayOnlyPool].filter(reuseEligible)) {
      rows.push(rowForArticle(a));
      retained += 1;
    }
  } else {
    const needReplay = pct > 0;
    const needValidation = validationBlocks > 0;
    if (needReplay || needValidation) {
      const poolLimit = Math.max(512, limit * 4);
      // The replay reservoir is consumed REVIEWED material plus replay-only
      // material whose fresh retries were exhausted (W3): rejected candidate
      // weights never delete the source knowledge. Re-check the SAME
      // deterministic gates on the text before any of it can re-enter training:
      // a historical non-English or corrupted article must not bypass the policy
      // merely because it was consumed (or deferred) before the gate existed.
      const pool = [
        ...drain(true, poolLimit),
        ...drain(false, poolLimit, { replayOnlyOnly: true }),
      ].filter(reuseEligible);
      if (needReplay) {
        replayRows = selectReplayRows(chosenFresh.map(rowForArticle), pool, {
          replayPercent: pct,
          maxRows: limit,
        });
        // Fresh wins the row budget; replay is trimmed to the remaining slots
        // so the snapshot never exceeds `limit` training rows.
        replayRows = replayRows.slice(0, Math.max(0, limit - rows.length));
      }
      const replayIds = new Set(replayRows.map((r) => r.articleId));
      for (const a of replayRows) {
        rows.push(rowForArticle(a, { corpusRole: "replay" }));
        retained += 1;
      }
      if (needValidation) {
        validationRows = selectValidationRows(pool, {
          validationBlocks,
          seqLen: validationSeqLen,
          excludeIds: replayIds,
        });
      }
    }
  }

  for (const a of validationRows) {
    rows.push(rowForArticle(a, { corpusRole: "validation" }));
    retained += 1;
  }

  return {
    rows,
    freshArticleIds,
    replayArticleIds: replayRows.map((r) => r.articleId),
    validationArticleIds: validationRows.map((r) => r.articleId),
    stats: {
      collected: rows.length,
      fresh,
      retained,
      replay: replayRows.length,
      validation: validationRows.length,
      estimatedReplayShare: (() => {
        const training = rows.filter((r) => r.corpusRole !== "validation");
        const total = training.reduce((n, r) => n + estimateTokenCount(r.text), 0);
        return total
          ? replayRows.reduce((n, r) => n + estimateTokenCount(r.text), 0) / total
          : 0;
      })(),
    },
  };
}

function drainArticlePool(store, { consumed, target, replayOnlyOnly = false, requireTrainable = false }) {
  const out = [];
  let cursor = null;
  let guard = 0;
  while (out.length < target && guard++ < 200) {
    const { items, nextCursor } = store.articlesPage({
      after: cursor,
      limit: 200,
      status: "REVIEWED",
      consumed,
      ...(replayOnlyOnly ? { replayOnly: true } : {}),
    });
    for (const article of items) {
      if (requireTrainable && !isTrainable(article)) continue;
      out.push(article);
      if (out.length >= target) break;
    }
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  return out;
}

export function collectRawTextRowsFromArticles(
  store,
  {
    limit = config.snapshotLimit,
    includeConsumed = config.snapshotIncludeConsumed,
    replayPercent = 0,
    validationBlocks = 0,
    validationSeqLen = config.trainSeqLen,
    corpusMode = config.trainCorpusMode,
    minChars = config.trainCorpusMinChars,
    minSentenceRatio = config.trainCorpusMinSentenceRatio,
    commonLineDocs = config.trainCorpusCommonLineDocs,
    deferValidationPartition = false,
    supportedLanguages = config.trainSupportedLanguages,
    languageMinConfidence = config.trainLanguageMinConfidence,
    languageUnknownPolicy = config.trainLanguageUnknownPolicy,
    maxFallbackTokenShare = config.trainCorpusMaxFallbackTokenShare,
    maxSourceTokenShare = config.trainMaxSourceTokenShare,
    maxPublisherTokenShare = config.trainMaxPublisherTokenShare,
    mergeSourceRawText = config.trainMergeSourceRawText,
  } = {},
) {
  const freshPool = drainArticlePool(store, { consumed: false, target: limit, requireTrainable: true });
  let retainedPool = [];
  let replayPool = [];
  let validationPool = [];

  if (includeConsumed) {
    const remaining = Math.max(0, limit - freshPool.length);
    const consumedPool = drainArticlePool(store, { consumed: true, target: remaining });
    const replayOnlyPool = drainArticlePool(store, {
      consumed: false,
      target: Math.max(0, remaining - consumedPool.length),
      replayOnlyOnly: true,
    });
    retainedPool = [...consumedPool, ...replayOnlyPool];
    if (!deferValidationPartition && validationBlocks > 0 && retainedPool.length) {
      const pseudo = retainedPool.map((article) => ({
        articleId: article.articleId,
        text: article.rawText ?? article.text ?? "",
      }));
      const chosen = selectValidationRows(pseudo, { validationBlocks, seqLen: validationSeqLen });
      const ids = new Set(chosen.map((row) => row.articleId));
      validationPool = retainedPool.filter((article) => ids.has(article.articleId));
      retainedPool = retainedPool.filter((article) => !ids.has(article.articleId));
    }
  } else {
    const pct = Math.max(0, Math.min(99, Number(replayPercent) || 0));
    if (pct > 0 || validationBlocks > 0) {
      const poolLimit = Math.max(512, limit * 4);
      const pool = [
        ...drainArticlePool(store, { consumed: true, target: poolLimit }),
        ...drainArticlePool(store, { consumed: false, target: poolLimit, replayOnlyOnly: true }),
      ].filter(reuseEligible);
      if (pct > 0) {
        const chosen = selectReplayRows(
          freshPool.map((article) => ({ articleId: article.articleId, text: article.rawText ?? article.text ?? "" })),
          pool.map((article) => ({ articleId: article.articleId, text: article.rawText ?? article.text ?? "" })),
          { replayPercent: pct, maxRows: limit },
        );
        const ids = new Set(chosen.map((row) => row.articleId));
        replayPool = pool
          .filter((article) => ids.has(article.articleId))
          .slice(0, Math.max(0, limit - freshPool.length));
      }
      const replayIds = new Set(replayPool.map((article) => article.articleId));
      if (!deferValidationPartition && validationBlocks > 0) {
        const candidates = pool.filter((article) => !replayIds.has(article.articleId));
        const chosen = selectValidationRows(
          candidates.map((article) => ({ articleId: article.articleId, text: article.rawText ?? article.text ?? "" })),
          { validationBlocks, seqLen: validationSeqLen },
        );
        const ids = new Set(chosen.map((row) => row.articleId));
        validationPool = candidates.filter((article) => ids.has(article.articleId));
      }
    }
  }

  const allPools = [...freshPool, ...retainedPool, ...replayPool, ...validationPool];
  const commonLines = buildCommonLines(allPools, { threshold: commonLineDocs });
  const sourceKey = (article) => article.fetchedContentHash || normalizeSourceUrl(article.sourceUrl) || article.articleId;
  // One representative full-text row per original source. Other curated chunks
  // from that source remain useful as fallback text, but must not each embed a
  // second full copy of the same raw article.
  const rawTextRepresentative = new Map();
  if (mergeSourceRawText) {
    for (const article of allPools) {
      const key = sourceKey(article);
      const selected = corpusTextForArticle(article, { mode: "raw-text", commonLines, minChars, minSentenceRatio });
      const score = selected.source === "rawText" ? selected.chars : -1;
      const current = rawTextRepresentative.get(key);
      if (!current || score > current.score) {
        rawTextRepresentative.set(key, { articleId: article.articleId, score });
      }
    }
  }
  const consideredSources = new Set(allPools.map(sourceKey));
  const includedSources = new Set();
  const byHash = new Map();
  let rows = [];
  const freshArticleIds = [];
  const replayArticleIds = [];
  const validationArticleIds = [];
  const stats = {
    collected: 0,
    fresh: 0,
    retained: 0,
    replay: 0,
    validation: 0,
    estimatedReplayShare: 0,
    corpusMode,
    articlesConsidered: allPools.length,
    articlesIncluded: 0,
    articlesExcluded: 0,
    excludedByReason: {},
    deduplicatedArticles: 0,
    uniqueSourcesConsidered: consideredSources.size,
    uniqueSourcesIncluded: 0,
    usedSourceFraction: 0,
    estimatedTokens: 0,
    estimatedFreshTokens: 0,
    estimatedRetainedTokens: 0,
    estimatedReplayTokens: 0,
    estimatedValidationTokens: 0,
    rawTextRows: 0,
    fallbackRows: 0,
    rawTextSuppressedRows: 0,
    fallbackTokenShare: 0,
    languageDistribution: {},
    qualityDistribution: {},
    diversity: null,
    caps: null,
  };
  const bump = (key) => {
    stats.excludedByReason[key] = (stats.excludedByReason[key] ?? 0) + 1;
    stats.articlesExcluded += 1;
  };

  const addPool = (pool, role, roleIds, kind) => {
    for (const article of pool) {
      const representative = mergeSourceRawText ? rawTextRepresentative.get(sourceKey(article)) : null;
      const suppressRawText = Boolean(representative && representative.articleId !== article.articleId);
      const { row, selected, gate } = corpusRowForArticle(article, {
        mode: corpusMode,
        corpusRole: role,
        commonLines,
        minChars,
        minSentenceRatio,
        suppressRawText,
        supportedLanguages,
        languageMinConfidence,
        languageUnknownPolicy,
      });
      if (gate.decision === "reject") {
        bump(`curation:${gate.gate ?? "unknown"}`);
        continue;
      }
      if (!row.languageEligible) {
        bump(`language:${row.language || "und"}`);
        continue;
      }
      if (row.rawTextSuppressed) stats.rawTextSuppressedRows += 1;
      const minLength = selected.source === "rawText" ? minChars : 20;
      if (!row.text || row.text.length < minLength) {
        bump("short");
        continue;
      }
      const existing = byHash.get(row.contentHash);
      if (existing) {
        if (role === "validation") {
          bump("validation-duplicate");
          continue;
        }
        existing.sourceArticleIds = existing.sourceArticleIds ?? [existing.articleId];
        if (!existing.sourceArticleIds.includes(article.articleId)) existing.sourceArticleIds.push(article.articleId);
        roleIds.push(article.articleId);
        stats.deduplicatedArticles += 1;
        continue;
      }
      byHash.set(row.contentHash, row);
      rows.push(row);
      roleIds.push(article.articleId);
      includedSources.add(sourceKey(article));
      stats.articlesIncluded += 1;
      if (selected.source === "rawText") stats.rawTextRows += 1;
      else stats.fallbackRows += 1;
      const tokens = estimateTokenCount(row.text);
      stats.estimatedTokens += tokens;
      if (kind === "fresh") {
        stats.fresh += 1;
        stats.estimatedFreshTokens += tokens;
      } else if (kind === "retained") {
        stats.retained += 1;
        stats.estimatedRetainedTokens += tokens;
      } else if (kind === "replay") {
        stats.replay += 1;
        stats.estimatedReplayTokens += tokens;
      } else if (kind === "validation") {
        stats.validation += 1;
        stats.estimatedValidationTokens += tokens;
      }
    }
  };

  addPool(freshPool, "train", freshArticleIds, "fresh");
  addPool(retainedPool, "train", [], "retained");
  addPool(replayPool, "replay", replayArticleIds, "replay");
  addPool(validationPool, "validation", validationArticleIds, "validation");

  const beforeCaps = rows.length;
  const capped = applyDiversityCaps(rows, {
    maxFallbackTokenShare,
    maxSourceTokenShare,
    maxPublisherTokenShare,
  });
  rows = capped.kept;
  if (capped.removed.length) {
    const keptIds = new Set(rows.map((row) => row.articleId));
    for (const [ids, list] of [
      [freshArticleIds, freshArticleIds],
      [replayArticleIds, replayArticleIds],
      [validationArticleIds, validationArticleIds],
    ]) {
      for (let i = list.length - 1; i >= 0; i -= 1) if (!keptIds.has(list[i])) list.splice(i, 1);
    }
    for (const [reason, count] of Object.entries(capped.removedByReason)) {
      stats.excludedByReason[reason] = (stats.excludedByReason[reason] ?? 0) + count;
      stats.articlesExcluded += count;
    }
  }
  stats.caps = { beforeCaps, afterCaps: rows.length, removed: capped.removed.length, removedByReason: capped.removedByReason };

  stats.collected = rows.length;
  stats.uniqueSourcesIncluded = includedSources.size;
  stats.usedSourceFraction = consideredSources.size ? includedSources.size / consideredSources.size : 0;
  const trainingTokens = rows
    .filter((row) => row.corpusRole !== "validation")
    .reduce((total, row) => total + estimateTokenCount(row.text), 0);
  stats.estimatedReplayShare = trainingTokens ? stats.estimatedReplayTokens / trainingTokens : 0;
  const diversity = computeCorpusDiversity(rows);
  stats.diversity = diversity;
  stats.fallbackTokenShare = diversity.totalTokensEstimated
    ? diversity.qualityTiers.find((tier) => tier.key === "fallback")?.share ?? 0
    : 0;
  stats.languageDistribution = Object.fromEntries(diversity.languages.map((entry) => [entry.key, entry.tokens]));
  stats.qualityDistribution = Object.fromEntries(diversity.qualityTiers.map((entry) => [entry.key, entry.tokens]));

  return {
    rows,
    freshArticleIds,
    replayArticleIds,
    validationArticleIds,
    stats,
  };
}

function writeChunk(ws, chunk) {
  return new Promise((resolve, reject) => {
    ws.write(chunk, (err) => (err ? reject(err) : resolve()));
  });
}

function finishStream(ws) {
  return new Promise((resolve, reject) => {
    ws.once("finish", resolve);
    ws.once("error", reject);
    ws.end();
  });
}

/**
 * Bake rows into an immutable snapshot and register its manifest.
 *
 * Rows are streamed to a temp file while a running SHA-256 is computed, then
 * atomically renamed to the hash-addressed final name. Peak memory stays flat
 * (one row at a time) rather than materialising the whole serialized corpus.
 * Returns the manifest (registry), the on-disk artifact, and guard outcomes.
 */
export async function buildSnapshot({
  registry,
  rowsRaw,
  source = "store",
  dir = config.paths.snapshots,
  evalGuard = null,
  freshArticleIds = null,
  replayArticleIds = null,
  validationArticleIds = null,
  partition = null,
  corpusMode = config.trainCorpusMode,
  corpusPolicy = "fresh-delta",
  corpusStats = null,
}) {
  await mkdir(dir, { recursive: true });

  let excluded = [];
  let rows = rowsRaw;
  if (evalGuard) {
    const res = evalGuard.filter(rows);
    rows = res.kept;
    excluded = res.excluded;
  }

  const datasetId = registry.nextDatasetId();
  const tmpFile = path.join(dir, `${datasetId}.tmp`);
  const hash = createHash("sha256");
  const articleIds = [];
  const byImportance = { Normal: 0, Important: 0, Critical: 0 };
  const byDomain = new Map();
  let syntheticCount = 0;

  const ws = createWriteStream(tmpFile);
  try {
    for (const r of rows) {
      // One canonical line per article; the concatenation of these lines IS the
      // immutable artifact (and therefore the dataset hash).
      const line = `${JSON.stringify(r)}\n`;
      hash.update(line, "utf8");
      articleIds.push(r.articleId);
      if (r.importance in byImportance) byImportance[r.importance] += 1;
      byDomain.set(r.domain, (byDomain.get(r.domain) ?? 0) + 1);
      if (r.origin === "synthetic") syntheticCount += 1;
      await writeChunk(ws, line);
    }
    await finishStream(ws);
  } catch (err) {
    ws.destroy();
    if (existsSync(tmpFile)) unlinkSync(tmpFile);
    throw err;
  }

  const digest = hash.digest("hex");
  const datasetVersion = digest.slice(0, 12);
  const file = path.join(dir, `${datasetId}-${datasetVersion}.jsonl`);
  // Hash-addressed name ⇒ identical content already on disk is the same artifact.
  if (existsSync(file)) unlinkSync(tmpFile);
  else renameSync(tmpFile, file);

  // Which rows were newly-collected (previously unconsumed) at bake time. These
  // alone drive consumption/deferral bookkeeping; every `articleId` is still
  // part of the trained corpus. Absent (e.g. an injected rowsRaw), the whole
  // set is treated as fresh, matching the historical delta-only behaviour.
  let partitionSummary = null;
  if (partition) {
    const splitsDir = path.join(dir, "splits");
    await mkdir(splitsDir, { recursive: true });
    const assignmentFile = path.join(splitsDir, `${datasetId}-${datasetVersion}.json`);
    const assignment = {
      schema: "sma/partition-assignment@1",
      datasetId,
      datasetVersion,
      policyVersion: partition.policyVersion,
      clusterPolicyVersion: partition.clusterPolicyVersion,
      splitSeed: partition.splitSeed,
      splitHash: partition.splitHash,
      targetTokens: partition.targetTokens,
      requestedTargetTokens: partition.requestedTargetTokens,
      assignments: partition.assignments,
      clusters: partition.clusters,
      nearDuplicatePairs: partition.nearDuplicatePairs,
      exposure: partition.exposure,
      stats: partition.stats,
    };
    const assignmentBytes = `${JSON.stringify(assignment, null, 2)}\n`;
    await writeFile(assignmentFile, assignmentBytes, "utf8");
    const assignmentHash = createHash("sha256").update(assignmentBytes).digest("hex");
    partitionSummary = {
      policyVersion: partition.policyVersion,
      clusterPolicyVersion: partition.clusterPolicyVersion,
      splitSeed: partition.splitSeed,
      splitHash: partition.splitHash,
      targetTokens: partition.targetTokens,
      requestedTargetTokens: partition.requestedTargetTokens,
      assignmentFile,
      assignmentFileHash: assignmentHash,
      exposure: partition.exposure,
      stats: partition.stats,
      clusterCount: partition.clusters.length,
      nearDuplicatePairCount: partition.nearDuplicatePairs.length,
    };
  }

  const keptIds = new Set(articleIds);
  const freshIds = freshArticleIds
    ? freshArticleIds.filter((id) => keptIds.has(id))
    : articleIds;
  const replayIds = (replayArticleIds ?? []).filter((id) => keptIds.has(id));
  const validationIds = (validationArticleIds ?? []).filter((id) => keptIds.has(id));

  const manifest = await registry.createSnapshot({
    datasetId,
    datasetVersion,
    source,
    recordCount: rows.length,
    articleCount: rows.length,
    syntheticCount,
    syntheticShare: rows.length ? syntheticCount / rows.length : 0,
    byImportance,
    file,
    hash: digest,
    categories: Object.fromEntries([...byDomain.entries()]),
    articleIds,
    freshArticleIds: freshIds,
    replayArticleIds: replayIds,
    validationArticleIds: validationIds,
    leakExcluded: excluded.map((r) => r.contentHash),
    leakGuard: evalGuard?.stats ? evalGuard.stats() : null,
    corpusMode,
    corpusPolicy,
    corpusStats,
    corpusDiversity: corpusStats?.diversity ?? null,
    partition: partitionSummary,
    builderVersion: "snapshot-article-v2",
  });
  return { manifest, file, rows, excluded, datasetVersion, hash: digest };
}

export const snapshotRowReader = {
  async read(file) {
    const out = [];
    if (!existsSync(file)) throw new Error(`snapshot file missing: ${file}`);
    const rl = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const raw of rl) {
      if (!raw.trim()) continue;
      try {
        out.push(JSON.parse(raw));
      } catch {
        /* skip corrupt tail */
      }
    }
    return out;
  },
};
