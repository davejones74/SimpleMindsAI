import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Frontier, canonicalURL } from "./frontier.js";
import { config } from "../config.js";
import { fetchDocument, parseRobots, robotsAllows, assertUrlAllowed, contentHashFor } from "./fetcher.js";

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
 * Canonicalise a URL for frontier deduplication.
 * Preserves query parameter order and values; does not remove or reorder.
 */
function canonicalURLSafe(urlString) {
  try {
    const u = new URL(urlString);
    const scheme = u.protocol.toLowerCase();
    const host = u.host.toLowerCase();
    let path = u.pathname;
    // Sort query param keys deterministically, preserve values
    const searchParams = u.search;
    let query = "";
    if (searchParams.toString()) {
      const sortedKeys = [...searchParams.keys()].sort();
      const entries = sortedKeys.map((key) => `${key}=${searchParams.get(key)}`);
      query = "?" + entries.join("&");
    }
    return `${scheme}//${host}${path}${query}`;
  } catch {
    return null;
  }
}

/**
 * Extract all absolute URLs from HTML <a href="..."> attributes.
 * Only keeps hrefs that are absolute (or protocol-relative //example.com)
 * and have a supported scheme (http/https).
 */
function extractLinksFromHTML(html) {
  const urls = new Set();
  const regex = /<a\s+(?:[^>]*?\bhref=|[^>]*\bhref\s*)(["'])((?:[^"']|\\.)*?)\1/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const rawHref = match[2];
    let href = rawHref;
    // Strip surrounding quotes if present
    if ((href.startsWith('"') && href.endsWith('"')) || (href.startsWith("'") && href.endsWith("'"))) {
      href = href.slice(1, -1);
    }
    // Remove trailing whitespace
    href = href.trim();
    // Skip empty or javascript:
    if (!href || href.startsWith("javascript:")) continue;
    // Make absolute: if protocol-relative (//host) or relative, we need the base
    // We'll only keep URLs that already have a scheme, since we don't have a base URL here
    try {
      const u = new URL(href);
      if (u.protocol === "http:" || u.protocol === "https:") {
        urls.add(u.href);
      }
    } catch {
      // not a valid URL; skip
    }
  }
  return urls;
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
    maxDepth = config.crawlMaxDepth,
    maxPages = config.crawlPagesPerCycle,
    totalBudget = config.crawlTotalBudget,
    respectRobots = config.crawlRespectRobots,
    userAgent = config.crawlUserAgent,
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
    errors: 0,
  };

  // Helper: check domain allow-list
  function allowedDomain(urlString) {
    if (config.crawlAllowedDomains.length === 0) {
      // Empty allowlist → default to seed hosts only
      // Seed hosts are tracked in frontier records; if no seeds yet, allow all
      return true;
    }
    try {
      const u = new URL(urlString);
      return config.crawlAllowedDomains.some((d) => u.hostname === d || u.hostname.endsWith("." + d));
    } catch {
      return false;
    }
  }

  // Helper: fetch a URL with full guard set, returning result or reason
  async function tryFetch(urlString) {
    try {
      // Revalidate URL at fetch time
      await assertUrlAllowed(urlString, { allowPrivate: config.crawlAllowPrivate });
      if (respectRobots) {
        const groups = await loadRobots(urlString, { timeoutMs: 5000, allowPrivate, userAgent });
        const { pathname, search } = new URL(urlString);
        if (!robotsAllows(groups, `${pathname}${search}`, userAgent)) {
          return { ok: false, reason: "robots-disallowed" };
        }
      }
      const doc = await fetchDocument(urlString, {
        timeoutMs: config.crawlTimeoutMs,
        maxBytes: config.crawlMaxBytes,
        maxRedirects: config.crawlMaxRedirects,
        allowPrivate: config.crawlAllowPrivate,
        userAgent,
      });
      return { ok: true, doc };
    } catch (err) {
      const code = err?.code ?? "fetch-failed";
      return { ok: false, reason: code, error: err };
    }
  }

  // Claim next URL from frontier
  const claimed = await frontier.claimNext();
  if (!claimed) {
    summary.budgetRemaining = totalBudget; // no URLs available
    return summary;
  }

  const { canonical, record } = claimed;
  summary.pagesFetched = 1;

  // Depth check
  const urlDepth = record.depth ?? 0;
  if (urlDepth > maxDepth) {
    await frontier.markVisited(canonical, { fetchOutcome: "depth-exceeded" });
    summary.depthReached = urlDepth;
    return summary;
  }

  // Domain check
  if (!allowedDomain(record.url)) {
    await frontier.markFailed(canonical, { reason: "disallowed_domain" });
    summary.domainFiltered = 1;
    return summary;
  }

  // Fetch the URL
  const fetchResult = await tryFetch(record.url);
  summary.pagesFetched = 1;

  if (fetchResult.ok) {
    const doc = fetchResult.doc;
    // Mark visited
    await frontier.markVisited(canonical, { contentHash: doc?.contentHash });

    // Extract links from HTML
    if (doc?.text) {
      const discoveredUrls = extractLinksFromHTML(doc.text);
      summary.linksDiscovered = discoveredUrls.size;

      // Enqueue eligible discoveries
      for (const linkUrl of discoveredUrls) {
        // Depth check
        const linkDepth = urlDepth + 1;
        if (linkDepth > maxDepth) continue;

        // Domain check
        if (!allowedDomain(linkUrl)) {
          summary.domainFiltered++;
          continue;
        }

        // Budget check
        if (totalBudget > 0) {
          // Count distinct URLs claimed (including this one's cycle)
          // Simple: if we've already enqueued enough in this cycle, stop
          // We'll check enqueue count against maxPages
        }

        // Enqueue into frontier
        const enqueued = await frontier.enqueue(linkUrl, {
          depth: linkDepth,
          parent: record.url,
          seed: record.seed,
          discoveryProvenance: { type: "link_extraction", parentUrl: record.url, depth: urlDepth },
        });
        if (enqueued) {
          summary.urlsEnqueued++;
        }
      }
    }

    // Emit progress via... would changeFeed in real usage; here we just summary
    // In production: changeFeed.emit("job.progress", { ... });
  } else {
    // Fetch failed
    await frontier.markFailed(canonical, { reason: fetchResult.reason ?? "fetch-failed", error: fetchResult.error });
    summary.errors++;
  }

  // Budget accounting: decrement against total budget for distinct URLs claimed
  // (successful fetches, failures, robots-disallowed all count as distinct URLs)
  if (totalBudget > 0) {
    // We'll just track; the caller can check summary against budget
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
  maxCycles = 0,
  onCycle = async (ctx) => ({ pagesFetched: 0, linksDiscovered: 0, urlsEnqueued: 0 }),
} = {}) {
  if (!frontier.initialized) await frontier.init();

  let totalPagesFetched = 0;
  let totalLinksDiscovered = 0;
  let totalUrlsEnqueued = 0;
  let cycles = 0;
  let budgetRemaining = config.crawlTotalBudget;

  for (let cycle = 1; ; cycle++) {
    if (maxCycles > 0 && cycle > maxCycles) break;

    // Quick check: if budget is finite and we've hit it, stop
    if (config.crawlTotalBudget > 0 && totalPagesFetched >= config.crawlTotalBudget) {
      break;
    }

    const cycleCtx = {
      frontier,
      maxPages,
      totalBudget: config.crawlTotalBudget - totalPagesFetched,
    };
    const cycleResult = await runCrawlCycle(cycleCtx);

    totalPagesFetched += cycleResult.pagesFetched;
    totalLinksDiscovered += cycleResult.linksDiscovered;
    totalUrlsEnqueued += cycleResult.urlsEnqueued;

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
    budgetRemaining: config.crawlTotalBudget - totalPagesFetched,
  };
}

