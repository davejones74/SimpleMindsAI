import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Frontier } from "../src/frontier.js";
import { createDiscoveryPolicy } from "../src/discovery/discovery-policy.js";
import { DiscoveryService } from "../src/discovery/discovery-service.js";
import { createDomainRegistry } from "../src/storage/domain-registry.js";

// Each test gets its own registry on disk: discovery must never write into the
// configured live registry (data/frontier) just because a test drove a crawl.
function isolatedRegistry() {
  return createDomainRegistry({ dir: mkdtempSync(path.join(tmpdir(), "sma-disc-reg-")), forceNew: true });
}

let serverA;
let serverB;
let originA; // http://127.0.0.1:PORT
let originB; // http://localhost:PORT  (different HOSTNAME from A)
let hostA;   // 127.0.0.1:PORT

before(async () => {
  serverA = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
    } else if (url.pathname === "/seed") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<html><body><a href="/local">local</a><a href="http://localhost:${serverB.address().port}/page">external</a></body></html>`);
    } else if (url.pathname === "/local") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><body>local content</body></html>");
    } else {
      res.writeHead(404); res.end("nope");
    }
  });
  serverB = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
    } else if (url.pathname === "/page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><body>external page body</body></html>");
    } else {
      res.writeHead(404); res.end("nope");
    }
  });
  await new Promise((r) => serverA.listen(0, "127.0.0.1", r));
  await new Promise((r) => serverB.listen(0, "127.0.0.1", r));
  hostA = `127.0.0.1:${serverA.address().port}`;
  originA = `http://${hostA}`;
  originB = `http://localhost:${serverB.address().port}`;
});

after(async () => {
  await new Promise((r) => serverA.close(r));
  await new Promise((r) => serverB.close(r));
});

test("createDiscoveryPolicy: seeds-only, open, allowlist, denied", () => {
  const seeds = ["https://en.wikipedia.org/wiki/Steam_engine"];

  const strict = createDiscoveryPolicy({ seedUrls: seeds, mode: "seeds-only" });
  assert.equal(strict.decide("https://en.wikipedia.org/wiki/James_Watt").allowed, true);
  assert.equal(strict.decide("https://en.wikipedia.org/wiki/James_Watt").trust, "seed");
  assert.equal(strict.decide("https://other.example/a").allowed, false);
  assert.equal(strict.decide("https://other.example/a").reason, "not-seed-host");

  const open = createDiscoveryPolicy({ seedUrls: seeds, mode: "open" });
  assert.equal(open.decide("https://other.example/a").allowed, true);
  assert.equal(open.decide("https://other.example/a").trust, "discovered");

  const allow = createDiscoveryPolicy({ seedUrls: seeds, mode: "allowlist", allowedDomains: ["other.example"] });
  assert.equal(allow.decide("https://sub.other.example/a").allowed, true);
  assert.equal(allow.decide("https://nope.example/a").allowed, false);

  const denied = createDiscoveryPolicy({ seedUrls: seeds, mode: "open", deniedDomains: ["blocked.example"] });
  assert.equal(denied.decide("https://blocked.example/a").allowed, false);
  assert.equal(denied.decide("https://blocked.example/a").reason, "denied-domain");
  // denied always wins, even for a seed host
  const deniedSeed = createDiscoveryPolicy({ seedUrls: seeds, deniedDomains: ["en.wikipedia.org"] });
  assert.equal(deniedSeed.decide(seeds[0]).allowed, false);
});

test("DiscoveryService (open): follows links beyond the seed host and records provenance", async () => {
  const frontier = new Frontier({ dir: mkdtempSync(path.join(tmpdir(), "sma-disc-")) });
  const service = new DiscoveryService({
    frontier,
    seeds: [`${originA}/seed`],
    policy: createDiscoveryPolicy({ seedUrls: [`${originA}/seed`], mode: "open" }),
    domainRegistry: isolatedRegistry(),
  });
  const res = await service.collect({ maxPages: 3, maxDepth: 1, allowPrivate: true });
  const urls = res.documents.map((d) => d.url).sort();
  assert.ok(urls.some((u) => u === `${originA}/seed`), "seed fetched");
  assert.ok(urls.some((u) => u === `${originA}/local`), "same-host link followed");
  assert.ok(urls.some((u) => u === `${originB}/page`), "cross-host link followed (seed is bootstrap, not a boundary)");
  assert.equal(res.documents.length, 3);
  const external = res.documents.find((d) => d.url === `${originB}/page`);
  assert.equal(external.discovery.depth, 1);
  assert.equal(external.capability, "configured-fetch");
  assert.ok(external.contentHash && external.contentHash.length === 64);
});

