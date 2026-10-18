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
 * Only REVIEWED-and-unconsumed articles are collected. There is deliberately NO
 * reward-based synthetic cap: the training unit is continuous article text and
 * the training signal is next-token prediction, so there is no reward in the
 * signal to hack and no echo-chamber failure mode to cap. Synthetic share is
 * REPORTED in the manifest for observation, never used to drop rows.
 *
 * The only hard guard is the evaluation leak guard: any article whose content
 * hash collides with the frozen evaluation set is excluded. The eval set can
 * never be trained on.
 */

export function rowForArticle(article) {
  return {
    articleId: article.articleId,
    contentHash: article.contentHash ?? contentHash(article.text),
    text: article.text,
    domain: article.domain ?? "general",
    importance: article.importance ?? "Normal",
    origin: article.origin ?? "curated",
    createdAt: article.createdAt ?? new Date().toISOString(),
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
  { limit = config.snapshotLimit, includeConsumed = config.snapshotIncludeConsumed } = {},
) {
  const rows = [];
  const freshArticleIds = [];
  let fresh = 0;
  let retained = 0;

  const drain = (consumed) => {
    let cursor = null;
    let guard = 0;
    while (rows.length < limit && guard++ < 200) {
      const { items, nextCursor } = store.articlesPage({ after: cursor, limit: 200, status: "REVIEWED", consumed });
      for (const a of items) {
        // For the unconsumed group, `isTrainable` also excludes RETIRED/deferred
        // edges; a consumed row is REVIEWED by the status filter above.
        if (!consumed && !isTrainable(a)) continue;
        rows.push(rowForArticle(a));
        if (!consumed) {
          fresh += 1;
          freshArticleIds.push(a.articleId);
        } else {
          retained += 1;
        }
        if (rows.length >= limit) break;
      }
      if (!nextCursor) break;
      cursor = nextCursor;
    }
  };

  drain(false); // new material first
  if (includeConsumed) drain(true); // then backfill the accumulated corpus
  return { rows, freshArticleIds, stats: { collected: rows.length, fresh, retained } };
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
