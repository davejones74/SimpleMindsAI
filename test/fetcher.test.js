import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fetchDocument, assertUrlAllowed, parseRobots, robotsAllows, isPrivateIp, contentHashFor, FetchError } from "../src/harness/fetcher.js";
import { collectDocuments, classifyCrawlMode, harvest, CAPABILITY } from "../src/harness/crawler.js";
import { createDomainRegistry } from "../src/storage/domain-registry.js";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nDisallow: /private\n");
    } else if (url.pathname === "/page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><head><title>Hello   World</title><style>x{}</style></head><body><h1>Hi</h1><p>Some &amp; text.</p><script>bad()</script></body></html>");
    } else if (url.pathname === "/redirect") {
      res.writeHead(302, { location: "/page" });
      res.end();
    } else if (url.pathname === "/big") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("x".repeat(10_000));
    } else if (url.pathname === "/binary") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.from([0, 1, 2, 3]));
    } else if (url.pathname === "/private") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("secret");
    } else if (url.pathname === "/slow") {
      setTimeout(() => { res.writeHead(200, { "content-type": "text/plain" }); res.end("late"); }, 500);
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("nope");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

test("assertUrlAllowed: scheme + SSRF guard", async () => {
  await assert.rejects(() => assertUrlAllowed("ftp://example.com/x"), (e) => e instanceof FetchError && e.code === "FETCH_BAD_SCHEME");
  await assert.rejects(() => assertUrlAllowed("http://127.0.0.1/x"), (e) => e.code === "FETCH_PRIVATE_ADDRESS");
  await assert.rejects(() => assertUrlAllowed("http://localhost/x"), (e) => e.code === "FETCH_PRIVATE_ADDRESS");
  assert.equal(isPrivateIp("10.0.0.1"), true);
  assert.equal(isPrivateIp("192.168.1.5"), true);
  assert.equal(isPrivateIp("172.16.0.1"), true);
  assert.equal(isPrivateIp("172.32.0.1"), false);
  assert.equal(isPrivateIp("8.8.8.8"), false);
  assert.equal(isPrivateIp("::1"), true);
  // allowPrivate opt-in lets tests reach loopback
  assert.ok(await assertUrlAllowed(`${base}/page`, { allowPrivate: true }));
});

test("fetchDocument: extracts title + text, decodes entities, strips scripts", async () => {
  const doc = await fetchDocument(`${base}/page`, { allowPrivate: true });
  assert.equal(doc.title, "Hello World");
  assert.match(doc.text, /Some & text\./);
  assert.doesNotMatch(doc.text, /bad\(\)/);
  assert.equal(doc.redirects, 0);
  assert.equal(doc.contentHash, contentHashFor(doc.text));
  assert.equal(doc.contentHash.length, 64);
});

test("fetchDocument: follows redirects to the final URL", async () => {
  const doc = await fetchDocument(`${base}/redirect`, { allowPrivate: true });
  assert.equal(doc.url, `${base}/page`);
  assert.equal(doc.redirects, 1);
});

test("fetchDocument: enforces byte cap, content-type, and timeout", async () => {
  await assert.rejects(() => fetchDocument(`${base}/big`, { allowPrivate: true, maxBytes: 100 }), (e) => e.code === "FETCH_TOO_LARGE");
  await assert.rejects(() => fetchDocument(`${base}/binary`, { allowPrivate: true }), (e) => e.code === "FETCH_BAD_CONTENT_TYPE");
  await assert.rejects(() => fetchDocument(`${base}/slow`, { allowPrivate: true, timeoutMs: 50 }), (e) => e.code === "FETCH_TIMEOUT");
});

test("robots: parse + longest-match allow/disallow", () => {
  const groups = parseRobots("User-agent: *\nDisallow: /private\nAllow: /private/open\n\nUser-agent: Bot\nDisallow: /\n");
  assert.equal(robotsAllows(groups, "/private/x", "SimpleMindsAI"), false);
  assert.equal(robotsAllows(groups, "/private/open", "SimpleMindsAI"), true);
  assert.equal(robotsAllows(groups, "/public", "SimpleMindsAI"), true);
  assert.equal(robotsAllows(parseRobots(""), "/anything", "SimpleMindsAI"), true);
});

test("classifyCrawlMode: fail-closed, never guesses", () => {
  assert.throws(() => classifyCrawlMode({ mode: "real", urls: [] }), /requires CRAWL_URLS/);
  assert.throws(() => classifyCrawlMode({ mode: "wut", urls: [] }), /unknown CRAWL_MODE/);
  assert.equal(classifyCrawlMode({ mode: "fixture" }).capability, CAPABILITY.fixture);
  assert.equal(classifyCrawlMode({ mode: "real", urls: ["https://x.test/a"] }).capability, CAPABILITY.real);
});

test("collectDocuments: fixture mode labels capability and needs no network", async () => {
  const res = await collectDocuments({ mode: "fixture" });
  assert.equal(res.mode, "fixture");
  assert.equal(res.capability, CAPABILITY.fixture);
  assert.ok(res.documents.length >= 1);
  assert.ok(res.documents.every((d) => d.capability === CAPABILITY.fixture && d.crawlMode === "fixture"));
});

test("collectDocuments: real mode records successes and labelled failures", async () => {
  const res = await collectDocuments({
    mode: "real",
    urls: [`${base}/page`, `${base}/private`, `${base}/binary`],
    allowPrivate: true,
    respectRobots: true,
  });
  assert.equal(res.capability, CAPABILITY.real);
  assert.equal(res.documents.length, 1);
  assert.equal(res.documents[0].capability, CAPABILITY.real);
  assert.equal(res.documents[0].crawlMode, "real");
  assert.equal(res.documents[0].text.includes("Some & text"), true);
  const reasons = res.failures.map((f) => f.reason);
  assert.ok(reasons.includes("robots-disallowed"));       // /private
  assert.ok(reasons.includes("FETCH_BAD_CONTENT_TYPE"));  // /binary
});

test("harvest: writes corpus + failures files with capability labels", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sma-crawl-"));
  // Harvest writes discovered domains to a registry; give it an isolated one so
  // the test can never touch the configured live registry (data/frontier).
  const domainRegistry = createDomainRegistry({ dir: mkdtempSync(path.join(tmpdir(), "sma-crawl-reg-")), forceNew: true });
  const res = await harvest({ dir, mode: "real", urls: [`${base}/page`, `${base}/private`], allowPrivate: true, respectRobots: true, domainRegistry });
  assert.ok(existsSync(res.file));
  assert.ok(res.failuresFile && existsSync(res.failuresFile));
  const line = JSON.parse(readFileSync(res.file, "utf8").trim().split("\n")[0]);
  assert.equal(line.capability, CAPABILITY.real);
  assert.equal(line.crawlMode, "real");
  assert.equal(typeof line.text, "string");
  const failed = JSON.parse(readFileSync(res.failuresFile, "utf8").trim().split("\n")[0]);
  assert.equal(failed.crawlMode, "real");
  assert.equal(failed.capability, CAPABILITY.real);

  const fx = await harvest({ dir, mode: "fixture" });
  const fxLine = JSON.parse(readFileSync(fx.file, "utf8").trim().split("\n")[0]);
  assert.equal(fxLine.capability, CAPABILITY.fixture);
});
