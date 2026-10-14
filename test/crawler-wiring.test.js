import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Frontier } from "../src/frontier.js";
import { runCrawlCycle, runCrawlBatches } from "../src/harness/crawler.js";
import { config } from "../src/config.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nAllow: /\n");
    } else if (url.pathname === "/page") {
      const origin = `http://${req.headers.host}`;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<html><body><h1>Hi</h1><a href="${origin}/next">next</a></body></html>`);
    } else if (url.pathname === "/next") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><body><p>next page</p></body></html>");
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("nope");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

function freshFrontier() {
  const dir = mkdtempSync(path.join(tmpdir(), "sma-frontier-"));
  return new Frontier({ dir });
}

test("runCrawlCycle: fetches a claimed URL without a ReferenceError, and persists frontier state", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sma-frontier-"));
  const frontier = new Frontier({ dir });
  await frontier.init();
  await frontier.enqueue(`${base}/page`);
  await frontier.enqueue(`${base}/next`);
  const summary = await runCrawlCycle({ frontier, allowPrivate: true, maxDepth: 1 });
  assert.equal(summary.pagesFetched, 1);
  assert.equal(summary.errors, 0);
  const state = frontier.summary();
  assert.equal(state.visited, 1);
  assert.equal(state.queued, 1);

  // Persistence must survive a process restart (`rename` regression: persist
  // previously threw ReferenceError, so the frontier could never be written).
  const reloaded = new Frontier({ dir });
  await reloaded.init();
  assert.equal(reloaded.summary().total, 2);
  assert.equal(reloaded.summary().visited, 1);
});

test("runCrawlBatches: runs bounded cycles and forwards safety options (undefined maxPages regression)", async () => {
  const frontier = freshFrontier();
  await frontier.init();
  await frontier.enqueue(`${base}/page`);
  await frontier.enqueue(`${base}/next`);
  const res = await runCrawlBatches({ frontier, maxCycles: 5, maxDepth: 1, allowPrivate: true });
  assert.ok(res.totalPagesFetched >= 2, `expected >=2 pages, got ${res.totalPagesFetched}`);
});

test("learning job uses the CONFIGURED crawl mode, not a hard-coded fixture (integration seam)", () => {
  // Proves the exact defect: with CRAWL_MODE=real + CRAWL_URLS set, the context
  // handed to the collector must be `real` with the configured URLs — previously
  // it was `{}` and collectDocuments hard-coded fixture mode.
  const script = `
    import { runLearningCycle } from "./src/jobs/learning.js";
    let seen = null;
    const store = {
      ingestArticle: async () => ({ deduped: false }),
      selectForReview: async () => {},
      reviewQueue: () => ({ items: [] }),
      getStats: () => ({ trainable: 0 }),
    };
    await runLearningCycle({
      store,
      ollama: { model: "x", clean: async () => [] },
      scorer: { scoreOffline: async () => ({}) },
      collectDocuments: async (ctx) => {
        seen = ctx;
        return { mode: "real", capability: "configured-fetch", documents: [], failures: [] };
      },
    });
    process.stdout.write(JSON.stringify(seen));
  `;
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      cwd: root,
      env: {
        ...process.env,
        NODE_TEST_CONTEXT: "",
        SMA_SKIP_ENV_FILE: "",
        CRAWL_MODE: "real",
        CRAWL_URLS: "https://example.test/a,https://example.test/b",
      },
      encoding: "utf8",
    },
  );
  const seen = JSON.parse(out);
  assert.equal(seen.mode, "real");
  assert.deepEqual(seen.urls, ["https://example.test/a", "https://example.test/b"]);
  assert.equal(seen.respectRobots, true);
});

test("supervisor.effectiveCrawl reports config when no discovery is wired", async () => {
  const { JobSupervisor } = await import("../src/jobs/supervisor.js");
  const sup = new JobSupervisor({ store: {}, registry: {} });
  const eff = sup.effectiveCrawl();
  assert.equal(eff.mode, config.crawlMode);
  assert.equal(eff.source, "config");
});

test("supervisor.effectiveCrawl reports the wired discovery mode (honest resolved config)", async () => {
  const { JobSupervisor } = await import("../src/jobs/supervisor.js");
  const sup = new JobSupervisor({ store: {}, registry: {}, crawl: { mode: "real", urls: ["https://x.test/a"] } });
  const eff = sup.effectiveCrawl();
  assert.equal(eff.mode, "real");
  assert.equal(eff.urls, 1);
  assert.equal(eff.source, "discovery");
  assert.equal(sup.snapshotResolvedConfig().crawl.mode, "real");
});
