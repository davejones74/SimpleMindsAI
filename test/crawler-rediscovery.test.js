import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Frontier } from "../src/frontier.js";
import { runCrawlCycle } from "../src/harness/crawler.js";
import { createDiscoveryPolicy } from "../src/discovery/discovery-policy.js";

/**
 * Slice 4 end-to-end: a rediscovery fetch is conditional (If-None-Match). When
 * the server answers 304 the page is NOT re-emitted as a document (no duplicate
 * article), its contentHash/validators are retained, and its rediscovery
 * deadline is pushed out again.
 */

let server;
let base;
let etagHits = 0;

before(async () => {
  server = http.createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    if (p === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
    } else if (p === "/seed") {
      if (req.headers["if-none-match"] === '"v1"') {
        etagHits++;
        res.writeHead(304, { etag: '"v1"' });
        res.end();
      } else {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", etag: '"v1"' });
        res.end("<html><body>Hello world</body></html>");
      }
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

test("rediscovery: conditional fetch returns 304 and emits no duplicate document", async () => {
  const frontier = new Frontier({ dir: mkdtempSync(path.join(tmpdir(), "sma-redisc-")) });
  await frontier.init();
  const key = await frontier.enqueue(`${base}/seed`, { depth: 0 });

  const ctx = {
    frontier,
    domainRegistry: null,
    policy: createDiscoveryPolicy({ seedUrls: [], mode: "open" }),
    allowPrivate: true,
    maxDepth: 2,
    discoveryLanguagePrior: "off",
    rediscoveryEnabled: true,
    rediscoveryTtlMs: 5,
  };

  // First fetch: 200, one document, validators stored.
  const first = await runCrawlCycle(ctx);
  assert.equal(first.pagesFetched, 1);
  assert.equal(first.documents.length, 1);
  assert.equal(first.notModified, 0);
  const rec1 = frontier.state.get(key);
  assert.equal(rec1.etag, '"v1"');
  assert.ok(rec1.nextCrawlAt, "rediscovery is scheduled");

  // TTL elapses.
  await new Promise((r) => setTimeout(r, 20));

  // Rediscovery fetch: conditional → 304, no document, hash retained.
  const second = await runCrawlCycle(ctx);
  assert.equal(second.rediscoveries, 1);
  assert.equal(second.notModified, 1);
  assert.equal(second.documents.length, 0, "unchanged content is not re-emitted");
  assert.ok(etagHits >= 1, "server saw the If-None-Match validator");
  const rec2 = frontier.state.get(key);
  assert.equal(rec2.state, "visited");
  assert.equal(rec2.contentHash, rec1.contentHash, "content hash is retained on 304");
  assert.equal(rec2.rediscoveries, 1);
  assert.ok(new Date(rec2.nextCrawlAt).getTime() > new Date(rec1.nextCrawlAt).getTime() - 1);
});
