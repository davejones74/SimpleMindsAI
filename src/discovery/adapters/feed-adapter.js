import { parseFeed, extractFeedLinksFromHtml, resolveHttpUrl } from "./parse.js";

/**
 * RSS/Atom feed discovery adapter.
 *
 * Feed URLs come from two sources: explicitly configured feeds, and feeds a
 * root page advertises via `<link rel="alternate" type="application/rss+xml">`
 * (or atom). Each feed yields its item/entry links as candidates. Like the
 * sitemap adapter it only proposes URLs — filtering and enqueueing are the
 * DiscoveryService's job.
 */
export function createFeedAdapter({ fetchText, feeds = [], maxCandidates = 200 } = {}) {
  return {
    name: "feed",
    kind: "root-based",
    async discover({ roots = [] } = {}) {
      const diagnostics = { rootsTried: 0, feedsFetched: 0, errors: 0, budgetExhausted: false };
      const candidates = [];
      const seenFeeds = new Set();
      const seenLinks = new Set();
      const isBudgetExhausted = (err) => err?.code === "DISCOVERY_BUDGET_EXHAUSTED";

      const addLink = (link, feedUrl = null) => {
        if (!link || candidates.length >= maxCandidates) return;
        if (seenLinks.has(link)) return;
        seenLinks.add(link);
        candidates.push({ url: link, provenance: { type: "feed", feedUrl } });
      };

      const feedUrls = new Set();
      for (const f of feeds) {
        const abs = resolveHttpUrl(f);
        if (abs) feedUrls.add(abs);
      }

      // Advertised feeds: fetch each root, harvest its <link rel=alternate>, and
      // also try parsing it directly (a root may itself BE a feed).
      for (const root of roots) {
        if (diagnostics.budgetExhausted) break;
        const rootUrl = resolveHttpUrl(root);
        if (!rootUrl) continue;
        diagnostics.rootsTried++;
        let body;
        try {
          body = await fetchText(rootUrl);
        } catch (err) {
          if (isBudgetExhausted(err)) {
            diagnostics.budgetExhausted = true;
            break;
          }
          diagnostics.errors++;
          continue;
        }
        for (const f of extractFeedLinksFromHtml(body, rootUrl)) feedUrls.add(f);
        for (const link of parseFeed(body, rootUrl)) addLink(link, rootUrl);
      }

      for (const feedUrl of feedUrls) {
        if (diagnostics.budgetExhausted) break;
        if (candidates.length >= maxCandidates) break;
        if (seenFeeds.has(feedUrl)) continue;
        seenFeeds.add(feedUrl);
        let xml;
        try {
          xml = await fetchText(feedUrl);
        } catch (err) {
          if (isBudgetExhausted(err)) {
            diagnostics.budgetExhausted = true;
            break;
          }
          diagnostics.errors++;
          continue;
        }
        diagnostics.feedsFetched++;
        for (const link of parseFeed(xml, feedUrl)) addLink(link, feedUrl);
      }

      const operated = diagnostics.rootsTried > 0 || feedUrls.size > 0;
      return {
        status: diagnostics.budgetExhausted
          ? "budget-exhausted"
          : candidates.length ? "ok" : operated ? "idle" : "unavailable",
        reason: diagnostics.budgetExhausted
          ? "discovery-budget-exhausted"
          : candidates.length ? null : operated ? "no-feed-candidates" : "no-roots",
        candidates,
        diagnostics,
      };
    },
  };
}
