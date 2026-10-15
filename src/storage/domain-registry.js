import { mkdir, writeFile, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

const DOMAIN_REGISTRY_DIR = "data/domain-registry";
const DOMAIN_REGISTRY_FILE = "domains.ndjson";

/**
 * One registry per resolved directory.
 *
 * Three call sites used to build their own registry over the same file (the
 * server process, the DiscoveryService, and the crawler's `harvest`). Three
 * in-memory Maps each rewriting the same file produced a genuine race: one
 * instance's cleanup unlinked another instance's temp file, so the next rename
 * failed with ENOENT, and every write was last-writer-wins over a partial
 * view. Sharing a single instance gives one authority for the data AND removes
 * the concurrent writers entirely.
 */
const REGISTRY_INSTANCES = new Map();

const DOMAIN_POLICY = Object.freeze({
  NORMAL: "normal",
  IMPORTANT: "important",
  BLOCKED: "blocked",
});

const DOMAIN_ORIGIN = Object.freeze({
  AUTO: "auto",
  MANUAL: "manual",
});

/**
 * Canonical domain identity for a hostname OR an http(s) URL.
 *
 * Rules (spec §2):
 *   - normalise case, strip port, path, query and fragment;
 *   - reject IP literals and anything that is not a valid dotted hostname, so a
 *     URL-encoded path segment or a stray string can never become a "domain";
 *   - IDN is handled by WHATWG URL, which lower-cases and PunyConverts, so an
 *     internationalised domain and its A-label form settle on one identity.
 *
 * Returns null for anything that is not a usable hostname: the caller must treat
 * that as "not a domain", never as an empty-string domain.
 */
function canonicalDomain(hostOrUrl) {
  if (typeof hostOrUrl !== "string") return null;
  const raw = hostOrUrl.trim();
  if (!raw) return null;

  let host;
  if (raw.includes("://")) {
    try {
      const u = new URL(raw);
      // Only web pages are crawlable sources; reject file:, data:, mailto: …
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      host = u.hostname;
    } catch {
      return null;
    }
  } else {
    // A bare input is a hostname, not a URL: reject userinfo, paths and queries
    // so "example.com/a?b=c" cannot become the domain "example.com/a".
    if (/[/?#@\s]/.test(raw)) return null;
    host = raw;
  }

  // A trailing dot in a valid FQDN is legal and normalises away.
  let normalizedHost = host.toLowerCase().replace(/\.$/, "");
  if (!normalizedHost) return null;

  // IPv4 / IPv6 literals are addresses, not domains. URL gives IPv6 already
  // bracketed; a bare input may arrive as "127.0.0.1" or "::1".
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(normalizedHost)) return null;
  if (/^\[[0-9a-f:.]+\]$/.test(normalizedHost)) return null;
  if (normalizedHost.includes(":")) return null;

  // A hostname is a series of dot-separated labels; each label is alphanumeric
  // or a hyphen, must not start or end with a hyphen, and is ≤63 characters.
  const labels = normalizedHost.split(".");
  if (labels.length < 2) return null;
  for (const label of labels) {
    if (!label || label.length > 63) return null;
    if (!/^[a-z0-9-]+$/.test(label)) return null;
    if (label.startsWith("-") || label.endsWith("-")) return null;
  }
  return normalizedHost;
}

/**
 * True when `host` IS `domain` or one of its subdomains, matched on DNS label
 * boundaries:
 *   wikipedia.org      matches en.wikipedia.org
 *   wikipedia.org      does NOT match notwikipedia.org
 * Case-insensitive; a leading dot is normalised away.
 */
function matchesDomain(host, domain) {
  if (typeof host !== "string" || typeof domain !== "string") return false;
  const h = host.trim().toLowerCase().replace(/^\./, "").replace(/\.$/, "");
  const d = domain.trim().toLowerCase().replace(/^\./, "").replace(/\.$/, "");
  if (!h || !d) return false;
  if (h === d) return true;
  // The leading "." is the label boundary. Without it "notwikipedia.org" would
  // match "wikipedia.org" purely on character suffix.
  return h.endsWith("." + d);
}

/**
 * Get the registry for a directory.
 *
 * By default this returns the SHARED instance for the resolved path, so the
 * server process, the DiscoveryService and the crawler all read and write one
 * authority instead of three racing ones. Pass `{ forceNew: true }` (tests do
 * this) to get an isolated instance that is not registered globally.
 */
export function createDomainRegistry(opts = {}) {
  const dir = opts.dir ?? DOMAIN_REGISTRY_DIR;
  const absDir = path.resolve(dir);
  const readOnly = !!opts.readOnly;

  if (readOnly || opts.forceNew === true) {
    return buildDomainRegistry(absDir, readOnly);
  }
  const existing = REGISTRY_INSTANCES.get(absDir);
  if (existing) return existing;
  const created = buildDomainRegistry(absDir, readOnly);
  REGISTRY_INSTANCES.set(absDir, created);
  return created;
}

function buildDomainRegistry(dir, readOnly) {
  const domains = new Map(); // domain -> record
  const events = []; // audit trail

  async function init() {
    // Resolve once so every later operation uses the same absolute path.
    const absDir = path.resolve(dir);
    const registryFile = path.join(absDir, DOMAIN_REGISTRY_FILE);
    await mkdir(absDir, { recursive: true });
    let raw;
    try {
      raw = await readFile(registryFile, "utf8");
    } catch {
      return; // no file yet — first run
    }
    const lines = raw.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (record.domain) {
          domains.set(record.domain, record);
        }
      } catch {
        // skip malformed lines (resilient read)
      }
    }
  }

  function get(domain) {
    return domains.get(domain) ?? null;
  }

  function has(domain) {
    return domains.has(domain);
  }

  function list() {
    return [...domains.values()];
  }

  function listByPolicy(policy) {
    return [...domains.values()].filter((d) => d.policy === policy);
  }

  /**
   * Write the registry to disk.
   *
   * Two properties are load-bearing, and both were missing before:
   *
   * 1. SERIALISATION. Exactly one write may be in flight. Two writers renaming
   *    onto the same target is what produced the EPERM/ENOENT storm: the loser
   *    in a rename race gets EPERM (Windows refuses to overwrite a locked
   *    destination) and the cleanup of one attempt deletes the temp file the
   *    next attempt is about to rename (ENOENT). Chaining every write onto a
   *    single tail promise makes them strictly ordered, and coalescing means a
   *    burst of `recordDiscovery` calls causes ONE file write, not fifty.
   *
   * 2. CRASH SAFETY. The file must never be left half-written, because a torn
   *    line at the tail silently loses domains on reload. A complete temp file
   *    is written first and only then swapped in, so a reader ever sees either
   *    the previous full state or the new full state.
   *
   * The registry is observability state: losing a domain row is better than
   * failing a whole acquisition cycle, so a persistent failure is logged and
   * never thrown.
   */
  let writeTail = Promise.resolve();
  let pendingFlush = null;

  function flush() {
    if (pendingFlush) return pendingFlush;
    const run = writeTail.then(async () => {
      // Snapshot INSIDE the serialised section, after every earlier write has
      // landed, so awaiting this promise guarantees the CURRENT state is durable.
      pendingFlush = null;
      const absDir = path.resolve(dir);
      const filePath = path.join(absDir, DOMAIN_REGISTRY_FILE);
      const tmpPath = `${filePath}.tmp`;

      const lines = [];
      for (const record of domains.values()) {
        lines.push(JSON.stringify(record));
      }
      const content = lines.join("\n") + (lines.length ? "\n" : "");

      let lastErr = null;
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          // Re-ensure the directory: an operator cleanup between cycles must not
          // turn into an ENOENT that takes a whole crawl cycle down.
          await mkdir(absDir, { recursive: true });
          // Write the FULL body every attempt — a swept temp file is fixed by
          // re-creating it, not by retrying a rename of something absent.
          await writeFile(tmpPath, content, "utf8");
          await rename(tmpPath, filePath);
          return;
        } catch (err) {
          lastErr = err;
          try { await unlink(tmpPath); } catch { /* already gone */ }
          if (attempt === 5) break;
          await new Promise((r) => setTimeout(r, 40 * attempt + Math.random() * 40));
        }
      }
      console.error(
        `[domain-registry] persist failed: ${lastErr?.code ?? lastErr?.message ?? lastErr} (${filePath})`,
      );
    });
    writeTail = run.catch(() => {});
    pendingFlush = run;
    return run;
  }

  const persist = () => flush();

  async function appendEvent(event) {
    const full = { at: new Date().toISOString(), ...event };
    events.push(full);
    // Audit trail is append-only and never rewritten, so it can be appended in
    // place. The directory is ensured first: a cleaned data/frontier must not
    // turn an otherwise successful policy change into a thrown error.
    await mkdir(path.resolve(dir), { recursive: true });
    await writeFile(path.join(path.resolve(dir), "domain-events.ndjson"), JSON.stringify(full) + "\n", { flag: "a" });
  }

  function ensureRecord(domain, updates = {}) {
    let record = domains.get(domain);
    if (!record) {
      record = {
        domain,
        displayHost: domain,
        firstDiscoveredAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        discoverySource: null,
        policy: DOMAIN_POLICY.NORMAL,
        origin: DOMAIN_ORIGIN.AUTO,
        urlsDiscovered: 0,
        documentsFetched: 0,
        lastSuccessfulFetch: null,
        lastFailureAt: null,
        failureCount: 0,
        policyChangedAt: null,
        policyReason: null,
        ...updates,
      };
      domains.set(domain, record);
    } else {
      Object.assign(record, updates, { lastSeenAt: new Date().toISOString() });
    }
    return record;
  }

  async function registerDomain(domain, { source = null, origin = DOMAIN_ORIGIN.AUTO } = {}) {
    const canonical = canonicalDomain(domain);
    if (!canonical) return { ok: false, reason: "bad-domain" };
    const existing = domains.get(canonical);
    const record = ensureRecord(canonical, {
      // Preserve the ORIGINAL provenance of a known domain: re-discovery must
      // never rewrite where it was first found.
      discoverySource: source ?? existing?.discoverySource ?? null,
      origin: existing?.origin ?? origin ?? DOMAIN_ORIGIN.AUTO,
    });
    await persist();
    await appendEvent({ type: "domain-registered", domain: canonical, source, origin });
    return { ok: true, domain: canonical, record };
  }

  /**
   * Apply an operator policy change.
   *
   * A BLOCK is terminal for this operation set: only `unblockDomain` (which
   * passes `internal`) may move a domain out of `blocked`. This is the safety
   * rule that stops an importance preference (or a stale UI click) from quietly
   * re-enabling a domain the operator blocked.
   */
  async function setPolicy(domain, policy, { reason = null, internal = false } = {}) {
    const canonical = canonicalDomain(domain);
    if (!canonical) return { ok: false, reason: "bad-domain" };
    if (!Object.values(DOMAIN_POLICY).includes(policy)) {
      return { ok: false, reason: "invalid-policy" };
    }
    const record = domains.get(canonical);
    if (!record) return { ok: false, reason: "not-found" };
    if (!internal && record.policy === DOMAIN_POLICY.BLOCKED && policy !== DOMAIN_POLICY.BLOCKED) {
      return { ok: false, reason: "blocked-domain", policy };
    }
    record.policy = policy;
    record.policyChangedAt = new Date().toISOString();
    record.policyReason = reason;
    await persist();
    await appendEvent({ type: "domain-policy-changed", domain: canonical, policy, reason });
    return { ok: true, domain: canonical, policy };
  }

  async function blockDomain(domain, { reason = null } = {}) {
    return setPolicy(domain, DOMAIN_POLICY.BLOCKED, { reason });
  }

  /** The ONLY way out of `blocked`. */
  async function unblockDomain(domain) {
    return setPolicy(domain, DOMAIN_POLICY.NORMAL, { reason: "unblocked by operator", internal: true });
  }

  async function setImportant(domain, important) {
    return setPolicy(domain, important ? DOMAIN_POLICY.IMPORTANT : DOMAIN_POLICY.NORMAL, { reason: important ? "marked important by operator" : "importance removed by operator" });
  }

  async function removeDomain(domain) {
    const canonical = canonicalDomain(domain);
    if (!canonical) return { ok: false, reason: "bad-domain" };
    if (!domains.has(canonical)) return { ok: false, reason: "not-found" };
    domains.delete(canonical);
    await persist();
    await appendEvent({ type: "domain-removed", domain: canonical });
    return { ok: true, domain: canonical };
  }

  async function recordDiscovery(domain, { url = null, parentUrl = null, depth = 0, trust = null } = {}) {
    const canonical = canonicalDomain(domain);
    if (!canonical) return;
    const existingRecord = domains.get(canonical);
    const record = ensureRecord(canonical, { discoverySource: existingRecord?.discoverySource ?? "crawler" });
    record.urlsDiscovered = (record.urlsDiscovered ?? 0) + 1;
    record.lastSeenAt = new Date().toISOString();
    if (url) {
      record.lastDiscoveredUrl = url;
      record.lastDiscoveredAt = new Date().toISOString();
    }
    if (parentUrl && !record.firstDiscoveredVia) {
      record.firstDiscoveredVia = { parentUrl, depth, trust };
    }
    await persist();
  }

  async function recordFetchSuccess(domain, { url = null, contentHash = null } = {}) {
    const canonical = canonicalDomain(domain);
    if (!canonical) return;
    const record = domains.get(canonical);
    if (!record) return;
    record.documentsFetched = (record.documentsFetched ?? 0) + 1;
    record.lastSuccessfulFetch = new Date().toISOString();
    if (url) record.lastFetchedUrl = url;
    if (contentHash) record.lastContentHash = contentHash;
    await persist();
  }

  async function recordFetchFailure(domain, { url = null, error = null } = {}) {
    const canonical = canonicalDomain(domain);
    if (!canonical) return;
    const record = domains.get(canonical);
    if (!record) return;
    record.failureCount = (record.failureCount ?? 0) + 1;
    record.lastFailureAt = new Date().toISOString();
    if (url) record.lastFailedUrl = url;
    if (error) record.lastError = String(error);
    await persist();
  }

  function getStats() {
    let total = domains.size;
    let normal = 0, important = 0, blocked = 0, auto = 0, manual = 0;
    for (const d of domains.values()) {
      switch (d.policy) {
        case DOMAIN_POLICY.NORMAL: normal++; break;
        case DOMAIN_POLICY.IMPORTANT: important++; break;
        case DOMAIN_POLICY.BLOCKED: blocked++; break;
      }
      if (d.origin === DOMAIN_ORIGIN.AUTO) auto++;
      else manual++;
    }
    return {
      total,
      byPolicy: { normal, important, blocked },
      byOrigin: { auto, manual },
    };
  }

  return {
    init,
    get,
    has,
    list,
    listByPolicy,
    registerDomain,
    setPolicy,
    blockDomain,
    unblockDomain,
    setImportant,
    removeDomain,
    recordDiscovery,
    recordFetchSuccess,
    recordFetchFailure,
    getStats,
    DOMAIN_POLICY,
    DOMAIN_ORIGIN,
  };
}

export { canonicalDomain, matchesDomain, DOMAIN_POLICY, DOMAIN_ORIGIN };