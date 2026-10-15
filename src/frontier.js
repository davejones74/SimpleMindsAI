import { mkdir, writeFile, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { contentHashFor } from "./harness/fetcher.js";

const FRONTIER_DIR = "data/frontier";
const FRONTIER_FILE = "frontier.ndjson";

// Canonical URL: lowercase scheme+host, sort path segments, preserve query params as-is
// (no removal, no reordering assumption). Deterministic form for deduplication.
function canonicalURL(urlString) {
  try {
    const u = new URL(urlString);
    // Lowercase scheme and host
    const scheme = u.protocol.toLowerCase();
    const host = u.host.toLowerCase();
    // Path: keep as-is (no normalization assumed); split into segments for deterministic ordering
    let path = u.pathname; // keep trailing slash behavior
    // Sort query param keys deterministically, preserve values
    const searchParams = u.search;
    let query = "";
    if (searchParams.toString()) {
      const sortedKeys = [...searchParams.keys()].sort();
      const entries = sortedKeys.map((key) => `${key}=${searchParams.get(key)}`);
      query = "?" + entries.join("&");
    }
    // Reconstruct: ensure no duplicate slashes, clean up
    const canonical = `${scheme}//${host}${path}${query}`;
    return canonical;
  } catch {
    return null;
  }
}

// Frontier URL state
const URL_STATE = {
  QUEUED: "queued",
  IN_PROGRESS: "in-progress",
  VISITED: "visited",
  DEFERRED: "deferred",
  FAILED: "failed",
};

// Frontier record per URL
function makeFrontierRecord(url, state, depth, parent, seed, metadata = {}) {
  return {
    url,
    state,
    depth: depth ?? 0,
    parent: parent ?? null,
    seed: seed ?? null, // original CRAWL_URL that led to this URL
    retries: metadata.retries ?? 0,
    lastError: metadata.lastError ?? null,
    lastErrorAt: metadata.lastErrorAt ?? null,
    claimedAt: metadata.claimedAt ?? null,
    completedAt: metadata.completedAt ?? null,
    discoveryProvenance: metadata.discoveryProvenance ?? null, // { type: "link_extraction", parentUrl, depth }
    contentHash: null, // populated after fetch; separate from URL dedup
  };
}

// Frontier class — manages persistent URL frontier
export class Frontier {
  constructor(opts = {}) {
    this.dir = opts.dir ?? FRONTIER_DIR;
    this.state = opts.state ?? new Map(); // in-memory Map<url, record>
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;
    await mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, FRONTIER_FILE);
    try {
      const raw = await readFile(file, "utf8");
      const lines = raw.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        try {
          const record = JSON.parse(line);
          // Rehydrate; validate essential fields
          if (record.url && record.state) {
            const canonical = canonicalURL(record.url);
            if (canonical) {
              this.state.set(canonical, record);
            }
          }
        } catch {
          // skip malformed lines (resilient read)
        }
      }
    } catch {
      // no frontier file yet — first run
    }
    this.initialized = true;
  }

  // Idempotent enqueue: returns the canonical key; if URL already tracked,
  // does not re-enqueue. If URL failed with exhausted retries, may re-enqueue
  // only when `force` is set.
  async enqueue(url, { depth = 0, parent = null, seed = null, force = false, maxRetries = 2 } = {}) {
    if (!this.initialized) await this.init();
    const canonical = canonicalURL(url);
    if (!canonical) return null;

    const existing = this.state.get(canonical);
    if (existing) {
      // Idempotency: already visited (completed) => never re-enqueue.
      if (existing.state === URL_STATE.VISITED && existing.completedAt) return null;
      // Failed with retries exhausted => terminal unless explicitly forced.
      if (existing.state === URL_STATE.FAILED && (existing.retries ?? 0) >= maxRetries && !force) {
        return null;
      }
      // Already pending or awaiting a retry => nothing to do.
      if (existing.state === URL_STATE.QUEUED || existing.state === URL_STATE.IN_PROGRESS) return null;
      if (existing.state === URL_STATE.DEFERRED && !force) return null;
    }

    const record = makeFrontierRecord(url, URL_STATE.QUEUED, depth, parent, seed);
    this.state.set(canonical, record);
    await this.persist();
    return canonical;
  }

  // Claim next URL: mark in-progress, return the record, advance state
  async claimNext({ maxRetries = 2 } = {}) {
    if (!this.initialized) await this.init();
    // Find first queued URL
    for (const [canonical, record] of this.state.entries()) {
      if (record.state === URL_STATE.QUEUED) {
        // Mark in-progress
        record.state = URL_STATE.IN_PROGRESS;
        record.claimedAt = new Date().toISOString();
        await this.persist();
        return { canonical, record };
      }
    }
    // Find first deferred with retries remaining
    for (const [canonical, record] of this.state.entries()) {
      if (
        record.state === URL_STATE.DEFERRED &&
        (record.retries ?? 0) < maxRetries
      ) {
        record.state = URL_STATE.IN_PROGRESS;
        record.claimedAt = new Date().toISOString();
        await this.persist();
        return { canonical, record };
      }
    }
    return null; // nothing available
  }

  // Mark URL as visited (completed fetch)
  async markVisited(canonical, { contentHash = null, fetchOutcome = "ok" } = {}) {
    const record = this.state.get(canonical);
    if (!record) return false;
    record.state = URL_STATE.VISITED;
    record.completedAt = new Date().toISOString();
    if (contentHash) record.contentHash = contentHash;
    record.retries = 0; // reset on successful visit
    record.lastError = null;
    await this.persist();
    return true;
  }

  // Mark URL as failed with reason
  async markFailed(canonical, { reason = null, error = null, incrementRetries = true, maxRetries = 2 } = {}) {
    const record = this.state.get(canonical);
    if (!record) return false;
    record.state = URL_STATE.FAILED;
    record.lastError = error ?? reason ?? "fetch_failed";
    record.lastErrorAt = new Date().toISOString();
    if (incrementRetries) {
      record.retries = (record.retries ?? 0) + 1;
      // If retries exhausted, automatically defer
      if (record.retries >= maxRetries) {
        record.state = URL_STATE.DEFERRED;
      }
    }
    await this.persist();
    return true;
  }

  // Stale claim recovery: any in-progress older than timeout → deferred
  async recoverStaleClaims({ claimTimeoutMs = 30000 } = {}) {
    if (!this.initialized) await this.init();
    const now = Date.now();
    let changed = false;
    for (const [, record] of this.state.entries()) {
      if (record.state === URL_STATE.IN_PROGRESS && record.claimedAt) {
        const claimedAt = new Date(record.claimedAt).getTime();
        if (now - claimedAt > claimTimeoutMs) {
          record.state = URL_STATE.DEFERRED;
          record.lastError = "stale_claim_recovered";
          record.lastErrorAt = new Date().toISOString();
          changed = true;
        }
      }
    }
    if (changed) await this.persist();
  }

  // Persist frontier to NDJSON (atomic write via temp + rename, Windows-compatible)
  async persist() {
    if (!this.initialized) await this.init();
    const file = path.join(this.dir, FRONTIER_FILE);
    const lines = [];
    for (const record of this.state.values()) {
      // Omit null/undefined values for clean NDJSON; keep essential fields only
      const clean = {
        url: record.url,
        state: record.state,
        depth: record.depth,
        parent: record.parent,
        seed: record.seed,
        retries: record.retries,
        lastError: record.lastError,
        lastErrorAt: record.lastErrorAt,
        claimedAt: record.claimedAt,
        completedAt: record.completedAt,
        discoveryProvenance: record.discoveryProvenance,
        contentHash: record.contentHash,
      };
      lines.push(JSON.stringify(clean));
    }
    // Write atomically: temp file then rename (Windows-compatible)
    const tmpFile = file + ".tmp";
    await mkdir(this.dir, { recursive: true });
    await writeFile(tmpFile, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
    // Windows rename fails with EPERM if destination exists and is locked.
    // Use a retry loop with fallback: try rename, then copy+unlink on EPERM/ENOENT.
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await rename(tmpFile, file);
        return;
      } catch (err) {
        if (attempt === maxAttempts) throw err;
        // On Windows, EPERM/ENOENT can occur if destination is locked.
        // Fall back to copy + unlink (still atomic from reader perspective).
        if (err.code === "EPERM" || err.code === "ENOENT") {
          try {
            await copyFile(tmpFile, file);
            await unlink(tmpFile);
            return;
          } catch (copyErr) {
            if (attempt === maxAttempts) throw copyErr;
            // Wait briefly before retry
            await new Promise((r) => setTimeout(r, 50 * attempt));
          }
        } else {
          if (attempt === maxAttempts) throw err;
          await new Promise((r) => setTimeout(r, 50 * attempt));
        }
      }
    }
  }

  // State summary for diagnostics
  summary() {
    const counts = {
      queued: 0,
      inProgress: 0,
      visited: 0,
      deferred: 0,
      failed: 0,
    };
    const retryDist = { 0: 0, 1: 0, 2: 0, 3: 0 };
    for (const record of this.state.values()) {
      switch (record.state) {
        case URL_STATE.QUEUED: counts.queued++; break;
        case URL_STATE.IN_PROGRESS: counts.inProgress++; break;
        case URL_STATE.VISITED: counts.visited++; break;
        case URL_STATE.DEFERRED: counts.deferred++; break;
        case URL_STATE.FAILED: counts.failed++; break;
        default: break;
      }
      const r = record.retries ?? 0;
      if (r in retryDist) retryDist[r]++;
    }
    return {
      ...counts,
      total: this.state.size,
      // Distribution of retry counts for failed/deferred
      retryDist,
    };
  }

  // Clear all persisted frontier data
  async clear() {
    await mkdir(this.dir, { recursive: true });
    const filePath = path.join(this.dir, FRONTIER_FILE);
    try {
      await unlink(filePath);
    } catch {
      // file doesn't exist, that's fine
    }
    this.state.clear();
  }
}

// Export a convenience: seed the frontier from CRAWL_URLS config
export async function seedFrontierFromConfig(frontier, config) {
  const urls = config.crawlUrls ?? [];
  if (!urls.length) return;
  for (const url of urls) {
    const canonical = await frontier.enqueue(url, { depth: 0, seed: url });
    if (canonical) {
      // Mark as queued from seed
      const record = frontier.state.get(canonical);
      if (record) {
        record.seed = url;
      }
    }
  }
}

// Export canonicalization utility
export { canonicalURL };