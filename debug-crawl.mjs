import http from "node:http";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCrawlBatches } from "../src/harness/crawler.js";
import { Frontier } from "../src/frontier.js";
import { createDomainRegistry } from "../src/storage/domain-registry.js";
import { createDiscoveryPolicy } from "../src/discovery/discovery-policy.js";

const ext = http.createServer((q, s) => {
  const u = new URL(q.url, "http://x");
  if (u.pathname === "/robots.txt") {
    s.writeHead(200, { "content-type": "text/plain" });
    s.end("User-agent: *\nAllow: /\n");
    return;
  }
  s.writeHead(200, { "content-type": "text/html" });
  s.end("<html><body>cross host body</body></html>");
});
await new Promise((r) => ext.listen(0, "127.0.0.1", r));
const extOrigin = "http://localhost:" + ext.address().port;

const srv = http.createServer((q, s) => {
  const u = new URL(q.url, "http://x");
  if (u.pathname === "/robots.txt") {
    s.writeHead(200, { "content-type": "text/plain" });
    s.end("User-agent: *\nAllow: /\n");
    return;
  }
  if (u.pathname === "/seed") {
    const links = Array.from({ length: 4 }, (_, i) => `<a href="/page${i}">p</a>`).join("");
    const cross = `<a href="${extOrigin}/ext">x</a>`;
    s.writeHead(200, { "content-type": "text/html" });
    s.end(`<html><body>${links}${cross}</body></html>`);
    return;
  }
  s.writeHead(200, { "content-type": "text/html" });
  s.end("<html><body>child</body></html>");
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const seedOrigin = "http://127.0.0.1:" + srv.address().port;

const dir = mkdtempSync(path.join(tmpdir(), "sma-t-"));
const registry = createDomainRegistry({ dir, forceNew: true });
await registry.init();
const frontier = new Frontier({ dir: dir + "-f" });
await frontier.init();
await frontier.enqueue(seedOrigin + "/seed", { depth: 0, seed: seedOrigin + "/seed" });

const t0 = Date.now();
const result = await runCrawlBatches({
  frontier,
  domainRegistry: registry,
  maxCycles: 8,
  maxDepth: 2,
  allowPrivate: true,
  policy: createDiscoveryPolicy({ seedUrls: [seedOrigin + "/seed"], mode: "open" }),
}).catch((e) => {
  console.error("runCrawlBatches threw:", e.stack || e.message);
  return null;
});
console.log("elapsed ms:", Date.now() - t0);
console.log("docs:", result ? result.documents.length : "n/a", "failures:", result ? result.failures.length : "n/a");
console.log("hosts:", registry.list().map((d) => `${d.domain}:${d.documentsFetched}`));
console.log("tmp debris:", readdirSync(dir).filter((f) => f.includes(".tmp")));
srv.close();
ext.close();
