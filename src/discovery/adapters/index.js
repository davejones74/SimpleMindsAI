import { config } from "../../config.js";
import { assertUrlAllowed, fetchDocument, parseRobots, robotsAllows } from "../../harness/fetcher.js";
import { createSitemapAdapter } from "./sitemap-adapter.js";
import { createFeedAdapter } from "./feed-adapter.js";
import { createSearchAdapter } from "./search-adapter.js";

/**
 * A robots-respecting, SSRF-checked text fetch for adapters.
 *
 * `isRobots` bypasses the robots rule for the robots.txt fetch itself — reading
 * robots.txt is what DEFINES the rule, so it must always be permitted. Every
 * other URL is checked against its host's robots policy before fetching, and all
 * fetches inherit the configured timeout / byte / redirect caps and the
 * private-address guard. Adapters therefore cannot reach anywhere the crawler
 * could not.
 */
export function createAdapterFetchText({
  allowPrivate = config.crawlAllowPrivate,
  respectRobots = config.crawlRespectRobots,
  userAgent = config.crawlUserAgent,
  timeoutMs = config.crawlTimeoutMs,
  maxBytes = config.crawlMaxBytes,
  maxRedirects = config.crawlMaxRedirects,
  fetchImpl = undefined,
} = {}) {
  async function loadRobots(origin) {
    try {
      const doc = await fetchDocument(`${origin}/robots.txt`, {
        timeoutMs: Math.min(timeoutMs, 5000),
        allowPrivate,
        userAgent,
        fetchImpl,
      });
      return parseRobots(doc.text);
    } catch {
      return []; // missing/unreadable robots.txt => no restrictions
    }
  }

  return async function fetchText(url, { isRobots = false } = {}) {
    await assertUrlAllowed(url, { allowPrivate });
    if (respectRobots && !isRobots) {
      const u = new URL(url);
      const groups = await loadRobots(u.origin);
      if (!robotsAllows(groups, `${u.pathname}${u.search}`, userAgent)) {
        const err = new Error(`robots-disallowed: ${url}`);
        err.code = "ROBOTS_DISALLOWED";
        throw err;
      }
    }
    const doc = await fetchDocument(url, { timeoutMs, maxBytes, maxRedirects, allowPrivate, userAgent, fetchImpl });
    return doc.text;
  };
}

/** Default JSON fetch for the search adapter (bounded, SSRF-checked, UA-tagged). */
async function defaultFetchJson(url, { timeoutMs = config.crawlTimeoutMs, allowPrivate = config.crawlAllowPrivate, userAgent = config.crawlUserAgent } = {}) {
  await assertUrlAllowed(url, { allowPrivate });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "user-agent": userAgent, accept: "application/json" }, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the configured discovery adapters.
 *
 * Adapters only PROPOSE candidate URLs; they never enqueue or fetch a document
 * themselves. The DiscoveryService is the single writer that filters every
 * candidate through the discovery policy and the domain registry, so an adapter
 * can never bypass a safety check or the operator's block list.
 */
export function buildAdapters({ fetchText, opts = {} } = {}) {
  const enabled = new Set((opts.adapters ?? config.crawlDiscoveryAdapters).map((s) => String(s).trim().toLowerCase()).filter(Boolean));
  const adapters = [];

if (enabled.has("sitemap")) {
    adapters.push(
      createSitemapAdapter({
        fetchText,
        maxSitemaps: opts.maxSitemaps ?? config.crawlDiscoveryMaxSitemaps,
        maxSitemapDepth: opts.sitemapMaxDepth ?? config.crawlDiscoverySitemapMaxDepth,
        maxCandidates: opts.maxCandidates ?? config.crawlDiscoveryMaxCandidates,
        knownUrls: opts.knownUrls ?? null,
      }),
    );
  }
  if (enabled.has("feed")) {
    adapters.push(
      createFeedAdapter({
        fetchText,
        feeds: opts.feeds ?? config.crawlDiscoveryFeeds,
        maxCandidates: opts.maxCandidates ?? config.crawlDiscoveryMaxCandidates,
      }),
    );
  }
  if (enabled.has("search")) {
    adapters.push(
      createSearchAdapter({
        provider: opts.searchProvider ?? config.crawlSearchProvider,
        endpoint: opts.searchEndpoint ?? config.crawlSearchEndpoint,
        queryParam: opts.searchQueryParam ?? config.crawlSearchQueryParam,
        queries: opts.searchQueries ?? config.crawlSearchQueries,
        extraParams: opts.searchExtraParams ?? config.crawlSearchExtraParams,
        fetchJson: opts.fetchJson ?? defaultFetchJson,
        maxCandidates: opts.maxCandidates ?? config.crawlDiscoveryMaxCandidates,
      }),
    );
  }
  return adapters;
}
