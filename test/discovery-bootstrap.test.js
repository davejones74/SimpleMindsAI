import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Frontier } from "../src/frontier.js";
import { DiscoveryService } from "../src/discovery/discovery-service.js";
import { createDomainRegistry } from "../src/storage/domain-registry.js";
import { createDiscoveryPolicy } from "../src/discovery/discovery-policy.js";
import { createSearchAdapter } from "../src/discovery/adapters/search-adapter.js";

// A real loopback server serves the DISCOVERED pages; a fake fetchText serves
// only the sitemap/robots/feed metadata (so adapter behavior is deterministic
// and never depends on the network). Candidate URLs are therefore real loopback
// pages the existing crawler can actually fetch with allowPrivate.
let server;
let base; // http://127.0.0.1:PORT

before(async () => {
  server = http.createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    if (p === "/page-a" || p === "/page-b") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<html><body>${p} article body</body></html>`);
    } else if (p === "/boom") {
      res.writeHead(500);
      res.end("nope");
    } else {
      res.writeHead(404);
      res.end("nope");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
});

const tmpFrontier = () => new Frontier({ dir: mkdtempSync(path.join(tmpdir(), "sma-boot-")) });
const reg = () => createDomainRegistry({ dir: mkdtempSync(path.join(tmpdir(), "sma-boot-reg-")), forceNew: true });
const openPolicy = () => createDiscoveryPolicy({ seedUrls: [], mode: "open" });

test("empty CRAWL_URLS: bootstraps from an eligible registered domain via sitemap", async () => {
  const registry = reg();
  await registry.init();
  await registry.registerDomain("127.0.0.1", { source: "test" });

  const fetchText = async (url) => {
    if (url === "https://127.0.0.1/robots.txt") return "Sitemap: https://127.0.0.1/sitemap.xml\n";
    if (url === "https://127.0.0.1/sitemap.xml")
      return `<urlset><url><loc>${base}/page-a</loc></url><url><loc>${base}/page-b</loc></url></urlset>`;
    if (url === "https://127.0.0.1/") return "<html></html>";
    throw new Error(`unexpected ${url}`);
  };

  const frontier = tmpFrontier();
  const service = new DiscoveryService({ frontier, seeds: [], fetchText, policy: openPolicy(), domainRegistry: registry });
  const res = await service.collect({ maxPages: 10, maxDepth: 0, allowPrivate: true });

  assert.deepEqual(res.documents.map((d) => d.url).sort(), [`${base}/page-a`, `${base}/page-b`]);
  assert.equal(res.discovery.status, "ok");
  assert.equal(res.discovery.via, "registry");
  const sm = res.discovery.bootstrap.adapters.find((a) => a.name === "sitemap");
  assert.equal(sm.enqueued, 2, "sitemap candidates entered the frontier");
  // Provenance is persisted on the frontier record, not just reported.
  const records = [...frontier.state.values()];
  assert.ok(records.some((r) => r.discoveryProvenance?.type === "sitemap"));
});

test("empty CRAWL_URLS + no registry: an independent search provider bootstraps discovery", async () => {
  const fetchJson = async () => ({ results: [{ url: `${base}/page-a` }, { url: `${base}/page-b` }] });
  const service = new DiscoveryService({
    frontier: tmpFrontier(),
    seeds: [],
    defaultSeeds: [], // isolate the independent-provider path from the bootstrap fallback
    adapters: [
      createSearchAdapter({ provider: "test", endpoint: "https://search.test/api", queryParam: "q", queries: ["x"], fetchJson }),
    ],
    policy: openPolicy(),
    domainRegistry: reg(),
  });
  const res = await service.collect({ maxPages: 10, maxDepth: 0, allowPrivate: true });

  assert.equal(res.discovery.status, "ok");
  assert.equal(res.discovery.providerAvailable, true);
  assert.deepEqual(res.documents.map((d) => d.url).sort(), [`${base}/page-a`, `${base}/page-b`]);
});

test("no configured source reports `no-source-configured`, not `exhausted`", async () => {
  const service = new DiscoveryService({
    frontier: tmpFrontier(),
    seeds: [],
    defaultSeeds: [], // isolate the "nothing configured" branch from the bootstrap fallback
    adapters: [],
    policy: openPolicy(),
    domainRegistry: reg(),
  });
  const res = await service.collect({ allowPrivate: true });
  assert.equal(res.discovery.status, "no-source-configured");
  assert.equal(res.documents.length, 0);
  assert.equal(res.frontier.total, 0);
});

test("an unavailable search provider is never reported as operational", async () => {
  const service = new DiscoveryService({
    frontier: tmpFrontier(),
    seeds: [],
    defaultSeeds: [], // isolate the "nothing configured" branch from the bootstrap fallback
    adapters: [createSearchAdapter({ endpoint: null, queries: ["x"], fetchJson: async () => ({}) })],
    policy: openPolicy(),
    domainRegistry: reg(),
  });
  const res = await service.collect({ allowPrivate: true });
  assert.equal(res.discovery.status, "no-source-configured");
  assert.equal(res.discovery.providerAvailable, false);
  assert.equal(res.discovery.bootstrap.adapters[0].status, "unavailable");
});

test("persisted frontier discovery work survives a restart (new instance, same dir)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sma-boot-"));
  const first = new Frontier({ dir });
  await first.init();
  await first.enqueue(`${base}/page-a`, { depth: 0 });

  // Simulate a process restart: a brand-new frontier over the same directory.
  const restarted = new Frontier({ dir });
  const service = new DiscoveryService({ frontier: restarted, seeds: [], defaultSeeds: [], adapters: [], policy: openPolicy(), domainRegistry: reg() });
  const res = await service.collect({ maxPages: 5, maxDepth: 0, allowPrivate: true });

  assert.deepEqual(res.documents.map((d) => d.url), [`${base}/page-a`]);
  assert.equal(res.discovery.status, "ok");
});

test("a blocked domain proposed by an adapter is rejected, never enqueued", async () => {
  const registry = reg();
  await registry.init();
  await registry.registerDomain("127.0.0.1", {});
  await registry.registerDomain("blocked.test", {});
  await registry.blockDomain("blocked.test", { reason: "test" });

  const fetchText = async (url) => {
    if (url === "https://127.0.0.1/robots.txt") return "Sitemap: https://127.0.0.1/sm.xml\n";
    if (url === "https://127.0.0.1/sm.xml")
      return `<urlset><url><loc>http://blocked.test/x</loc></url><url><loc>${base}/page-a</loc></url></urlset>`;
    if (url === "https://127.0.0.1/") return "<html></html>";
    throw new Error(`unexpected ${url}`);
  };

  const frontier = tmpFrontier();
  const service = new DiscoveryService({ frontier, seeds: [], fetchText, policy: openPolicy(), domainRegistry: registry });
  const res = await service.collect({ maxPages: 10, maxDepth: 0, allowPrivate: true });

  const sm = res.discovery.bootstrap.adapters.find((a) => a.name === "sitemap");
  assert.ok(sm.rejected >= 1, "blocked candidate counted as rejected");
  assert.equal(sm.enqueued, 1);
  assert.deepEqual(res.documents.map((d) => d.url), [`${base}/page-a`]);
  assert.ok(![...frontier.state.values()].some((r) => String(r.url).includes("blocked.test")));
});

