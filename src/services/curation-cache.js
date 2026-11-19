import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Durable cache for successful teacher-curation chunks.
 *
 * A cache entry is valid only for the exact source bytes, canonical source
 * identity, chunk boundaries, teacher and curation configuration that produced
 * it. The key is a content hash; no fuzzy or timestamp-only reuse is allowed.
 */
export const CURATION_CACHE_VERSION = "curation-chunk-cache-v1";

const sha256 = (value) => createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");

export function curationCacheKey({
  sourceIdentity = "",
  sourceContentHash = "",
  chunkIndex = 0,
  chunkText = "",
  chunkMaxChars = 0,
  chunkMinChars = 0,
  chunkTargetChars = 0,
  strategy = "",
  teacherModel = "",
  focus = null,
} = {}) {
  return sha256(JSON.stringify({
    version: CURATION_CACHE_VERSION,
    sourceIdentity: String(sourceIdentity ?? ""),
    sourceContentHash: String(sourceContentHash ?? ""),
    chunkIndex: Number(chunkIndex) || 0,
    chunkHash: sha256(chunkText),
    chunkChars: String(chunkText ?? "").length,
    chunkMaxChars: Number(chunkMaxChars) || 0,
    chunkMinChars: Number(chunkMinChars) || 0,
    chunkTargetChars: Number(chunkTargetChars) || 0,
    strategy: String(strategy ?? ""),
    teacherModel: String(teacherModel ?? ""),
    focus: focus?.prompt ? sha256(focus.prompt) : null,
  }));
}

export async function openCurationCache(file, { logger = null } = {}) {
  const entries = new Map();
  let loaded = false;
  let hits = 0;
  let misses = 0;
  let writes = 0;
  let invalid = 0;

  async function load() {
    if (loaded) return;
    loaded = true;
    try {
      const raw = await readFile(file, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (row?.key && Array.isArray(row.units)) entries.set(row.key, row);
          else invalid += 1;
        } catch { invalid += 1; }
      }
    } catch (err) {
      if (err?.code !== "ENOENT") logger?.warn?.(`[curation-cache] read failed: ${err.message}`);
    }
  }

  async function persist(row) {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(row)}\n`, "utf8");
    writes += 1;
  }

  return {
    get(key) {
      const row = entries.get(key);
      if (row) { hits += 1; return row.units; }
      misses += 1;
      return null;
    },
    async set(key, units, meta = {}) {
      if (!key || !Array.isArray(units)) return;
      const row = {
        key,
        version: CURATION_CACHE_VERSION,
        units,
        sourceIdentity: meta.sourceIdentity ?? null,
        sourceContentHash: meta.sourceContentHash ?? null,
        chunkIndex: meta.chunkIndex ?? null,
        createdAt: new Date().toISOString(),
      };
      entries.set(key, row);
      await persist(row);
    },
    async load() { await load(); },
    stats() { return { entries: entries.size, hits, misses, writes, invalid, file }; },
  };
}
