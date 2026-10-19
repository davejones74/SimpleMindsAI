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
 * Slice 3 — the discovery language prior applies to EXTRACTED LINKS, not only to
 * adapter candidates. A link whose host declares a non-English language is
 * refused under `reject`, counted under `warn`, and ignored under `off`. Only
 * loopback is fetched (the seed); the linked hosts are never contacted.
 */

let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    if (p === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
    } else if (p === "/seed") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        `<html><body>` +
          `<a href="https://ca.wikipedia.org/wiki/Foo">foreign</a>` +
          `<a href="https://example.com/ok">neutral</a>` +
          `</body></html>`,
      );
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

async function runCycle(prior) {
  const frontier = new Frontier({ dir: mkdtempSync(path.join(tmpdir(), "sma-langprior-")) });
  await frontier.init();
  await frontier.enqueue(`${base}/seed`, { depth: 0 });
  const summary = await runCrawlCycle({
    frontier,
    domainRegistry: null,
    policy: createDiscoveryPolicy({ seedUrls: [], mode: "open" }),
    allowPrivate: true,
    maxDepth: 2,
    discoveryLanguagePrior: prior,
  });
  return { frontier, summary };
}

test("reject: a foreign-language link is refused before it enters the frontier", async () => {
  const { frontier, summary } = await runCycle("reject");
  assert.equal(summary.pagesFetched, 1);
  assert.equal(summary.languagePriorRejected, 1);
  assert.equal(frontier.has("https://ca.wikipedia.org/wiki/Foo"), false);
  assert.equal(frontier.has("https://example.com/ok"), true);
});

test("warn: a foreign-language link is counted but still enqueued (expansive)", async () => {
  const { frontier, summary } = await runCycle("warn");
  assert.equal(summary.languagePriorWarned, 1);
  assert.equal(summary.languagePriorRejected, 0);
  assert.equal(frontier.has("https://ca.wikipedia.org/wiki/Foo"), true);
});

test("off: the declared language is ignored entirely", async () => {
  const { frontier, summary } = await runCycle("off");
  assert.equal(summary.languagePriorWarned, 0);
  assert.equal(summary.languagePriorRejected, 0);
  assert.equal(frontier.has("https://ca.wikipedia.org/wiki/Foo"), true);
});
