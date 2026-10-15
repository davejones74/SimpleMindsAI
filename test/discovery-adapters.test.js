import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSitemap,
  sitemapsFromRobots,
  parseFeed,
  extractFeedLinksFromHtml,
  resolveHttpUrl,
} from "../src/discovery/adapters/parse.js";
import { createSitemapAdapter } from "../src/discovery/adapters/sitemap-adapter.js";
import { createFeedAdapter } from "../src/discovery/adapters/feed-adapter.js";
import { createSearchAdapter } from "../src/discovery/adapters/search-adapter.js";

// A deterministic, in-memory fetchText. Unknown URLs throw (like a 404/network
// error) so the adapters' error handling is exercised without any network.
function fakeFetch(map) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const hit = map[url];
    if (hit === undefined) {
      const e = new Error(`no fixture for ${url}`);
      e.code = "NOT_FOUND";
      throw e;
    }
    return hit;
  };
  fn.calls = calls;
  return fn;
}

test("resolveHttpUrl: absolute/relative resolution, http(s) only", () => {
  assert.equal(resolveHttpUrl("/a", "https://x.test/dir/"), "https://x.test/a");
  assert.equal(resolveHttpUrl("https://x.test/b#frag"), "https://x.test/b");
  assert.equal(resolveHttpUrl("javascript:alert(1)"), null);
  assert.equal(resolveHttpUrl(""), null);
  assert.equal(resolveHttpUrl(null), null);
});

test("parseSitemap: urlset vs sitemapindex, resolves relative locs", () => {
  const urlset = parseSitemap(
    `<?xml?><urlset><url><loc>/a</loc></url><url><loc>https://x.test/b</loc></url></urlset>`,
    "https://x.test/sitemap.xml",
  );
  assert.equal(urlset.type, "urlset");
  assert.deepEqual(urlset.urls, ["https://x.test/a", "https://x.test/b"]);

  const index = parseSitemap(`<sitemapindex><sitemap><loc>https://x.test/s1.xml</loc></sitemap></sitemapindex>`);
  assert.equal(index.type, "sitemapindex");
  assert.deepEqual(index.sitemaps, ["https://x.test/s1.xml"]);

  assert.equal(parseSitemap("<html><body>not a sitemap</body></html>").type, "unknown");
});

test("parseSitemap: drops malformed / non-http locs", () => {
  const r = parseSitemap(
    `<urlset><url><loc>javascript:alert(1)</loc></url><url><loc></loc></url><url><loc>https://ok.test/p</loc></url></urlset>`,
  );
  assert.deepEqual(r.urls, ["https://ok.test/p"]);
});

test("sitemapsFromRobots: extracts case-insensitive Sitemap: directives", () => {
  const s = sitemapsFromRobots("User-agent: *\nDisallow: /private\nSitemap: https://x.test/sm.xml\nSITEMAP: https://x.test/other.xml\n");
  assert.deepEqual(s, ["https://x.test/sm.xml", "https://x.test/other.xml"]);
});

test("parseFeed: RSS <item><link> and Atom <entry><link href>", () => {
  const rss = parseFeed(
    `<rss><channel><item><link>https://x.test/a</link></item><item><link><![CDATA[https://x.test/b]]></link></item></channel></rss>`,
  );
  assert.deepEqual(rss, ["https://x.test/a", "https://x.test/b"]);

  const atom = parseFeed(`<feed><entry><link rel="alternate" href="https://x.test/c"/></entry></feed>`);
  assert.deepEqual(atom, ["https://x.test/c"]);

  assert.deepEqual(parseFeed("<html></html>"), []);
});

test("extractFeedLinksFromHtml: only feed-typed alternates", () => {
  const html =
    `<link rel="alternate" type="application/rss+xml" href="/feed.xml">` +
    `<link rel="stylesheet" href="/s.css">` +
    `<link rel="alternate" type="application/atom+xml" href="https://x.test/atom">`;
  assert.deepEqual(extractFeedLinksFromHtml(html, "https://x.test/"), [
    "https://x.test/feed.xml",
    "https://x.test/atom",
  ]);
});

test("sitemap adapter: robots Sitemap: directive -> index -> pages", async () => {
  const fetchText = fakeFetch({
    "https://site.test/robots.txt": "Sitemap: https://site.test/sm-index.xml\n",
    "https://site.test/sm-index.xml": `<sitemapindex><sitemap><loc>https://site.test/sm-1.xml</loc></sitemap></sitemapindex>`,
    "https://site.test/sm-1.xml": `<urlset><url><loc>https://site.test/p1</loc></url><url><loc>https://site.test/p2</loc></url></urlset>`,
  });
  const adapter = createSitemapAdapter({ fetchText });
  const res = await adapter.discover({ roots: ["https://site.test/"] });
  assert.equal(res.status, "ok");
  assert.deepEqual(res.candidates.map((c) => c.url).sort(), ["https://site.test/p1", "https://site.test/p2"]);
  assert.equal(res.candidates[0].provenance.type, "sitemap");
  // The sitemap URL is never proposed as a document.
  assert.ok(!res.candidates.some((c) => c.url.endsWith(".xml")));
});

test("sitemap adapter: falls back to /sitemap.xml; unreachable roots are non-fatal", async () => {
  const fetchText = fakeFetch({
    "https://site.test/robots.txt": "User-agent: *\nDisallow:\n",
    "https://site.test/sitemap.xml": `<urlset><url><loc>https://site.test/only</loc></url></urlset>`,
    // https://dead.test/* intentionally absent => throws, adapter must continue
  });
  const adapter = createSitemapAdapter({ fetchText });
  const res = await adapter.discover({ roots: ["https://site.test/", "https://dead.test/"] });
  assert.deepEqual(res.candidates.map((c) => c.url), ["https://site.test/only"]);
  assert.ok(res.diagnostics.errors >= 1);
});

test("feed adapter: advertised feed -> item links; explicit feeds supported", async () => {
  const fetchText = fakeFetch({
    "https://site.test/": `<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head></html>`,
    "https://site.test/feed.xml": `<rss><channel><item><link>https://site.test/post-1</link></item></channel></rss>`,
    "https://other.test/feed": `<feed><entry><link rel="alternate" href="https://other.test/post-2"/></entry></feed>`,
  });
  const adapter = createFeedAdapter({ fetchText, feeds: ["https://other.test/feed"] });
  const res = await adapter.discover({ roots: ["https://site.test/"] });
  assert.equal(res.status, "ok");
  const urls = res.candidates.map((c) => c.url).sort();
  assert.deepEqual(urls, ["https://other.test/post-2", "https://site.test/post-1"]);
});

test("search adapter: unavailable without a provider; candidates with one", async () => {
  const off = createSearchAdapter({ endpoint: null, queries: ["q"], fetchJson: async () => ({}) });
  const offRes = await off.discover();
  assert.equal(offRes.status, "unavailable");
  assert.equal(offRes.candidates.length, 0);

  const on = createSearchAdapter({
    provider: "test-provider",
    endpoint: "https://search.test/api",
    queryParam: "q",
    queries: ["steam engines"],
    fetchJson: async (url) => {
      assert.ok(url.includes("q=steam+engines"));
      return { results: [{ url: "https://x.test/a" }, { link: "https://x.test/b" }] };
    },
  });
  const res = await on.discover();
  assert.equal(res.status, "ok");
  assert.deepEqual(res.candidates.map((c) => c.url).sort(), ["https://x.test/a", "https://x.test/b"]);
  assert.equal(res.candidates[0].provenance.type, "search");
});