test("DiscoveryService (seeds-only): refuses cross-host expansion but follows same-host links", async () => {
  const frontier = new Frontier({ dir: mkdtempSync(path.join(tmpdir(), "sma-disc-")) });
  const service = new DiscoveryService({
    frontier,
    seeds: [`${originA}/seed`],
    policy: createDiscoveryPolicy({ seedUrls: [`${originA}/seed`], mode: "seeds-only" }),
    domainRegistry: isolatedRegistry(),
  });
  const res = await service.collect({ maxPages: 5, maxDepth: 1, allowPrivate: true });
  const urls = res.documents.map((d) => d.url);
  assert.ok(urls.includes(`${originA}/seed`));
  assert.ok(urls.includes(`${originA}/local`));
  assert.ok(!urls.includes(`${originB}/page`), "cross-host URL must not be fetched in seeds-only mode");
  assert.ok(res.discovered.some((d) => d.url === `${originB}/page` && d.accepted === false));
});

test("DiscoveryService: a second cycle fetches only newly discovered URLs (no re-fetch)", async () => {
  const frontier = new Frontier({ dir: mkdtempSync(path.join(tmpdir(), "sma-disc-")) });
  const service = new DiscoveryService({
    frontier,
    seeds: [`${originA}/seed`],
    policy: createDiscoveryPolicy({ seedUrls: [`${originA}/seed`], mode: "open" }),
    domainRegistry: isolatedRegistry(),
  });
  const first = await service.collect({ maxPages: 1, maxDepth: 1, allowPrivate: true });
  assert.equal(first.documents.length, 1);
  const second = await service.collect({ maxPages: 5, maxDepth: 1, allowPrivate: true });
  assert.ok(!second.documents.some((d) => d.url === `${originA}/seed`), "seed must not be re-fetched");
  assert.ok(second.documents.length >= 2);
});

/**
 * PERSISTED-FRONTIER CONTINUITY.
 *
 * CRAWL_URLS is bootstrap input, not a boundary, and an empty seed list is not a
 * reason to throw away work already queued. Pending frontier entries are
 * legitimate persisted discovery work and must be resumed after a config change
 * or a process restart — never silently deleted.
 */
test("DiscoveryService: empty seeds resumes persisted frontier work instead of clearing it", async () => {
  // A frontier left over from a previous configuration.
  const dir = mkdtempSync(path.join(tmpdir(), "sma-disc-"));
  const frontier = new Frontier({ dir });
  await frontier.init();
  await frontier.enqueue(`${originA}/seed`, { depth: 0, seed: `${originA}/seed` });
  await frontier.enqueue(`${originA}/local`, { depth: 0 });
  assert.equal(frontier.state.size, 2, "frontier starts with the previous run's URLs");

  const service = new DiscoveryService({
    frontier,
    seeds: [],
    defaultSeeds: [], // isolate frontier-resume from the bootstrap fallback
    adapters: [], // no adapter capability in this test
    policy: createDiscoveryPolicy({ seedUrls: [], mode: "open" }),
    domainRegistry: isolatedRegistry(),
  });
  const res = await service.collect({ maxPages: 5, maxDepth: 0, allowPrivate: true });

  const urls = res.documents.map((d) => d.url).sort();
  assert.deepEqual(urls, [`${originA}/local`, `${originA}/seed`], "persisted frontier work is resumed");
  assert.equal(res.discovery.status, "ok", "pending work is a real source, not a dead end");
  assert.ok(frontier.state.size >= 2, "entries are not discarded");
  assert.equal(frontier.summary().visited, 2);
});
