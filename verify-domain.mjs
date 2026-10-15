import { Frontier } from "./src/frontier.js";
import { createDomainRegistry } from "./src/storage/domain-registry.js";
import { runCrawlBatches } from "./src/harness/crawler.js";
import { createDiscoveryPolicy } from "./src/discovery/discovery-policy.js";
import http from "node:http";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Seed server: one page linking to 40 same-host pages plus 1 cross-host page.
const external = http.createServer((req, res) => {
  if (new URL(req.url, "http://x").pathname === "/robots.txt") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("User-agent: *\nAllow: /\n");
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end("<html><body>cross host body with prose</body></html>");
});
await new Promise((r) => external.listen(0, "127.0.0.1", r));
const externalOrigin = `http://localhost:${external.address().port}`;

const seed = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/robots.txt") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("User-agent: *\nAllow: /\n");
    return;
  }
  if (url.pathname === "/seed") {
    const links = Array.from({ length: 40 }, (_, i) => `<a href="/page${i}">p</a>`).join("");
    const cross = `<a href="${externalOrigin}/ext">x</a>`;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<html><body>${links}${cross}</body></html>`);
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end("<html><body>child page body</body></html>");
});
await new Promise((r) => seed.listen(0, "127.0.0.1", r));
const seedOrigin = `http://127.0.0.1:${seed.address().port}`;

const dir = mkdtempSync(path.join(tmpdir(), "sma-verify-"));
const frontier = new Frontier({ dir });

// Three call sites, exactly like production: server, DiscoveryService, harvest.
const a = createDomainRegistry({ dir });
const b = createDomainRegistry({ dir });
const c = createDomainRegistry({ dir });
console.log("three call sites share ONE registry:", a === b && b === c);
const registry = a;
await registry.init();
await frontier.init();
await frontier.enqueue(seedOrigin, { depth: 0, seed: seedOrigin });
await registry.registerDomain(new URL(seedOrigin).hostname, { source: "seed" });

const result = await runCrawlBatches({
  frontier,
  domainRegistry: registry,
  maxCycles: 6,
  allowPrivate: true,
  maxDepth: 2,
  policy: createDiscoveryPolicy({ seedUrls: [seedOrigin], mode: "open" }),
});

const domains = registry.list();
console.log("documents fetched:", result.documents.length);
console.log("failures:", result.failures.length);
console.log("domains registered:", domains.length);
console.log("temp debris:", readdirSync(dir).filter((f) => f.includes(".tmp")));

// The registry must be complete and reloadable — no torn write, no lost row.
const reloaded = createDomainRegistry({ dir });
await reloaded.init();
console.log("reloaded domains:", reloaded.list().length, "(in-memory:", domains.length + ")");

// A policy change must survive the reload.
await registry.blockDomain("blockme.test", { reason: "verify" });
const afterRestart = createDomainRegistry({ dir });
await afterRestart.init();
console.log("blocked after restart:", afterRestart.get("blockme.test")?.policy);

seed.close();
external.close();
rmSync(dir, { recursive: true, force: true });