test("important domains are prioritised, but ordinary domains stay discoverable", async () => {
  const registry = reg();
  await registry.init();
  await registry.registerDomain("ordinary.test", {});
  await registry.registerDomain("important.test", {});
  await registry.setImportant("important.test", true);

  const recordFetches = () => {
    const seen = [];
    const fn = async (url) => {
      seen.push(url);
      if (url.endsWith("/robots.txt")) return "";
      throw new Error("stop"); // sitemap/feed fetches fail fast; URL is still recorded
    };
    fn.seen = seen;
    return fn;
  };

  // Root cap 1 => only the important domain's root is used.
  const capped = recordFetches();
  await new DiscoveryService({ frontier: tmpFrontier(), seeds: [], fetchText: capped, maxRoots: 1, policy: openPolicy(), domainRegistry: registry }).collect({ maxCycles: 1, allowPrivate: true });
  assert.ok(capped.seen.some((u) => u.startsWith("https://important.test/")));
  assert.ok(!capped.seen.some((u) => u.startsWith("https://ordinary.test/")));

  // Larger cap => ordinary domains are still discoverable (not excluded).
  const both = recordFetches();
  await new DiscoveryService({ frontier: tmpFrontier(), seeds: [], fetchText: both, maxRoots: 10, policy: openPolicy(), domainRegistry: registry }).collect({ maxCycles: 1, allowPrivate: true });
  assert.ok(both.seen.some((u) => u.startsWith("https://important.test/")));
  assert.ok(both.seen.some((u) => u.startsWith("https://ordinary.test/")));
});

