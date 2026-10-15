import { parseSitemap, sitemapsFromRobots, resolveHttpUrl } from "./parse.js";

/**
 * Sitemap discovery adapter.
 *
 * For each root it reads the origin's robots.txt `Sitemap:` directives (falling
 * back to `/sitemap.xml`), then walks sitemap indexes breadth-first within hard
 * bounds. It returns candidate PAGE URLs only — it never returns a sitemap URL
 * as a document — and never enqueues anything itself: the DiscoveryService is
 * the single authority that filters candidates through the discovery policy and
 * the domain registry before they touch the persistent frontier.
 */
export function createSitemapAdapter({
  fetchText,
  maxSitemaps = 50,
  maxSitemapDepth = 3,
  maxCandidates = 500,
} = {}) {
  return {
    name: "sitemap",
    kind: "root-based",
    async discover({ roots = [] } = {}) {
      const diagnostics = { rootsTried: 0, sitemapsFetched: 0, errors: 0 };
      const candidates = [];
      const seenSitemaps = new Set();
      const seenPages = new Set();

      for (const root of roots) {
        const rootUrl = resolveHttpUrl(root);
        if (!rootUrl) continue;
        diagnostics.rootsTried++;
        const origin = new URL(rootUrl).origin;

        // 1. Prefer the sitemaps the origin advertises in robots.txt.
        const seedSitemaps = [];
        try {
          const robots = await fetchText(`${origin}/robots.txt`, { isRobots: true });
          for (const s of sitemapsFromRobots(robots)) {
            const abs = resolveHttpUrl(s, `${origin}/`);
            if (abs) seedSitemaps.push(abs);
          }
        } catch {
          // Missing/unreadable robots.txt is normal; fall through to /sitemap.xml.
        }
        if (!seedSitemaps.length) seedSitemaps.push(`${origin}/sitemap.xml`);

        // 2. Bounded breadth-first walk over indexes and urlsets.
        const queue = seedSitemaps.map((url) => ({ url, depth: 0 }));
        while (queue.length && diagnostics.sitemapsFetched < maxSitemaps && candidates.length < maxCandidates) {
          const { url: sitemapUrl, depth } = queue.shift();
          if (seenSitemaps.has(sitemapUrl)) continue;
          seenSitemaps.add(sitemapUrl);

          let xml;
          try {
            xml = await fetchText(sitemapUrl);
          } catch {
            diagnostics.errors++;
            continue;
          }
          diagnostics.sitemapsFetched++;

          const parsed = parseSitemap(xml, sitemapUrl);
          if (parsed.type === "sitemapindex") {
            if (depth < maxSitemapDepth) {
              for (const child of parsed.sitemaps) queue.push({ url: child, depth: depth + 1 });
            }
          } else if (parsed.type === "urlset") {
            for (const page of parsed.urls) {
              if (candidates.length >= maxCandidates) break;
              if (seenPages.has(page)) continue;
              seenPages.add(page);
              candidates.push({ url: page, provenance: { type: "sitemap", sitemapUrl, root: rootUrl } });
            }
          }
        }
      }

      const operated = diagnostics.rootsTried > 0;
      return {
        status: candidates.length ? "ok" : operated ? "idle" : "unavailable",
        reason: candidates.length ? null : operated ? "no-sitemap-candidates" : "no-roots",
        candidates,
        diagnostics,
      };
    },
  };
}
