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
 * hash and the eval hyperparameters so a re-frozen set or a config change yields
 * a fresh key (and therefore a re-evaluation) rather than a stale hit.
 */
export function baselineCacheKey({ version, evalSetHash, seqLen, microBatch, device, dtype = "float32" }) {
  return [version, evalSetHash, seqLen, microBatch, device, dtype].join("::");
}
