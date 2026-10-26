import { appendFile, mkdir, writeFile, readFile, rename, unlink, copyFile } from "node:fs/promises";
import path from "node:path";
import { contentHashFor } from "./harness/fetcher.js";

const FRONTIER_DIR = "data/frontier";
export const FRONTIER_FILE = "frontier.ndjson";

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
  REJECTED: "rejected",
  QUARANTINED: "quarantined",
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
    contentHash: metadata.contentHash ?? null, // populated after fetch; separate from URL dedup
    // Conditional-HTTP validators captured on the last successful fetch.
    etag: metadata.etag ?? null,
    lastModified: metadata.lastModified ?? null,
    // Scheduling metadata (resilient acquisition):
    lastFetchedAt: metadata.lastFetchedAt ?? null,
    nextCrawlAt: metadata.nextCrawlAt ?? null, // rediscovery TTL deadline (VISITED)
    nextAttemptAt: metadata.nextAttemptAt ?? null, // independent retry backoff (DEFERRED)
    rediscoveries: metadata.rediscoveries ?? 0,
    rediscovery: metadata.rediscovery ?? false, // true when the current claim is a re-visit
    // Admission lifecycle: one request identity per acquisition generation.
    generation: metadata.generation ?? 0,
    requestId: metadata.requestId ?? null,
    payloadDigest: metadata.payloadDigest ?? null,
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
              if (!Number.isSafeInteger(record.generation) || record.generation < 0) record.generation = 0;
              if (record.requestId == null) record.requestId = null;
              if (record.payloadDigest == null) record.payloadDigest = null;
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
  async enqueue(url, { depth = 0, parent = null, seed = null, force = false, maxRetries = 2, discoveryProvenance = null } = {}) {
    if (!this.initialized) await this.init();
    const canonical = canonicalURL(url);
    if (!canonical) return null;

    const existing = this.state.get(canonical);
    if (existing) {
      // Gateway-rejected and quarantined work is terminal. Neither force nor a
      // subsequent discovery may silently revive it in the same frontier.
      if (existing.state === URL_STATE.REJECTED || existing.state === URL_STATE.QUARANTINED) return null;
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

    const record = makeFrontierRecord(url, URL_STATE.QUEUED, depth, parent, seed, {
      discoveryProvenance,
      // Preserve validators/hash across an explicit forced re-enqueue so the
      // refetch can still be conditional (and return 304 when unchanged).
      etag: existing?.etag ?? null,
      lastModified: existing?.lastModified ?? null,
      lastFetchedAt: existing?.lastFetchedAt ?? null,
      contentHash: existing?.contentHash ?? null,
      generation: existing?.generation ?? 0,
      requestId: existing?.requestId ?? null,
      payloadDigest: existing?.payloadDigest ?? null,
    });
    this.state.set(canonical, record);
    await this.persist();
    return canonical;
  }

  /** True when the URL is already tracked in the frontier (any state). */
  has(url) {
    const canonical = canonicalURL(url);
    return canonical ? this.state.has(canonical) : false;
  }

  // Claim next URL: mark in-progress, return the record, advance state.
  //
  // Ordering matters for resilience: brand-new QUEUED work is always claimed
  // BEFORE due retries, which are claimed BEFORE due rediscoveries. Revisiting a
  // VISITED URL (rediscovery TTL) can therefore never starve newly discovered
  // URLs. A retry is only claimable once its independent `nextAttemptAt` has
  // elapsed; a rediscovery only once `nextCrawlAt` has elapsed.
  async claimNext({ maxRetries = 2, now = Date.now(), rediscoveryEnabled = false } = {}) {
    if (!this.initialized) await this.init();

    const claim = async (canonical, record, rediscovery) => {
      record.state = URL_STATE.IN_PROGRESS;
      record.claimedAt = new Date(now).toISOString();
      record.rediscovery = rediscovery;
      await this.persist();
      return { canonical, record, rediscovery };
    };

    // 1) Brand-new work.
    for (const [canonical, record] of this.state.entries()) {
      if (record.state === URL_STATE.QUEUED) return claim(canonical, record, false);
    }
    // 2) Due retries with retries remaining.
    for (const [canonical, record] of this.state.entries()) {
      if (record.state === URL_STATE.DEFERRED && (record.retries ?? 0) < maxRetries) {
        const due = record.nextAttemptAt ? new Date(record.nextAttemptAt).getTime() <= now : true;
        if (due) return claim(canonical, record, false);
      }
    }
    // 3) Due rediscoveries (TTL elapsed) — only after new work.
    if (rediscoveryEnabled) {
      for (const [canonical, record] of this.state.entries()) {
        if (record.state === URL_STATE.VISITED && record.nextCrawlAt) {
          if (new Date(record.nextCrawlAt).getTime() <= now) return claim(canonical, record, true);
        }
      }
    }
    return null; // nothing available
  }

  /**
   * Persist the admission identity on the in-progress frontier record. The
   * identity is deterministic for the generation, but persisting it makes crash
   * recovery auditable and prevents a later code/config drift from silently
   * changing the request under the same generation.
   */
  async recordAdmission(canonical, { requestId, payloadDigest } = {}) {
    const record = this.state.get(canonical);
    if (!record) return false;
    if (typeof requestId === "string") record.requestId = requestId;
    if (typeof payloadDigest === "string") record.payloadDigest = payloadDigest;
    await this.persist();
    return true;
  }

  // Mark URL as gateway-rejected. This is terminal and cannot be re-enqueued.
  async markRejected(canonical, { reason = null, requestId = undefined, payloadDigest = undefined } = {}) {
    return this.#markTerminal(canonical, URL_STATE.REJECTED, { reason, requestId, payloadDigest });
  }

  // Mark URL as quarantined by a contradictory/protocol-violating admission.
  async markQuarantined(canonical, { reason = null, requestId = undefined, payloadDigest = undefined } = {}) {
    return this.#markTerminal(canonical, URL_STATE.QUARANTINED, { reason, requestId, payloadDigest });
  }

  /**
   * A cap rejection is not a terminal frontier decision. The request was
   * refused only because the current sealed epoch is full; the URL remains
   * valid work for the next epoch. Preserve the rejection in an audit trail and
   * return the URL to QUEUED without incrementing fetch retries.
   */
  async deferCapRejected(canonical, { epoch = null, reason = "cap", at = null } = {}) {
    const record = this.state.get(canonical);
    if (!record) return false;
    const now = at ?? new Date().toISOString();
    const entry = {
      type: "cap-deferred",
      at: now,
      epoch,
      reason,
      previousState: record.state,
      previousLastError: record.lastError ?? null,
      previousLastErrorAt: record.lastErrorAt ?? null,
      previousCompletedAt: record.completedAt ?? null,
      previousRequestId: record.requestId ?? null,
      previousPayloadDigest: record.payloadDigest ?? null,
      previousGeneration: record.generation ?? 0,
    };
    record.capDeferrals = Array.isArray(record.capDeferrals) ? record.capDeferrals : [];
    record.capDeferrals.push(entry);
    record.state = URL_STATE.QUEUED;
    record.claimedAt = null;
    record.completedAt = null;
    record.nextCrawlAt = null;
    record.nextAttemptAt = null;
    record.rediscovery = false;
    record.lastError = "cap-deferred";
    record.lastErrorAt = now;
    // A new epoch derives a new request identity from the URL + generation.
    record.requestId = null;
    record.payloadDigest = null;
    await this.persist();
    return true;
  }

  /**
   * A rolling-quota/rate/domain/storage deferral is transient. Keep the URL
   * claimable and retain a tiny bounded summary per URL instead of an unbounded
   * array. The request decision is not written by the rolling store, so the same
   * request identity can be retried when capacity returns.
   */
  async deferAdmission(canonical, {
    reason = "quota",
    policyVersion = null,
    retryAfterMs = null,
    quotaUsed = null,
    quotaLimit = null,
    at = null,
  } = {}) {
    const record = this.state.get(canonical);
    if (!record) return false;
    const now = at ?? new Date().toISOString();
    const prior = record.admissionDeferral ?? null;
    record.admissionDeferral = {
      reason,
      policyVersion,
      retryAfterMs,
      quotaUsed,
      quotaLimit,
      at: prior?.at ?? now,
      lastAt: now,
      count: (prior?.count ?? 0) + 1,
      nextAttemptAt: retryAfterMs != null
        ? new Date(new Date(now).getTime() + retryAfterMs).toISOString()
        : null,
    };
    record.state = URL_STATE.QUEUED;
    record.claimedAt = null;
    record.completedAt = null;
    record.nextCrawlAt = null;
    record.nextAttemptAt = null;
    record.rediscovery = false;
    record.lastError = "admission-deferred";
    record.lastErrorAt = now;
    record.requestId = null;
    record.payloadDigest = null;
    await this.persist();
    return true;
  }

  /**
   * Recover URLs terminally rejected solely because an admission epoch's cap was
   * exhausted. Never touches quarantined entries or rejections for any other
   * reason. The previous audit fields are retained on the record and in the
   * recovery ledger; the durable rewrite is a single Frontier.persist().
   */
  async recoverCapRejected({ epoch = null, reason = "admission-cap-exhausted", now = Date.now(), dryRun = false, auditFile = "cap-recovery.ndjson", includeUrls = false } = {}) {
    if (!this.initialized) await this.init();
    const at = new Date(now).toISOString();
    const candidates = [];
    for (const [canonical, record] of this.state.entries()) {
      if (record.state !== URL_STATE.REJECTED || record.lastError !== "cap") continue;
      candidates.push({
        canonical,
        url: record.url,
        previousState: record.state,
        previousLastError: record.lastError,
        previousLastErrorAt: record.lastErrorAt ?? null,
        previousCompletedAt: record.completedAt ?? null,
        previousRequestId: record.requestId ?? null,
        previousPayloadDigest: record.payloadDigest ?? null,
        previousGeneration: record.generation ?? 0,
        previousRetries: record.retries ?? 0,
      });
    }
    const urls = candidates.map((c) => c.url);
    const urlSample = urls.slice(0, 10);
    if (dryRun || candidates.length === 0) {
      return { recovered: candidates.length, dryRun, at, epoch, urlSample, ...(includeUrls ? { urls } : {}) };
    }

    const batch = {
      type: "cap-recovery",
      at,
      epoch,
      reason,
      count: candidates.length,
      urls: candidates.map((c) => ({ url: c.url, previousCompletedAt: c.previousCompletedAt, previousRequestId: c.previousRequestId })),
    };
    await this.#appendRecoveryLedger(auditFile, batch);

    for (const candidate of candidates) {
      const record = this.state.get(candidate.canonical);
      if (!record) continue;
      record.recoveryHistory = Array.isArray(record.recoveryHistory) ? record.recoveryHistory : [];
      record.recoveryHistory.push({
        type: "cap-rejected-recovery",
        at,
        epoch,
        reason,
        previousState: candidate.previousState,
        previousLastError: candidate.previousLastError,
        previousLastErrorAt: candidate.previousLastErrorAt,
        previousCompletedAt: candidate.previousCompletedAt,
        previousRequestId: candidate.previousRequestId,
        previousPayloadDigest: candidate.previousPayloadDigest,
        previousGeneration: candidate.previousGeneration,
        previousRetries: candidate.previousRetries,
      });
      record.state = URL_STATE.QUEUED;
      record.claimedAt = null;
      record.completedAt = null;
      record.nextCrawlAt = null;
      record.nextAttemptAt = null;
      record.rediscovery = false;
      record.lastError = null;
      record.lastErrorAt = null;
      record.retries = 0;
      // The new epoch derives a fresh request identity. The old identity is
      // preserved in recoveryHistory.
      record.requestId = null;
      record.payloadDigest = null;
    }
    await this.persist();
    return {
      recovered: candidates.length,
      dryRun: false,
      at,
      epoch,
      urlSample,
      auditFile,
      ...(includeUrls ? { urls } : {}),
    };
  }

  async #appendRecoveryLedger(auditFile, record) {
    const file = path.join(this.dir, auditFile);
    await mkdir(this.dir, { recursive: true });
    await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
  }

  /** Count URLs currently terminal for the admission cap (diagnostics only). */
  capRejectedCount() {
    let count = 0;
    for (const record of this.state.values()) {
      if (record.state === URL_STATE.REJECTED && record.lastError === "cap") count += 1;
    }
    return count;
  }

  async #markTerminal(canonical, state, { reason = null, requestId = undefined, payloadDigest = undefined } = {}) {
    const record = this.state.get(canonical);
    if (!record) return false;
    const now = new Date().toISOString();
    record.state = state;
    record.completedAt = now;
    record.claimedAt = null;
    record.nextCrawlAt = null;
    record.nextAttemptAt = null;
    record.rediscovery = false;
    record.lastError = reason ?? state;
    record.lastErrorAt = now;
    if (typeof requestId === "string") record.requestId = requestId;
    if (typeof payloadDigest === "string") record.payloadDigest = payloadDigest;
    await this.persist();
    return true;
  }

  // Mark URL as visited (completed fetch). `nextCrawlAt` schedules the next
  // rediscovery; `etag`/`lastModified` are the validators for a conditional
  // refetch. A 304 (notModified) keeps the existing contentHash.
  async markVisited(canonical, {
    contentHash = null,
    etag = undefined,
    lastModified = undefined,
    nextCrawlAt = undefined,
    // Accepted for call-site clarity; the visit is fully described by
    // lastFetchedAt + validators + nextCrawlAt.
    notModified = false,
    rediscovery = false,
    fetchOutcome = "ok",
    advanceGeneration = false,
  } = {}) {
    const record = this.state.get(canonical);
    if (!record) return false;
    if (record.state === URL_STATE.REJECTED || record.state === URL_STATE.QUARANTINED) return false;
    const now = new Date().toISOString();
    record.state = URL_STATE.VISITED;
    record.completedAt = now;
    record.lastFetchedAt = now;
    if (contentHash) record.contentHash = contentHash;
    if (etag !== undefined) record.etag = etag;
    if (lastModified !== undefined) record.lastModified = lastModified;
    if (nextCrawlAt !== undefined) record.nextCrawlAt = nextCrawlAt;
    if (rediscovery) record.rediscoveries = (record.rediscoveries ?? 0) + 1;
    record.retries = 0; // reset on successful visit
    record.lastError = null;
    record.nextAttemptAt = null;
    record.claimedAt = null;
    record.rediscovery = false;
    if (advanceGeneration) {
      record.generation = (record.generation ?? 0) + 1;
      record.requestId = null;
      record.payloadDigest = null;
    }
    await this.persist();
    return true;
  }

  // Mark URL as failed with reason. A retryable failure schedules an independent
  // exponential backoff (`nextAttemptAt`) so a failed URL never blocks other
  // work; once retries are exhausted the URL is terminal FAILED.
  async markFailed(canonical, {
    reason = null,
    error = null,
    incrementRetries = true,
    maxRetries = 2,
    backoffBaseMs = null,
    backoffMaxMs = null,
    now = Date.now(),
  } = {}) {
    const record = this.state.get(canonical);
    if (!record) return false;
    if (record.state === URL_STATE.REJECTED || record.state === URL_STATE.QUARANTINED) return false;
    record.lastError = error ?? reason ?? "fetch_failed";
    record.lastErrorAt = new Date(now).toISOString();
    record.claimedAt = null;
    record.rediscovery = false;
    if (incrementRetries) {
      record.retries = (record.retries ?? 0) + 1;
      // Retries remaining => DEFERRED (claimable again once backoff elapses).
      // Only once retries are exhausted is the URL terminal FAILED. The previous
      // logic assigned FAILED on the FIRST failure, which `claimNext` never
      // returns — so a single transient fetch error (e.g. a DNS blip) would
      // strand the URL and the whole frontier would report "no sources".
      if (record.retries >= maxRetries) {
        record.state = URL_STATE.FAILED;
        record.nextAttemptAt = null;
      } else {
        record.state = URL_STATE.DEFERRED;
        if (Number.isFinite(backoffBaseMs) && backoffBaseMs > 0) {
          const cap = Number.isFinite(backoffMaxMs) && backoffMaxMs > 0 ? backoffMaxMs : backoffBaseMs;
          const delay = Math.min(backoffBaseMs * 2 ** (record.retries - 1), cap);
          record.nextAttemptAt = new Date(now + delay).toISOString();
        } else {
          record.nextAttemptAt = null;
        }
      }
    } else {
      record.state = URL_STATE.FAILED;
      record.nextAttemptAt = null;
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
        etag: record.etag ?? null,
        lastModified: record.lastModified ?? null,
        lastFetchedAt: record.lastFetchedAt ?? null,
        nextCrawlAt: record.nextCrawlAt ?? null,
        nextAttemptAt: record.nextAttemptAt ?? null,
        rediscoveries: record.rediscoveries ?? 0,
        rediscovery: record.rediscovery ?? false,
        generation: record.generation ?? 0,
        requestId: record.requestId ?? null,
        payloadDigest: record.payloadDigest ?? null,
        ...(Array.isArray(record.recoveryHistory) && record.recoveryHistory.length
          ? { recoveryHistory: record.recoveryHistory }
          : {}),
        ...(Array.isArray(record.capDeferrals) && record.capDeferrals.length
          ? { capDeferrals: record.capDeferrals }
          : {}),
        ...(record.admissionDeferral ? { admissionDeferral: record.admissionDeferral } : {}),
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
      rejected: 0,
      quarantined: 0,
    };
    const retryDist = { 0: 0, 1: 0, 2: 0, 3: 0 };
    const now = Date.now();
    let rediscoveryDue = 0;
    let deferredDue = 0;
    let nextDueAt = null;
    const considerDue = (iso) => {
      const t = iso ? new Date(iso).getTime() : NaN;
      if (!Number.isFinite(t)) return;
      if (nextDueAt == null || t < nextDueAt) nextDueAt = t;
    };
    for (const record of this.state.values()) {
      switch (record.state) {
        case URL_STATE.QUEUED: counts.queued++; break;
        case URL_STATE.IN_PROGRESS: counts.inProgress++; break;
        case URL_STATE.VISITED: counts.visited++; break;
        case URL_STATE.DEFERRED: counts.deferred++; break;
        case URL_STATE.FAILED: counts.failed++; break;
        case URL_STATE.REJECTED: counts.rejected++; break;
        case URL_STATE.QUARANTINED: counts.quarantined++; break;
        default: break;
      }
      const r = record.retries ?? 0;
      if (r in retryDist) retryDist[r]++;
      if (record.state === URL_STATE.VISITED && record.nextCrawlAt) {
        considerDue(record.nextCrawlAt);
        if (new Date(record.nextCrawlAt).getTime() <= now) rediscoveryDue++;
      } else if (record.state === URL_STATE.DEFERRED) {
        const due = record.nextAttemptAt ? new Date(record.nextAttemptAt).getTime() <= now : true;
        if (due) deferredDue++;
        if (record.nextAttemptAt) considerDue(record.nextAttemptAt);
      }
    }
    return {
      ...counts,
      total: this.state.size,
      // Distribution of retry counts for failed/deferred
      retryDist,
      // Rediscovery / retry scheduling diagnostics.
      deferredDue, // DEFERRED whose independent backoff has elapsed (claimable now)
      rediscoveryDue, // VISITED whose TTL has elapsed (claimable now)
      nextDueAt: nextDueAt == null ? null : new Date(nextDueAt).toISOString(),
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