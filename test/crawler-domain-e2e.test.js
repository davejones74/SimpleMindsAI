import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Frontier } from "../src/frontier.js";
import { createDomainRegistry } from "../src/storage/domain-registry.js";
import { runCrawlBatches } from "../src/harness/crawler.js";
import { createDiscoveryPolicy } from "../src/discovery/discovery-policy.js";

let seedServer; // seed origin + N same-host child pages, links to one cross-host page
let external; // a DIFFERENT hostname, linked from the seed page
let seedOrigin;
let externalOrigin;

const PAGES = 6;

before(async () => {
  external = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<html><body>cross host body with prose</body></html>");
  });
  await new Promise((r) => external.listen(0, "127.0.0.1", r));
  externalOrigin = `http://localhost:${external.address().port}`;

  seedServer = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    if (url.pathname === "/seed") {
      const links = Array.from({ length: PAGES }, (_, i) => `<a href="/page${i}">p</a>`);
      // localhost is a different hostname from 127.0.0.1, so this is a genuine
      // cross-host discovery rather than another path on the seed origin.
      const cross = `<a href="${externalOrigin}/ext">x</a>`;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<html><body>${links.join("")}${cross}</body></html>`);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<html><body>child page body</body></html>");
  });
  await new Promise((r) => seedServer.listen(0, "127.0.0.1", r));
  seedOrigin = `http://127.0.0.1:${seedServer.address().port}`;
});

after(async () => {
  await new Promise((r) => seedServer.close(r));
  await new Promise((r) => external.close(r));
});

/**
 * A real crawl through the real acquisition pipeline: seed page -> same-host
 * children + a cross-host page. Every host the crawler meets must be registered,
 * the registry must be durable and reloadable, and a policy change must survive
 * the restart that follows.
 */
test("crawler: discovery registers hosts, persists durably, and reloads cleanly", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sma-e2e-"));
  const registry = createDomainRegistry({ dir: `${dir}-r`, forceNew: true });
  const frontier = new Frontier({ dir: `${dir}-f` });
  await registry.init();
  await frontier.init();
  await frontier.enqueue(`${seedOrigin}/seed`, { depth: 0, seed: `${seedOrigin}/seed` });

  const result = await runCrawlBatches({
    frontier,
    domainRegistry: registry,
    maxCycles: PAGES + 4,
    maxDepth: 2,
    allowPrivate: true,
    policy: createDiscoveryPolicy({ seedUrls: [`${seedOrigin}/seed`], mode: "open" }),
  });

  assert.equal(result.failures.length, 0, "no fetch failures");

  // The seed page and its same-host children are all fetched.
  assert.ok(result.documents.some((d) => d.url.endsWith("/seed")), "the seed is fetched");
  assert.ok(
    result.documents.some((d) => /\/page\d+$/.test(d.url)),
    "same-host children were followed and fetched",
  );
  assert.ok(
    result.documents.some((d) => d.url.startsWith(externalOrigin)),
    "the cross-host page was followed and fetched",
  );

  // BOTH hosts the crawler met are in the registry — the crawler expanded past
  // its seed instead of staying inside it.
  const hosts = registry.list().map((d) => d.domain);
  assert.ok(hosts.includes("127.0.0.1"), `seed host registered (got: ${hosts.join(", ")})`);
  assert.ok(
    hosts.includes("localhost"),
    `cross host registered — the crawler expanded past its seed (got: ${hosts.join(", ")})`,
  );

  // Counters come from real outcomes, not from discovery alone.
  const cross = registry.get("localhost");
  assert.ok(cross.urlsDiscovered >= 1, "discovery counted");
  assert.equal(cross.documentsFetched >= 1, true, "and a real document was stored");
  const seedHost = registry.get("127.0.0.1");
  assert.equal(seedHost.documentsFetched >= PAGES, true, "seed host stored its children");

  // No debris from a failed or interleaved write.
  assert.deepEqual(readdirSync(`${dir}-r`).filter((f) => f.includes(".tmp")), []);

  // Reload: every recorded domain must come back.
  const reloaded = createDomainRegistry({ dir: `${dir}-r` });
  await reloaded.init();
  assert.equal(reloaded.list().length, registry.list().length, "no domain lost on reload");
  assert.ok(reloaded.get("127.0.0.1"), "seed host survives reload");
  assert.ok(reloaded.get("localhost"), "cross host survives reload");

  // An operator policy change must survive the restart that follows.
  await registry.registerDomain("blockme.test");
  await registry.blockDomain("blockme.test", { reason: "e2e" });
  const afterRestart = createDomainRegistry({ dir: `${dir}-r` });
  await afterRestart.init();
  assert.equal(afterRestart.get("blockme.test").policy, "blocked");
});

