import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Durable cache for immutable BASELINE (parent) evaluations.
 *
 * The active version is frozen, so its loss on the frozen eval set is immutable
 * for a given eval configuration (seq-len, micro-batch, device, dtype, eval-set
 * content). Caching it means a promotion run only evaluates the CANDIDATE,
 * halving eval cost and the chance of hitting the eval deadline on slow hardware.
 *
 * The cache key captures everything that could change the measured loss; a cache
 * miss (or an unreadable/corrupt file) simply re-evaluates, so the cache can never
 * cause a wrong promotion — it is purely an optimisation.
 */

const CACHE_SCHEMA = "v2";

export function evalCacheFile(dir) {
  return path.join(dir, "eval-cache.json");
}

/** @returns {Record<string, object>} the cache map, or {} when absent/corrupt. */
export function loadEvalCache(dir) {
  try {
    if (!dir || !existsSync(evalCacheFile(dir))) return {};
    const parsed = JSON.parse(readFileSync(evalCacheFile(dir), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function saveEvalCache(dir, cache) {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(evalCacheFile(dir), JSON.stringify(cache, null, 2));
  } catch {
    // Best-effort: a failed write only means the next run re-evaluates the parent.
  }
}

/**
 * Deterministic cache key for one version's loss. Includes the eval-set content
 * hash, the eval hyperparameters, and whether paired per-document evidence was
 * requested. Two losses are only interchangeable when the evidence shape is the
 * same; an aggregate-only entry must never satisfy an enforce-mode gate that
 * requires per-document rows.
 */
export function baselineCacheKey({
  version,
  evalSetHash,
  seqLen,
  microBatch,
  device,
  dtype = "float32",
  perDocument = false,
  codeFingerprint = null,
}) {
  return [
    CACHE_SCHEMA,
    version,
    evalSetHash,
    seqLen,
    microBatch,
    device,
    dtype,
    perDocument ? "per-document" : "aggregate",
    codeFingerprint ?? "code-unfingerprinted",
  ].join("::");
}

/**
 * True only when a cached evaluation carries the evidence the current run
 * requires. A valid cache hit for an enforce-mode gate must contain at least one
 * finite per-document loss with a positive token weight.
 */
export function cacheEntrySatisfiesEvidence(entry, { perDocument = false } = {}) {
  if (!entry || entry.ok !== true) return false;
  if (!perDocument) return true;
  if (!Array.isArray(entry.perDocument) || entry.perDocument.length === 0) return false;
  return entry.perDocument.some(
    (row) => Number.isFinite(Number(row?.loss)) && Number(row?.tokens) > 0,
  );
}

/**
 * Remove cache entries that fail `predicate(key, entry)`. Returns the removed
 * keys. Used to physically retire stale aggregate-only entries; key-version
 * invalidation already makes them unreachable, so this is hygiene/audit.
 */
export function pruneEvalCache(dir, predicate) {
  const cache = loadEvalCache(dir);
  const removed = [];
  for (const [key, entry] of Object.entries(cache)) {
    if (predicate(key, entry)) continue;
    removed.push(key);
    delete cache[key];
  }
  if (removed.length) saveEvalCache(dir, cache);
  return { removed, remaining: Object.keys(cache).length };
}