test("a failed candidate fetch does not discard the other discovered candidates", async () => {
  const registry = reg();
  await registry.init();
  await registry.registerDomain("127.0.0.1", {});

  const fetchText = async (url) => {
    if (url === "https://127.0.0.1/robots.txt") return "Sitemap: https://127.0.0.1/sm.xml\n";
    if (url === "https://127.0.0.1/sm.xml")
      return `<urlset><url><loc>${base}/page-a</loc></url><url><loc>${base}/boom</loc></url></urlset>`;
    if (url === "https://127.0.0.1/") return "<html></html>";
    throw new Error(`unexpected ${url}`);
  };

  const service = new DiscoveryService({ frontier: tmpFrontier(), seeds: [], fetchText, policy: openPolicy(), domainRegistry: registry });
  const res = await service.collect({ maxPages: 10, maxDepth: 0, allowPrivate: true });

  assert.deepEqual(res.documents.map((d) => d.url), [`${base}/page-a`]);
  assert.ok(res.failures.some((f) => f.url === `${base}/boom`));
  assert.equal(res.frontier.total, 2, "both discovered URLs are retained; one merely failed");
});

// Regression: the DEFAULT policy is `seeds-only` (production leaves
// CRAWL_DISCOVERY_POLICY unset), and it used to seed `seedHosts` from CRAWL_URLS
// only. With an empty CRAWL_URLS that meant EVERY candidate from a registry root
// was rejected as `not-seed-host`, so the documented "registry-first bootstrap
// lets discovery run with an empty CRAWL_URLS" was false. Every other test in this
// file injects an `open` policy, which is why the bug was never caught.
test("seeds-only + empty CRAWL_URLS: registered domains are trusted bootstrap roots", async () => {
  const registry = reg();
  await registry.init();
  await registry.registerDomain("127.0.0.1", { source: "test" });

  const fetchText = async (url) => {
    if (url === "https://127.0.0.1/robots.txt") return "Sitemap: https://127.0.0.1/sitemap.xml\n";
    if (url === "https://127.0.0.1/sitemap.xml")
      return `<urlset><url><loc>${base}/page-a</loc></url></urlset>`;
    if (url === "https://127.0.0.1/") return "<html></html>";
    throw new Error(`unexpected ${url}`);
  };

  const frontier = tmpFrontier();
  // No injected policy => the constructor builds the real default one
  // (mode seeds-only, seedHosts seeded from CRAWL_URLS, which is empty here).
  const service = new DiscoveryService({ frontier, seeds: [], fetchText, domainRegistry: registry });
  const res = await service.collect({ maxPages: 10, maxDepth: 0, allowPrivate: true });

  const sm = res.discovery.bootstrap.adapters.find((a) => a.name === "sitemap");
  assert.equal(sm.rejected, 0, "no candidate is rejected as not-seed-host");
  assert.equal(sm.enqueued, 1, "the registry-root candidate is trusted under seeds-only");
  assert.deepEqual(res.documents.map((d) => d.url), [`${base}/page-a`]);
  assert.equal(res.discovery.status, "ok");
  assert.equal(res.discovery.via, "registry");
});

test("a denied domain can never be re-enabled by addSeedHosts", () => {
  const policy = createDiscoveryPolicy({
    seedUrls: [],
    deniedDomains: ["blocked.test"],
    mode: "seeds-only",
  });
  // Even the operator trusting the host as a bootstrap root must not override a block.
  policy.addSeedHosts(["blocked.test", "allowed.test"]);
  assert.equal(policy.decide("https://blocked.test/x").allowed, false);
  assert.equal(policy.decide("https://blocked.test/x").reason, "denied-domain");
  assert.equal(policy.decide("https://allowed.test/x").allowed, true);
});