/**
 * Equivalent content behind two URLs is ONE source by content identity, while
 * both URLs keep their own URL-level identity. The frontier is URL-keyed (so
 * both get fetched); a content-keyed source ledger must treat them as one.
 */
test("crawler: identical raw content behind two URLs is one source, not two", async () => {
  const body = "<html><body>identical body</body></html>";
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const origin = `http://127.0.0.1:${srv.address().port}`;

    const dir = mkdtempSync(path.join(tmpdir(), "sma-e2e-dup"));
    const frontier = new Frontier({ dir: `${dir}-f` });
    const registry = createDomainRegistry({ dir: `${dir}-r`, forceNew: true });
    await registry.init();
    await frontier.init();
    // Same body, two distinct URLs.
    await frontier.enqueue(`${origin}/a`, { depth: 0 });
    await frontier.enqueue(`${origin}/b`, { depth: 0 });

    const seen = [];
    for (let i = 0; i < 2; i++) {
      const res = await runCrawlBatches({
        frontier,
        domainRegistry: registry,
        maxCycles: 1,
        maxDepth: 1,
        allowPrivate: true,
        policy: createDiscoveryPolicy({ mode: "open" }),
      });
      seen.push(...res.documents);
    }

    assert.equal(seen.length, 2, "both URLs are fetched — the frontier is URL-keyed");
    const hashes = new Set(seen.map((d) => d.contentHash));
    assert.equal(hashes.size, 1, "but they share one content hash, i.e. one raw source");

    // This fixture is deliberately linkless, so the crawler never has to decide
    // about a host — and must not invent one. Registration is driven by links
    // the crawler actually extracts, not by the frontier construction.
    assert.equal(registry.get("127.0.0.1"), null, "a linkless page registers no domain");
  } finally {
    srv.close();
  }

  // A page that LINKS OUT is a genuine discovery signal: the host of the page
  // and the host of the link are both registered, with counters from real
  // fetches. This is the mechanism that expands the corpus past the seeds.
  const linking = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end('<html><body>root page body with a <a href="/child">child link</a></body></html>');
  });
  await new Promise((r) => linking.listen(0, "127.0.0.1", r));
  try {
    const origin = `http://127.0.0.1:${linking.address().port}`;
    const dir2 = mkdtempSync(path.join(tmpdir(), "sma-e2e-link"));
    const f2 = new Frontier({ dir: `${dir2}-f` });
    const r2 = createDomainRegistry({ dir: `${dir2}-r`, forceNew: true });
    await r2.init();
    await f2.init();
    await f2.enqueue(`${origin}/`, { depth: 0 });

    const res = await runCrawlBatches({
      frontier: f2,
      domainRegistry: r2,
      maxCycles: 3,
      maxDepth: 2,
      allowPrivate: true,
      policy: createDiscoveryPolicy({ mode: "open" }),
    });

    const rec = r2.get("127.0.0.1");
    assert.ok(rec, "the host of a page that links out is registered");
    assert.equal(rec.urlsDiscovered >= 1, true, "the link was discovered");
    assert.equal(rec.documentsFetched >= 1, true, "and a real document was stored");
    assert.ok(
      res.documents.some((d) => d.url.endsWith("/child")),
      "the discovered link was fetched",
    );
  } finally {
    linking.close();
  }
});