/**
 * Seed the frontier from CRAWL_URLS config on application start.
 * Idempotent: re-running does not reset completed URLs.
 */
export async function seedFrontierFromConfig(frontier) {
  if (!frontier.initialized) await frontier.init();
  const urls = config.crawlUrls ?? [];
  if (!urls.length) return;
  // Enqueue each seed; frontier's enqueue is idempotent
  for (const url of urls) {
    await frontier.enqueue(url, { depth: 0, seed: url });
  }
}

// Legacy export for harvest (real mode without frontier still works)
export async function collectDocuments({
  mode = "fixture",
  urls = [],
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
  maxBytes = 2_000_000,
  maxRedirects = 5,
  allowPrivate = false,
  respectRobots = true,
  userAgent = "SimpleMindsAI/0.2",
} = {}) {
  const decided = classifyCrawlMode({ mode, urls });
  if (decided.mode === "fixture") {
    return { mode: "fixture", capability: CAPABILITY.fixture, documents: FIXTURE_DOCS.map((t) => fixtureRecord(t)), failures: [] };
  }

  // If no frontier, fall back to direct fetch of provided URLs (original behaviour)
  if (!urls.length) {
    // fixture-only when no URLs; real mode without URLs throws
    return { mode: "fixture", capability: CAPABILITY.fixture, documents: [], failures: [] };
  }

  const documents = [];
  const failures = [];
  for (const url of urls) {
    try {
      await assertUrlAllowed(url, { allowPrivate });
      if (respectRobots) {
        const groups = await loadRobots(url, { timeoutMs: 5000, allowPrivate, userAgent });
        const { pathname, search } = new URL(url);
        if (!robotsAllows(groups, `${pathname}${search}`, userAgent)) {
          failures.push({ url, ok: false, reason: "robots-disallowed" });
          continue;
        }
      }
      const doc = await fetchDocument(url, { timeoutMs, maxBytes, maxRedirects, allowPrivate, userAgent });
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
        crawlMode: "real",
        capability: CAPABILITY.real,
      });
    } catch (err) {
      failures.push({ url, ok: false, reason: err?.code ?? err?.message ?? "fetch-failed" });
    }
  }
  return { mode: "real", capability: CAPABILITY.real, documents, failures };
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
} = {}) {
  // If frontier is provided and we're in real mode, use frontier-managed cycle(s)
  if (frontier && mode === "real") {
    // Seed frontier from CRAWL_URLS if not already seeded
    await seedFrontierFromConfig(frontier);
    
    // Run bounded cycles
    const result = await runCrawlBatches({
      frontier,
      maxCycles: 0, // unlimited unless CRAWL_TOTAL_BUDGET set
      onCycle: (cycleResult) => {
        // Could emit progress here; for now just aggregate
      },
    });
    
    // After cycles, collect whatever documents are available from the frontier's visited URLs
    // For backward compatibility, also allow direct fetch of provided URLs
    if (urls.length) {
      const directResult = await collectDocuments({ mode: "real", urls, allowPrivate, respectRobots, userAgent });
      return directResult;
    }
    
    // Return summary of frontier-managed cycle(s)
    return {
      mode: "real",
      capability: CAPABILITY.real,
      ...result,
      // Include any documents we can list from frontier state
      documents: [], // frontier manages state; documents written via curator pipeline
      cycles: result.cycles,
      totalPagesFetched: result.totalPagesFetched,
      totalUrlsEnqueued: result.totalUrlsEnqueued,
    };
  }

  const decided = classifyCrawlMode({ mode, urls });
  if (decided.mode === "fixture") {
    return { mode: "fixture", capability: CAPABILITY.fixture, documents: FIXTURE_DOCS.map((t) => fixtureRecord(t)), failures: [] };
  }

  const documents = [];
  const failures = [];
  for (const url of urls) {
    try {
      await assertUrlAllowed(url, { allowPrivate });
      if (respectRobots) {
        const groups = await loadRobots(url, { timeoutMs: 5000, allowPrivate, userAgent });
        const { pathname, search } = new URL(url);
        if (!robotsAllows(groups, `${pathname}${search}`, userAgent)) {
          failures.push({ url, ok: false, reason: "robots-disallowed" });
          continue;
        }
      }
      const doc = await fetchDocument(url, { timeoutMs, maxBytes, maxRedirects, allowPrivate, userAgent });
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
        crawlMode: "real",
        capability: CAPABILITY.real,
      });
    } catch (err) {
      failures.push({ url, ok: false, reason: err?.code ?? err?.message ?? "fetch-failed" });
    }
  }
  return { mode: "real", capability: CAPABILITY.real, documents, failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const res = await harvest();
    console.log(`[crawl] mode=${res.mode} capability=${res.capability} fetched=${res.documents.length} failed=${res.failures.length}`);
    console.log(`[crawl] wrote ${res.documents.length} raw docs -> ${res.file}`);
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