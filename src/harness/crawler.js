import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "../config.js";
import { createDiscoveryPolicy } from "../discovery/discovery-policy.js";
import { fetchDocument, parseRobots, robotsAllows, assertUrlAllowed, contentHashFor } from "./fetcher.js";
import { canonicalDomain, createDomainRegistry } from "../storage/domain-registry.js";
import { assess } from "../domain/language.js";
import { classifyDiscoveryLanguage } from "../discovery/language-prior.js";
import { AdmissionStore, COMPLIANCE, DECISION } from "../gateway/admission-store.js";
import { AcquisitionGateway } from "../gateway/acquisition-gateway.js";
import { Frontier } from "../frontier.js";

const ADMISSION_PATH_DISABLED = "ADMISSION_PATH_DISABLED";

function admissionPathDisabled(name) {
  const err = new Error(
    `${name} is disabled while the admission gateway is enabled; use the frontier acquisition path`,
  );
  err.code = ADMISSION_PATH_DISABLED;
  return err;
}

/**
 * Real network acquisition must be admitted. An explicit `fetchImpl` is the
 * existing offline/mock seam used by tests and local fixtures; a caller that
 * leaves it undefined (meaning the global fetch) cannot perform real acquisition
 * without a valid gateway.
 */
function requireAdmissionOrMockTransport(name, { admissionGateway, fetchImpl }) {
  if (admissionGateway || fetchImpl !== undefined) return;
  const err = new Error(
    `${name} would perform real network acquisition without Baseline v1 admission. ` +
      "Provide an admissionGateway; an explicit fetchImpl is accepted only for offline/mocked acquisition.",
  );
  err.code = ADMISSION_PATH_DISABLED;
  throw err;
}

/**
 * Harvest — the ONLY entry point that produces raw docs.
 *
 * CRAWL_MODE=real fetches URLs from the persistent frontier, extracts links
 * from fetched HTML, enqueues eligible discoveries, and persists progress.
 * The frontier survives process restarts. Domains, depth, budget and robots
 * are enforced at enqueue + revalidate-before-fetch time.
 *
 * CRAWL_MODE=fixture emits the built-in sample docs for pipeline smoke tests.
 *
 * Every raw record is labelled with the capability that produced it, so the
 * ledger can never mistake a fixture for a fetched document.
 */

export const CAPABILITY = Object.freeze({
  real: "configured-fetch",
  fixture: "fixture",
});

/**
 * Apply the language filter to a fetched document.
 *
 * Returns "pass" (document should be kept) or "skip" (document should be
 * excluded). Updates the summary counters in place.
 *
 * This is the single shared enforcement point — harvest and ingestion both
 * call assess() from src/domain/language.js with identical rules.
 */
function applyLanguageFilter(doc, languageFilter, summary, url) {
  // Opt-in only: a disabled (or absent) filter is a strict no-op so existing
  // callers and tests keep their exact behaviour.
  if (!languageFilter?.enabled) return "pass";
  const decision = assess(doc.text, {
    minConfidence: languageFilter.minConfidence,
    htmlLang: doc.htmlLang ?? null,
    sourceUrl: url ?? doc.url ?? null,
  });
  // Shadow mode observes but never changes ingestion behaviour.
  const enforcing = !languageFilter.shadow;
  if (enforcing) {
    if (decision.verdict === "non-english") {
      summary.languageFiltered += 1;
      summary.skipped.push({
        url,
        reason: "non-english",
        language: decision.detection.language,
        script: decision.detection.script ?? null,
        confidence: decision.detection.confidence,
      });
      return "skip";
    }
    if (decision.verdict === "unknown" && languageFilter.unknownPolicy === "reject") {
      summary.languageFiltered += 1;
      summary.skipped.push({
        url,
        reason: "unknown-language",
        language: decision.detection.language,
        script: decision.detection.script ?? null,
        confidence: decision.detection.confidence,
      });
      return "skip";
    }
  }
  if (languageFilter.shadow && decision.verdict !== "english") {
    summary.shadowRejected.push({
      url,
      verdict: decision.verdict,
      language: decision.detection.language,
      confidence: decision.detection.confidence,
    });
  }
  return "pass";
}

const FIXTURE_DOCS = [
  `|| History of the steam engine ||
The steam engine was developed in Britain during the 18th century. Thomas
Newcomen built the first practical atmospheric engine in 1712. James Watt added
a separate condenser in 1769, dramatically improving fuel efficiency, which made
steam power economical for factories and, later, locomotives.`,
  `LIMITED TIME! Buy our miracle supplement now!!! 90% off!!! Click HERE for the
one weird trick doctors hate. 100% natural, guaranteed results in 24 hours,
no scientific basis whatsoever, just give us your credit card number.`,
  `|| Introduction to recursive algorithms ||
A recursive function solves a problem by calling itself on a strictly smaller
input, with a base case that terminates the recursion. The call stack holds one
frame per pending call, so depth is bounded by available stack space. Memoisation
caches subproblem results to turn exponential naive recursion into linear work.`,
];