// A virgin host (no CRAWL_URLS, no CRAWL_DISCOVERY_SEEDS, empty registry) used to
// report `no-source-configured` because the sitemap/feed adapters need a root and
// there was none. The built-in default-seed fallback gives the FIRST cycle
// something to discover from so the domain registry can get populated.
test("virgin host: the default-seed fallback bootstraps the first cycle", async () => {
  // fetchText is used ONLY by the adapters (robots/sitemap). The documents
  // themselves are fetched by the real crawler over HTTP.
  const fetchText = async (url) => {
    if (url === `${base}/robots.txt`) return `Sitemap: ${base}/sitemap.xml\n`;
    if (url === `${base}/sitemap.xml`)
      return `<urlset><url><loc>${base}/page-b</loc></url></urlset>`;
    throw new Error(`unexpected ${url}`);
  };

  const service = new DiscoveryService({
    frontier: tmpFrontier(),
    seeds: [],
    discoverySeeds: [],
    defaultSeeds: [`${base}/page-a`], // enqueued AND used as a root
    fetchText,
    policy: openPolicy(),
    domainRegistry: reg(),
  });
  const res = await service.collect({ maxPages: 10, maxDepth: 0, allowPrivate: true });

  assert.equal(res.discovery.status, "ok");
  assert.equal(res.discovery.via, "default-seeds");
  assert.equal(res.discovery.bootstrap.defaultSeeds, 1);
  // The default seed page is fetched directly, and its sitemap yields another page.
  assert.deepEqual(res.documents.map((d) => d.url).sort(), [`${base}/page-a`, `${base}/page-b`].sort());
});

test("the default-seed fallback is ignored when another source already yields roots", async () => {
  const registry = reg();
  await registry.init();
  await registry.registerDomain("127.0.0.1", {});

  const fetchText = async (url) => {
    if (url === "https://127.0.0.1/robots.txt") return "Sitemap: https://127.0.0.1/sitemap.xml\n";
    if (url === "https://127.0.0.1/sitemap.xml")
      return `<urlset><url><loc>${base}/page-a</loc></url></urlset>`;
    if (url === "https://127.0.0.1/") return "<html></html>";
    throw new Error(`unexpected ${url}`);
  };

  const service = new DiscoveryService({
    frontier: tmpFrontier(),
    seeds: [],
    discoverySeeds: [],
    defaultSeeds: [`${base}/`], // present, but must not be used
    fetchText,
    policy: openPolicy(),
    domainRegistry: registry,
  });
  const res = await service.collect({ maxPages: 10, maxDepth: 0, allowPrivate: true });

  assert.equal(res.discovery.via, "registry");
  assert.equal(res.discovery.bootstrap.defaultSeeds, 0, "fallback skipped when the registry has roots");
  assert.deepEqual(res.documents.map((d) => d.url), [`${base}/page-a`]);
});

test("the default-seed fallback can be disabled (empty defaultSeeds)", async () => {
  const service = new DiscoveryService({
    frontier: tmpFrontier(),
    seeds: [],
    discoverySeeds: [],
    defaultSeeds: [],
    adapters: [],
    policy: openPolicy(),
    domainRegistry: reg(),
  });
  const res = await service.collect({ allowPrivate: true });
  assert.equal(res.discovery.status, "no-source-configured");
});

test("CRAWL_DISCOVERY_SEEDS are enqueued and become bootstrap roots", async () => {
  // Regression: ensure discovery seeds are enqueued as documents, not just
  // used as adapter roots. A host that only sets CRAWL_DISCOVERY_SEEDS
  // (and not CRAWL_URLS) must still be able to fetch documents, otherwise
  // every cycle ends `sourceExhausted: true` regardless of target.
  const fetchText = async (url) => {
    if (url === `${base}/robots.txt`) return `Sitemap: ${base}/sitemap.xml\n`;
    if (url === `${base}/sitemap.xml`)
      return `<urlset><url><loc>${base}/page-b</loc></url></urlset>`;
    throw new Error(`unexpected ${url}`);
  };

  const service = new DiscoveryService({
    frontier: tmpFrontier(),
    seeds: [],
    discoverySeeds: [`${base}/page-a`],
    defaultSeeds: [],
    fetchText,
    policy: openPolicy(),
    domainRegistry: reg(),
  });
  const res = await service.collect({ maxPages: 10, maxDepth: 0, allowPrivate: true });

  // The seeds should be counted in the bootstrap report.
  assert.equal(res.discovery.bootstrap.bootstrapSeeds, 1,
    "discoverySeeds counted in bootstrap");
  // Seeds should have been enqueued into the frontier (not just used as adapter roots).
  assert.ok(res.frontier.total > 0, "discoverySeeds enqueued into frontier");
  // At least one document should be fetched from the seeds.
  assert.ok(res.documents.length > 0, "discoverySeeds fetched as documents");
  // With only discoverySeeds set (no CRAWL_URLS), via is "bootstrap-seeds".
  assert.equal(res.discovery.via, "bootstrap-seeds", "via should be bootstrap-seeds");
});
