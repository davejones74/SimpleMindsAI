import { mkdir } from "node:fs/promises";
import { existsSync, createReadStream, createWriteStream, renameSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import readline from "node:readline";
import path from "node:path";
import { config } from "../config.js";
import { contentHash, isTrainable } from "../domain/article.js";

/**
 * Immutable article snapshots (requirement #2 + #17).
 *
 * Training NEVER reads the live article store. A snapshot is baked ONCE into a
 * hash-sealed NDJSON file; the TrainingRun records the exact datasetId +
 * datasetVersion (+ content hash) it consumed, so any historical run is
 * byte-for-byte reproducible. The file is never rewritten.
 *
 * Fresh input is REVIEWED-and-unconsumed. A bounded replay share of consumed
 * REVIEWED rows and separately-packed validation rows may be appended. There is
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
  } = {},
) {
  const rows = [];
  const freshArticleIds = [];
  let fresh = 0;
  let retained = 0;

  const drain = (consumed, target) => {
    const out = [];
    let cursor = null;
    let guard = 0;
    while (out.length < target && guard++ < 200) {
      const { items, nextCursor } = store.articlesPage({ after: cursor, limit: 200, status: "REVIEWED", consumed });
      for (const a of items) {
        // For the unconsumed group, `isTrainable` also excludes RETIRED/deferred
        // edges; a consumed row is REVIEWED by the status filter above.
        if (!consumed && !isTrainable(a)) continue;
        out.push(a);
        if (out.length >= target) break;
      }
      if (!nextCursor) break;
      cursor = nextCursor;
    }
    return out;
  };

  const allFresh = drain(false, limit);
  // Reserve roughly 20% of the training budget for replay. When the legacy
  // full-backfill switch is on, fresh rows win the whole budget and retained
  // rows fill only the remainder, preserving the historical semantics.
  const pct = includeConsumed ? 100 : Math.max(0, Math.min(99, Number(replayPercent) || 0));
  const freshTarget = pct > 0 && !includeConsumed
    ? Math.max(1, Math.floor(limit * (1 - pct / 100)))
    : limit;
  const chosenFresh = allFresh.slice(0, freshTarget);
  for (const a of chosenFresh) {
    rows.push(rowForArticle(a));
    fresh += 1;
    freshArticleIds.push(a.articleId);
  }

  let replayRows = [];
  let validationRows = [];
  if (includeConsumed) {
    const remaining = Math.max(0, limit - rows.length);
    for (const a of drain(true, remaining)) {
      rows.push(rowForArticle(a));
      retained += 1;
    }
  } else {
    const needReplay = pct > 0 && rows.length < limit;
    const needValidation = validationBlocks > 0;
    if (needReplay || needValidation) {
      const poolLimit = Math.max(512, limit * 4);
      const pool = drain(true, poolLimit);
      if (needReplay) {
        replayRows = selectReplayRows(chosenFresh.map(rowForArticle), pool, {
          replayPercent: pct,
          maxRows: limit - rows.length,
        });
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

  // If replay was unavailable, use the reserved space for fresh material rather
  // than shipping a corpus with an artificial hole in it.
  if (!includeConsumed && rows.length < limit && allFresh.length > chosenFresh.length) {
    for (const a of allFresh.slice(chosenFresh.length)) {
      if (rows.length >= limit) break;
      rows.push(rowForArticle(a));
      fresh += 1;
      freshArticleIds.push(a.articleId);
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
    builderVersion: "snapshot-article-v1",
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