/** Resolve and validate the requested mode. Fail-closed; never guesses. */
export function classifyCrawlMode({ mode, urls } = {}) {
  const m = String(mode ?? "").toLowerCase();
  const list = (urls ?? []).filter(Boolean);
  if (m === "fixture") return { mode: "fixture", capability: CAPABILITY.fixture, urls: [] };
  if (m === "real") {
    if (!list.length) {
      throw new Error(
        "CRAWL_MODE=real requires CRAWL_URLS (comma-separated configured source URLs); " +
          "refusing to silently fall back to fixtures. Set CRAWL_URLS or use CRAWL_MODE=fixture.",
      );
    }
    return { mode: "real", capability: CAPABILITY.real, urls: list };
  }
  throw new Error(`unknown CRAWL_MODE "${mode}" (expected "real" or "fixture")`);
}

function fixtureRecord(text, source = "harvest") {
  return {
    text,
    domain: "general",
    source,
    url: null,
    fetchedAt: new Date().toISOString(),
    contentHash: contentHashFor(text),
    crawlMode: "fixture",
    capability: CAPABILITY.fixture,
  };
}

async function loadRobots(url, { timeoutMs, allowPrivate, userAgent, fetchImpl }) {
  const origin = new URL(url).origin;
  try {
    const res = await fetchDocument(`${origin}/robots.txt`, { timeoutMs: Math.min(timeoutMs, 5000), allowPrivate, userAgent, fetchImpl });
    return parseRobots(res.text);
  } catch {
    return []; // missing/unreadable robots.txt => no restrictions
  }
}

/**
 * Extract all hrefs from HTML <a> tags as ABSOLUTE http(s) URLs.
 * Relative and protocol-relative hrefs are resolved against `baseUrl` (the
 * final URL after redirects). Fragments are dropped. Non-web schemes and
 * same-page anchors are ignored.
 */
