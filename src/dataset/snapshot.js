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

/** Pull up to `limit` REVIEWED, unconsumed articles out of the live store. */
export function collectRowsFromArticles(store, { limit = config.snapshotLimit } = {}) {
  const rows = [];
  let cursor = null;
  let guard = 0;
  while (rows.length < limit && guard++ < 200) {
    const { items, nextCursor } = store.articlesPage({ after: cursor, limit: 200, status: "REVIEWED", consumed: false });
    for (const a of items) {
      // Trainable: reviewed, not consumed, not retired. A deferred article is
      // still REVIEWED and unconsumed, so it remains eligible here and is
      // picked up again by a later run; a RETIRED one never reaches this page.
      if (!isTrainable(a)) continue;
      rows.push(rowForArticle(a));
      if (rows.length >= limit) break;
    }
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  return { rows, stats: { collected: rows.length } };
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