export function extractLinksFromHTML(html, baseUrl = null) {
  const urls = new Set();
  const regex = /<a\s+[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim().replace(/&amp;/gi, "&");
    if (!raw || /^(javascript:|mailto:|tel:|data:|#)/i.test(raw)) continue;
    let resolved;
    try {
      resolved = baseUrl ? new URL(raw, baseUrl) : new URL(raw);
    } catch {
      continue;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
    resolved.hash = "";
    urls.add(resolved.href);
  }
  return urls;
}

/** Hostname of a URL, or null. */
function hostOfUrl(urlString) {
  try {
    return new URL(urlString).hostname;
  } catch {
    return null;
  }
}

/** Normalise a fetched document into the raw-doc shape the ledger expects. */
function normalizeRawDoc(doc, record = {}) {
  return {
    text: doc.text,
    domain: "general",
    source: hostOfUrl(doc.url) ?? "harvest",
    url: doc.url,
    // The declared <html lang> is part of the document's provenance: the
    // deterministic language backstop reads it, and the ledger must be able to
    // audit why a document was or was not admitted.
    htmlLang: doc.htmlLang ?? null,
    title: doc.title ?? null,
    extraction: doc.extraction ?? null,
    status: doc.status ?? null,
    contentType: doc.contentType ?? null,
    bytes: doc.bytes ?? null,
    fetchedAt: doc.fetchedAt ?? new Date().toISOString(),
    contentHash: doc.contentHash ?? null,
    crawlMode: "real",
    capability: CAPABILITY.real,
    discovery: {
      seed: record.seed ?? null,
      parent: record.parent ?? null,
      depth: record.depth ?? 0,
      provenance: record.discoveryProvenance ?? null,
    },
  };
}

/**
 * Run one acquisition cycle of the crawler.
 * - Fetches next URL from frontier (respecting depth, budget, domain, robots)
 * - Extracts links from HTML
 * - Enqueues eligible discoveries into frontier
 * - Returns cycle summary
 *
 * @param {object} ctx - Context: frontier, maxDepth, budget, etc.
 * @returns {object} Cycle summary
 */
export async function runCrawlCycle(ctx = {}) {
  const {
    frontier,
    domainRegistry,
    maxDepth = config.crawlMaxDepth,
    totalBudget = config.crawlTotalBudget,
    respectRobots = config.crawlRespectRobots,
    allowPrivate = config.crawlAllowPrivate,
    userAgent = config.crawlUserAgent,
    policy = null,
    maxLinksPerPage = config.crawlMaxLinksPerPage,
    languageFilter = null,
    discoveryLanguagePrior = null,
    rediscoveryEnabled = config.rediscoveryEnabled,
    rediscoveryTtlMs = config.rediscoveryTtlMs,
    admissionGateway = null,
    fetchImpl,
    accept,
    claimNow,
  } = ctx;

  if (!frontier.initialized) await frontier.init();

  const summary = {
    pagesFetched: 0,
    linksDiscovered: 0,
    urlsEnqueued: 0,
    budgetRemaining: totalBudget,
    depthReached: 0,
    robotsDisallowed: 0,
    domainFiltered: 0,
    languageFiltered: 0,
    languagePriorWarned: 0,
    languagePriorRejected: 0,
    notModified: 0,
    rediscoveries: 0,
    admissionRejected: 0,
    admissionQuarantined: 0,
    errors: 0,
    documents: [],
    failures: [],
    discovered: [],
    skipped: [],
    shadowRejected: [],
  };

  // Domain decision: an explicit discovery policy when supplied, else the legacy
  // allowlist behaviour (empty allow-list => no host restriction).
  function decideUrl(urlString) {
    if (policy?.decide) return policy.decide(urlString);
    if (config.crawlAllowedDomains.length === 0) return { allowed: true, reason: "no-policy", trust: null };
    try {
      const u = new URL(urlString);
      const ok = config.crawlAllowedDomains.some((d) => u.hostname === d || u.hostname.endsWith("." + d));
      return { allowed: ok, reason: ok ? "allowlisted" : "domain-filter", trust: null };
    } catch {
      return { allowed: false, reason: "bad-url", trust: null };
    }
  }

  // Helper: fetch a URL with full guard set, returning result or reason.
  // `conditional` carries the validators stored on the frontier record so a
  // rediscovery fetch can answer 304 (unchanged) instead of re-delivering body.
  async function tryFetch(urlString, conditional = {}) {
    try {
      // Revalidate URL at fetch time
      await assertUrlAllowed(urlString, { allowPrivate });
      if (respectRobots) {
        const groups = await loadRobots(urlString, { timeoutMs: 5000, allowPrivate, userAgent, fetchImpl });
        const { pathname, search } = new URL(urlString);
        if (!robotsAllows(groups, `${pathname}${search}`, userAgent)) {
          return { ok: false, reason: "robots-disallowed" };
        }
      }
      const doc = await fetchDocument(urlString, {
        timeoutMs: config.crawlTimeoutMs,
        maxBytes: config.crawlMaxBytes,
        maxRedirects: config.crawlMaxRedirects,
        allowPrivate,
        userAgent,
        ...(accept ? { accept } : {}),
        etag: conditional.etag ?? null,
        lastModified: conditional.lastModified ?? null,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      return { ok: true, doc };
    } catch (err) {
      const code = err?.code ?? "fetch-failed";
      return { ok: false, reason: code, error: err };
    }
  }

  // Rediscovery deadline for a successfully fetched URL (null = disabled).
  function computeNextCrawlAt() {
    if (!rediscoveryEnabled || !(rediscoveryTtlMs > 0)) return null;
    return new Date(Date.now() + rediscoveryTtlMs).toISOString();
  }

  // Claim next URL from frontier. Due rediscoveries are claimable only AFTER new
  // queued work and due retries, so revisits never starve fresh URLs.
  const claimed = await frontier.claimNext({
    rediscoveryEnabled,
    ...(claimNow === undefined ? {} : { now: claimNow }),
  });
  if (!claimed) {
    summary.budgetRemaining = totalBudget; // no URLs available
    return summary;
  }

  const { canonical, record } = claimed;
  summary.pagesFetched = 1;
  if (claimed.rediscovery) summary.rediscoveries++;

  // Depth check
  const urlDepth = record.depth ?? 0;
  if (urlDepth > maxDepth) {
    // A depth-exceeded URL is intentionally not re-crawled: clear any rediscovery
    // deadline so it can never be re-claimed in a loop.
    await frontier.markVisited(canonical, { fetchOutcome: "depth-exceeded", nextCrawlAt: null });
    summary.depthReached = urlDepth;
    return summary;
  }

  // Extract domain from the claimed URL
  const domain = canonicalDomain(record.url);

  // Domain check - check both discovery policy and domain registry
  const claimDecision = decideUrl(record.url);
  if (!claimDecision.allowed) {
    // A policy refusal is not a transient error: do not schedule a retry.
    await frontier.markFailed(canonical, { reason: claimDecision.reason ?? "disallowed_domain", incrementRetries: false });
    summary.domainFiltered = 1;
    return summary;
  }

  // Check domain registry for blocked domains
  if (domainRegistry && domain) {
    const domainRecord = domainRegistry.get(domain);
    if (domainRecord && domainRecord.policy === "blocked") {
      await frontier.markFailed(canonical, { reason: "domain_blocked", incrementRetries: false });
      summary.domainFiltered = 1;
      return summary;
    }
  }

  // Admission is the durable gate for the whole target operation: the robots
  // prerequisite, the target request, and its bounded redirect chain.
  if (admissionGateway) {
    const admitted = await admissionGateway.authorize({
      url: canonical,
      generation: record.generation ?? 0,
      etag: record.etag ?? null,
      lastModified: record.lastModified ?? null,
      userAgent,
      accept,
      respectRobots,
      maxRedirects: config.crawlMaxRedirects,
    });
    await frontier.recordAdmission(canonical, {
      requestId: admitted.requestId,
      payloadDigest: admitted.payloadDigest,
    });

    if (admitted.compliance !== COMPLIANCE.COMPLIANT) {
      await frontier.markQuarantined(canonical, {
        reason: admitted.reason ?? "admission-protocol-violation",
        requestId: admitted.requestId,
        payloadDigest: admitted.payloadDigest,
      });
      summary.admissionQuarantined++;
      return summary;
    }
    if (admitted.decision === DECISION.REJECTED) {
      await frontier.markRejected(canonical, {
        reason: admitted.reason ?? "gateway-rejected",
        requestId: admitted.requestId,
        payloadDigest: admitted.payloadDigest,
      });
      summary.admissionRejected++;
      return summary;
    }
    if (admitted.decision !== DECISION.ADMITTED) {
      await frontier.markQuarantined(canonical, {
        reason: "admission-without-decision",
        requestId: admitted.requestId,
        payloadDigest: admitted.payloadDigest,
      });
      summary.admissionQuarantined++;
      return summary;
    }
  }

  // Fetch the URL, conditionally when we hold validators from a prior visit.
  const fetchResult = await tryFetch(record.url, { etag: record.etag, lastModified: record.lastModified });
  summary.pagesFetched = 1;

  if (fetchResult.ok) {
    const doc = fetchResult.doc;

    // 304 Not Modified — the content is unchanged. Do not re-emit the document
    // (no duplicate article), do not re-extract links; just refresh validators
    // and the rediscovery deadline so it is re-checked after the TTL again.
    if (doc?.notModified) {
      summary.notModified++;
      await frontier.markVisited(canonical, {
        etag: doc.etag ?? record.etag ?? null,
        lastModified: doc.lastModified ?? record.lastModified ?? null,
        nextCrawlAt: computeNextCrawlAt(),
        notModified: true,
        rediscovery: Boolean(record.rediscovery),
        advanceGeneration: Boolean(admissionGateway),
      });
      if (domainRegistry && domain) {
        domainRegistry.recordFetchSuccess(domain, { url: record.url, contentHash: record.contentHash ?? undefined });
      }
      return summary;
    }

    // Mark visited — this is a frontier state update, NOT a fetch failure.
    // A language-filtered document was fetched successfully; it just won't
    // enter the article corpus.
    await frontier.markVisited(canonical, {
      contentHash: doc?.contentHash,
      etag: doc?.etag ?? null,
      lastModified: doc?.lastModified ?? null,
      nextCrawlAt: computeNextCrawlAt(),
      rediscovery: Boolean(record.rediscovery),
      advanceGeneration: Boolean(admissionGateway),
    });

    // Register domain in registry if provided
    if (domainRegistry && domain) {
      domainRegistry.recordFetchSuccess(domain, { url: record.url, contentHash: doc?.contentHash });
    }

    // Extract links from the RAW HTML — ALWAYS, before the language check.
    // A foreign-language page may still lead to useful English content.
    // Resolve relative hrefs against the FINAL URL after redirects.
    const source = doc?.html ?? doc?.text ?? "";
    if (source) {
      const discoveredUrls = extractLinksFromHTML(source, doc.url);
      summary.linksDiscovered = discoveredUrls.size;
      const linkDepth = urlDepth + 1;

      let enqueuedThisPage = 0;
      for (const linkUrl of discoveredUrls) {
        if (linkDepth > maxDepth) break;
        if (enqueuedThisPage >= maxLinksPerPage) break;
        const linkDecision = decideUrl(linkUrl);
        if (!linkDecision.allowed) {
          summary.domainFiltered++;
          summary.discovered.push({ url: linkUrl, accepted: false, reason: linkDecision.reason });
          continue;
        }

        // Discovery language prior on EXTRACTED LINKS (not just adapter
        // candidates): a link whose HOST declares a non-English language is
        // refused at discovery under `reject`, or counted under `warn`, so
        // foreign-wiki URLs never enter the frontier. The ingest filter remains
        // the authoritative backstop on the actual text.
        if (discoveryLanguagePrior && discoveryLanguagePrior !== "off") {
          const prior = classifyDiscoveryLanguage(linkUrl, discoveryLanguagePrior);
          if (prior.action === "reject") {
            summary.languagePriorRejected++;
            summary.discovered.push({ url: linkUrl, accepted: false, reason: "discovery-language-prior", declaredLang: prior.declaredLang });
            continue;
          }
          if (prior.action === "warn") summary.languagePriorWarned++;
        }

        // Check domain registry for discovered links
        const linkDomain = canonicalDomain(linkUrl);
        if (domainRegistry && linkDomain) {
          const domainRecord = domainRegistry.get(linkDomain);
          if (domainRecord && domainRecord.policy === "blocked") {
            summary.domainFiltered++;
            summary.discovered.push({ url: linkUrl, accepted: false, reason: "domain_blocked" });
            continue;
          }
        }

        // Register discovered domain
        if (domainRegistry && linkDomain) {
          domainRegistry.recordDiscovery(linkDomain, {
            url: linkUrl,
            parentUrl: record.url,
            depth: urlDepth,
            trust: linkDecision.trust,
          });
        }

        const enqueued = await frontier.enqueue(linkUrl, {
          depth: linkDepth,
          parent: record.url,
          seed: record.seed,
          discoveryProvenance: { type: "link_extraction", parentUrl: record.url, depth: urlDepth, trust: linkDecision.trust },
        });
        if (enqueued) {
          enqueuedThisPage++;
          summary.urlsEnqueued++;
          summary.discovered.push({ url: linkUrl, accepted: true, reason: linkDecision.reason });
        }
      }
    }

    // Language filter — AFTER link extraction so discovery continues.
    if (languageFilter) {
      const filterResult = applyLanguageFilter(doc, languageFilter, summary, record.url);
      if (filterResult === "skip") {
        return summary;
      }
    }

    summary.documents.push(normalizeRawDoc(doc, record));
  } else {
    // Fetch failed
    if (domainRegistry && domain) {
      domainRegistry.recordFetchFailure(domain, { url: record.url, error: fetchResult.error });
    }
    await frontier.markFailed(canonical, {
      reason: fetchResult.reason ?? "fetch-failed",
      error: fetchResult.error,
      backoffBaseMs: config.frontierRetryBackoffBaseMs,
      backoffMaxMs: config.frontierRetryBackoffMaxMs,
    });
    summary.errors++;
    summary.failures.push({ url: record.url, ok: false, reason: fetchResult.reason ?? "fetch-failed" });
  }

  return summary;
}

/**
 * Run multiple acquisition cycles (bounded by budget and cycle count).
 * Designed for use with JobSupervisor learning cycle integration.
 *
 * @param {object} opts - Options: frontier, maxCycles, onCycle callback
 * @returns {object} Aggregate results across all cycles
 */
export async function runCrawlBatches({
  frontier,
  domainRegistry,
  maxCycles = 0,
  maxPages = config.crawlPagesPerCycle,
  maxDepth = config.crawlMaxDepth,
  respectRobots = config.crawlRespectRobots,
  allowPrivate = config.crawlAllowPrivate,
  userAgent = config.crawlUserAgent,
  policy = null,
  maxLinksPerPage = config.crawlMaxLinksPerPage,
  languageFilter = null,
  discoveryLanguagePrior = null,
  rediscoveryEnabled = config.rediscoveryEnabled,
  rediscoveryTtlMs = config.rediscoveryTtlMs,
  admissionGateway = null,
  fetchImpl,
  accept,
  onCycle = async (ctx) => ({ pagesFetched: 0, linksDiscovered: 0, urlsEnqueued: 0 }),
} = {}) {
  if (!frontier.initialized) await frontier.init();

let totalPagesFetched = 0;
  let totalLinksDiscovered = 0;
  let totalUrlsEnqueued = 0;

  let cycles = 0;
  const documents = [];
  const failures = [];
  const discovered = [];
  let languageFiltered = 0;
  let languagePriorWarned = 0;
  let languagePriorRejected = 0;
  let notModified = 0;
  let rediscoveries = 0;
  let admissionRejected = 0;
  let admissionQuarantined = 0;
  const skipped = [];
  const shadowRejected = [];

  for (let cycle = 1; ; cycle++) {
    if (maxCycles > 0 && cycle > maxCycles) break;

    // Quick check: if budget is finite and we've hit it, stop
    if (config.crawlTotalBudget > 0 && totalPagesFetched >= config.crawlTotalBudget) {
      break;
    }

    const cycleCtx = {
      frontier,
      domainRegistry,
      maxPages,
      maxDepth,
      respectRobots,
      allowPrivate,
      userAgent,
      policy,
      maxLinksPerPage,
      languageFilter,
      discoveryLanguagePrior,
      rediscoveryEnabled,
      rediscoveryTtlMs,
      admissionGateway,
      fetchImpl,
      accept,
      totalBudget: config.crawlTotalBudget - totalPagesFetched,
    };
    const cycleResult = await runCrawlCycle(cycleCtx);
    cycles++;

    totalPagesFetched += cycleResult.pagesFetched;
    totalLinksDiscovered += cycleResult.linksDiscovered;
    totalUrlsEnqueued += cycleResult.urlsEnqueued;
    if (cycleResult.documents?.length) documents.push(...cycleResult.documents);
    if (cycleResult.failures?.length) failures.push(...cycleResult.failures);
    if (cycleResult.discovered?.length) discovered.push(...cycleResult.discovered);
    languageFiltered += cycleResult.languageFiltered ?? 0;
    languagePriorWarned += cycleResult.languagePriorWarned ?? 0;
    languagePriorRejected += cycleResult.languagePriorRejected ?? 0;
    notModified += cycleResult.notModified ?? 0;
    rediscoveries += cycleResult.rediscoveries ?? 0;
    admissionRejected += cycleResult.admissionRejected ?? 0;
    admissionQuarantined += cycleResult.admissionQuarantined ?? 0;
    if (cycleResult.skipped?.length) skipped.push(...cycleResult.skipped);
    if (cycleResult.shadowRejected?.length) shadowRejected.push(...cycleResult.shadowRejected);

    if (onCycle) await onCycle({ ...cycleResult, budgetRemaining: config.crawlTotalBudget - totalPagesFetched });

    // Stop conditions
    // - No URLs available (frontier empty/fully processed)
    // - Budget exhausted
    // - Max cycles reached
    // - No new links discovered in a cycle (source exhausted)
    if (
      cycleResult.pagesFetched === 0 ||
      (config.crawlTotalBudget > 0 && totalPagesFetched >= config.crawlTotalBudget) ||
      (maxCycles > 0 && cycle >= maxCycles)
    ) {
      break;
    }
  }

  return {
    cycles,
    totalPagesFetched,
    totalLinksDiscovered,
    totalUrlsEnqueued,
    documents,
    failures,
    discovered,
    languageFiltered,
    languagePriorWarned,
    languagePriorRejected,
    notModified,
    rediscoveries,
    admissionRejected,
    admissionQuarantined,
    skipped,
    shadowRejected,
    budgetRemaining: config.crawlTotalBudget - totalPagesFetched,
  };
}

/**
 * Seed the frontier from CRAWL_URLS config on application start.
 * Idempotent: re-running does not reset completed URLs.
 */
export async function seedFrontierFromConfig(frontier, seeds = config.crawlUrls ?? []) {
  if (!frontier.initialized) await frontier.init();
  const urls = (seeds ?? []).filter(Boolean);
  if (!urls.length) return;
  // Enqueue each seed; frontier's enqueue is idempotent
  for (const url of urls) {
    await frontier.enqueue(url, { depth: 0, seed: url });
  }
}

// Direct-fetch entry point. Defaults come from config so the configured
// crawl mode (CRAWL_MODE / CRAWL_URLS) is the mode actually used — a hard-coded
// `"fixture"` default here silently disconnected production learning from the
// live sources (every cycle ran fixtures while config reported `real`).
export async function collectDocuments({
  mode = config.crawlMode,
  urls = config.crawlUrls,
  // Undefined means "use the global fetch" and therefore identifies a real
  // acquisition path. Tests/local callers that inject a transport are treated as
  // offline/mocked and may run without a gateway.
  fetchImpl = undefined,
  timeoutMs = config.crawlTimeoutMs,
  maxBytes = config.crawlMaxBytes,
  maxRedirects = config.crawlMaxRedirects,
  allowPrivate = config.crawlAllowPrivate,
  respectRobots = config.crawlRespectRobots,
  userAgent = config.crawlUserAgent,
  languageFilter = null,
  admissionGateway = null,
} = {}) {
  const decided = classifyCrawlMode({ mode, urls });
  if (decided.mode === "fixture") {
    return { mode: "fixture", capability: CAPABILITY.fixture, documents: FIXTURE_DOCS.map((t) => fixtureRecord(t)), failures: [] };
  }
  requireAdmissionOrMockTransport("direct collectDocuments", { admissionGateway, fetchImpl });
  if (admissionGateway) throw admissionPathDisabled("direct collectDocuments");

  // If no frontier, fall back to direct fetch of provided URLs (original behaviour)
  if (!urls.length) {
    // fixture-only when no URLs; real mode without URLs throws
    return { mode: "fixture", capability: CAPABILITY.fixture, documents: [], failures: [] };
  }

  const documents = [];
  const failures = [];
  const localSummary = { languageFiltered: 0, skipped: [], shadowRejected: [] };
  for (const url of urls) {
    try {
      await assertUrlAllowed(url, { allowPrivate });
      if (respectRobots) {
        const groups = await loadRobots(url, { timeoutMs: 5000, allowPrivate, userAgent, fetchImpl });
        const { pathname, search } = new URL(url);
        if (!robotsAllows(groups, `${pathname}${search}`, userAgent)) {
          failures.push({ url, ok: false, reason: "robots-disallowed" });
          continue;
        }
      }
      const doc = await fetchDocument(url, { timeoutMs, maxBytes, maxRedirects, allowPrivate, userAgent, fetchImpl });

      // Language filter: a skipped page fetched fine — it is not a failure.
      if (applyLanguageFilter(doc, languageFilter, localSummary, url) === "skip") {
        continue;
      }

      documents.push({
        text: doc.text,
        domain: "general",
        source: new URL(doc.url).hostname,
        url: doc.url,
        title: doc.title,
        status: doc.status,
        contentType: doc.contentType,
        bytes: doc.bytes,
        fetchedAt: doc.fetchedAt,
        contentHash: doc.contentHash,
        htmlLang: doc.htmlLang ?? null,
        crawlMode: "real",
        capability: CAPABILITY.real,
      });
    } catch (err) {
      failures.push({ url, ok: false, reason: err?.code ?? err?.message ?? "fetch-failed" });
    }
  }
  return { mode: "real", capability: CAPABILITY.real, documents, failures, languageFiltered: localSummary.languageFiltered, skipped: localSummary.skipped, shadowRejected: localSummary.shadowRejected };
}

/**
 * Collect documents and persist them to the raw dir. Successful documents go to
 * the corpus file (picked up by the curator); failures are written alongside so
 * "fetched" and "attempted" stay distinguishable.
 * 
 * Now supports frontier mode: if frontier is provided and mode is "real",
 * will use frontier to manage URL state across cycles.
 */
export async function harvest({
  dir = config.paths.raw,
  mode = config.crawlMode,
  // Accept either explicit urls array or let frontier manage URLs
  urls = config.crawlUrls,
  frontier,
  fetchImpl,
  timeoutMs = config.crawlTimeoutMs,
  maxBytes = config.crawlMaxBytes,
  maxRedirects = config.crawlMaxRedirects,
  allowPrivate = config.crawlAllowPrivate,
  respectRobots = config.crawlRespectRobots,
  userAgent = config.crawlUserAgent,
  domainRegistry = null,
  languageFilter = null,
  admissionGateway = null,
} = {}) {
  const decided = classifyCrawlMode({ mode, urls });
  if (decided.mode === "real") {
    requireAdmissionOrMockTransport("direct harvest", { admissionGateway, fetchImpl });
  }

  async function writeJsonLines(filePath, records) {
    const content = records.length > 0 ? records.map((r) => JSON.stringify(r)).join("\n") + "\n" : "[]\n";
    await writeFile(filePath, content);
  }

  // If frontier is provided and we're in real mode, use frontier-managed cycle(s)
  if (frontier && mode === "real") {
    // Seed frontier from CRAWL_URLS if not already seeded. Pending frontier
    // entries are NEVER cleared here: they are legitimate persisted discovery
    // work and must survive a config change (see DiscoveryService for the
    // bootstrap that keeps discovery alive with empty CRAWL_URLS).
    await seedFrontierFromConfig(frontier, urls);
    const policy = createDiscoveryPolicy({
      seedUrls: urls,
      allowedDomains: config.crawlAllowedDomains,
      deniedDomains: config.crawlDeniedDomains,
      mode: config.crawlDiscoveryPolicy,
    });
    // Run bounded cycles (unlimited unless CRAWL_TOTAL_BUDGET / depth caps bound it)
    // Use the caller's registry when provided (production injects the process
    // singleton so the admin UI and the crawler agree). Otherwise default to the
    // configured frontier dir. A caller using an isolated data dir MUST inject
    // its own registry, or discoveries leak into the live one.
    const registry = domainRegistry ?? createDomainRegistry({ dir: config.paths.frontier });
    const result = await runCrawlBatches({
      frontier,
      domainRegistry: registry,
      maxCycles: 0,
      policy,
      allowPrivate,
      respectRobots,
      userAgent,
      languageFilter,
      admissionGateway,
      fetchImpl,
    });

    // Persist what was ACTUALLY fetched (previously this branch returned
    // `documents: []`, so the frontier crawler silently produced nothing).
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "corpus.jsonl");
    await writeJsonLines(filePath, result.documents);
    const failuresPath = path.join(dir, "failures.jsonl");
    await writeJsonLines(failuresPath, result.failures);

    return {
      mode: "real",
      capability: CAPABILITY.real,
      documents: result.documents,
      failures: result.failures,
      discovered: result.discovered,
      cycles: result.cycles,
      totalPagesFetched: result.totalPagesFetched,
      totalUrlsEnqueued: result.totalUrlsEnqueued,
      languageFiltered: result.languageFiltered ?? 0,
      skipped: result.skipped ?? [],
      shadowRejected: result.shadowRejected ?? [],
      file: filePath,
      failuresFile: failuresPath,
    };
  }

  if (decided.mode === "fixture") {
    const filePath = path.join(dir, "corpus.jsonl");
    await mkdir(dir, { recursive: true });
    await writeJsonLines(filePath, FIXTURE_DOCS.map((t) => fixtureRecord(t)));
    const failuresPath = path.join(dir, "failures.jsonl");
    await writeJsonLines(failuresPath, []);
    return {
      mode: "fixture",
      capability: CAPABILITY.fixture,
      documents: [],
      failures: [],
      file: filePath,
      failuresFile: failuresPath,
    };
  }

  if (admissionGateway) throw admissionPathDisabled("direct harvest");

  const documents = [];
  const failures = [];
  const localSummary = { languageFiltered: 0, skipped: [], shadowRejected: [] };
  for (const url of urls) {
    try {
      await assertUrlAllowed(url, { allowPrivate });
      if (respectRobots) {
        const groups = await loadRobots(url, { timeoutMs: 5000, allowPrivate, userAgent, fetchImpl });
        const { pathname, search } = new URL(url);
        if (!robotsAllows(groups, `${pathname}${search}`, userAgent)) {
          failures.push({ url, ok: false, reason: "robots-disallowed", crawlMode: "real", capability: CAPABILITY.real });
          continue;
        }
      }
      const doc = await fetchDocument(url, { timeoutMs, maxBytes, maxRedirects, allowPrivate, userAgent, fetchImpl });

      // Language filter: skipped is NOT a fetch failure — the page fetched fine.
      if (applyLanguageFilter(doc, languageFilter, localSummary, url) === "skip") {
        continue;
      }

      documents.push({
        text: doc.text,
        domain: "general",
        source: new URL(doc.url).hostname,
        url: doc.url,
        title: doc.title,
        status: doc.status,
        contentType: doc.contentType,
        bytes: doc.bytes,
        fetchedAt: doc.fetchedAt,
        contentHash: doc.contentHash,
        htmlLang: doc.htmlLang ?? null,
        crawlMode: "real",
        capability: CAPABILITY.real,
      });
    } catch (err) {
      failures.push({ url, ok: false, reason: err?.code ?? err?.message ?? "fetch-failed", crawlMode: "real", capability: CAPABILITY.real });
    }
  }

  const filePath = path.join(dir, "corpus.jsonl");
  await mkdir(dir, { recursive: true });
  await writeJsonLines(filePath, documents);
  const failuresPath = path.join(dir, "failures.jsonl");
  await writeJsonLines(failuresPath, failures);

  return {
    mode: "real",
    capability: CAPABILITY.real,
    documents,
    failures,
    languageFiltered: localSummary.languageFiltered,
    skipped: localSummary.skipped,
    shadowRejected: localSummary.shadowRejected,
    file: filePath,
    failuresFile: failuresPath,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let admissionGateway = null;
    let frontier;
    if (config.crawlMode === "real") {
      const admissionStore = await AdmissionStore.open({
        dir: config.paths.admission,
        config: {
          capLimit: config.admissionCapLimit,
          capEpoch: config.admissionCapEpoch,
          ackRequired: config.admissionAckRequired,
          protocolVersion: config.admissionProtocolVersion,
        },
      });
      admissionGateway = new AcquisitionGateway({ store: admissionStore });
      frontier = new Frontier({ dir: config.paths.frontier });
    }
    const res = await harvest({ languageFilter: config.languageFilter, admissionGateway, frontier });
    console.log(`[crawl] mode=${res.mode} capability=${res.capability} fetched=${res.documents.length} failed=${res.failures.length}`);
    console.log(`[crawl] wrote ${res.documents.length} raw docs -> ${res.file}`);
    if (res.languageFiltered) console.log(`[crawl] language-filtered ${res.languageFiltered} page(s) (skipped=${res.skipped?.length ?? 0}, shadow=${res.shadowRejected?.length ?? 0})`);
    if (res.failuresFile) console.log(`[crawl] ${res.failures.length} failures -> ${res.failuresFile}`);
    if (res.mode === "real" && res.documents.length === 0) {
      console.error("[crawl] real mode fetched nothing — check CRAWL_URLS / failures file");
      process.exitCode = 1;
    }
    console.log(`[crawl] next: npm run curate -- --file ${res.file}`);
  } catch (err) {
    console.error(`[crawl] ${err.message}`);
    process.exitCode = 1;
  }
}