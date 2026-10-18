import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createDomainRegistry } from "../src/storage/domain-registry.js";
import { attachAdmin } from "../src/admin/routes.js";
import { ArticleStore } from "../src/storage/article-store.js";
import { RegistryStore } from "../src/storage/registry-store.js";
import { GovernanceStore } from "../src/admin/governance-store.js";

const stubChat = {
  identity: () => ({ available: false, mode: "stub", version: null }),
  respond: async (message) => ({ reply: `echo:${message}`, version: null, at: new Date().toISOString() }),
  isUnavailable: () => false,
};

/**
 * Boots a real admin server on an ephemeral port and returns an HTTP client.
 * The existing admin tests do the same — no test-only HTTP shim.
 */
async function harness({ domainRegistry } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "sma-dom-admin-"));
  const store = await ArticleStore.open(path.join(dir, "articles"), { domainRegistry });
  const registry = await RegistryStore.open(path.join(dir, "registry"));
  const governance = await GovernanceStore.open(path.join(dir, "governance"));
  const app = express();
  app.use(express.json());
  attachAdmin({
    app,
    store,
    registry,
    governance,
    chat: stubChat,
    conversations: null,
    workspaces: [],
    pythonStorePath: null,
    domainRegistry,
    logger: { log() {} },
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body: json };
  };
  return {
    get: (url) => call("GET", url),
    post: (url, body) => call("POST", url, body),
    remove: (url) => call("DELETE", url),
    close: () => new Promise((r) => server.close(r)),
  };
}

async function withRegistry(fn, { domains = [] } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "sma-dom-admin-reg-"));
  const registry = createDomainRegistry({ dir, forceNew: true });
  await registry.init();
  const h = await harness({ domainRegistry: registry });
  try {
    await fn({ h, registry });
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("GET /domains: lists registered domains with counters", async () => {
  await withRegistry(async ({ h, registry }) => {
    await registry.registerDomain("alpha.test");
    await registry.recordFetchSuccess("alpha.test", { url: "https://alpha.test/a", contentHash: "x" });
    await registry.registerDomain("beta.test");

    const res = await h.get("/api/admin/domains?limit=10");
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 2);
    assert.equal(res.body.items.find((d) => d.domain === "alpha.test").documentsFetched, 1);
    assert.equal(res.body.items.find((d) => d.domain === "beta.test").documentsFetched, 0);
  });
});

/**
 * TDZ REGRESSION.
 *
 * The handler destructured `limit` out of the query and then re-declared
 * `const limit = Number(limit)` — a temporal-dead-zone access. The endpoint
 * threw "Cannot access 'limit' before initialization", which made the whole
 * Sources & Domains tab fail to render.
 */
test("GET /domains: honours ?limit= without a temporal-dead-zone error", async () => {
  await withRegistry(async ({ h, registry }) => {
    for (let i = 0; i < 5; i++) await registry.registerDomain(`h${i}.test`);
    const res = await h.get("/api/admin/domains?limit=2");
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 2, "limit must actually bound the page");
    assert.equal(res.body.total, 5, "and total must still report the whole registry");
  });
});

test("GET /domains/stats: reports counts by policy and origin", async () => {
  await withRegistry(async ({ h, registry }) => {
    await registry.registerDomain("a.test");
    await registry.registerDomain("b.test", { origin: "manual" });
    await registry.setImportant("a.test", true);
    await registry.registerDomain("c.test");
    await registry.blockDomain("c.test");

    const res = await h.get("/api/admin/domains/stats");
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 3);
    assert.equal(res.body.byPolicy.important, 1);
    assert.equal(res.body.byPolicy.blocked, 1);
    assert.equal(res.body.byOrigin.manual, 1);
  });
});

test("POST /domains: accepts a hostname or a URL and derives the domain", async () => {
  await withRegistry(async ({ h }) => {
    const byHost = await h.post("/api/admin/domains", { domain: "wikipedia.org", origin: "manual" });
    assert.equal(byHost.status, 200);
    assert.equal(byHost.body.domain, "wikipedia.org");

    // A full URL must become the domain, not an individual article.
    const byUrl = await h.post("/api/admin/domains", { domain: "https://en.wikipedia.org/wiki/Steam_engine" });
    assert.equal(byUrl.status, 200);
    assert.equal(byUrl.body.domain, "en.wikipedia.org");

    const missing = await h.post("/api/admin/domains", {});
    assert.equal(missing.status, 400);
  });
});

test("block beats importance: importance cannot lift a block", async () => {
  await withRegistry(async ({ h, registry }) => {
    await registry.registerDomain("blocked.test");

    await h.post("/api/admin/domains/blocked.test/block", { reason: "operator" });
    const refused = await h.post("/api/admin/domains/blocked.test/important", { important: true });
    assert.equal(refused.status, 404, "importance must not override a block");

    const unblocked = await h.post("/api/admin/domains/blocked.test/unblock", {});
    assert.equal(unblocked.body.policy, "normal");

    const now = await h.post("/api/admin/domains/blocked.test/important", { important: true });
    assert.equal(now.status, 200, "importance works once unblocked");
  });
});

test("removal is not a block: rediscovery recreates a NORMAL record", async () => {
  await withRegistry(async ({ h, registry }) => {
    await registry.registerDomain("transient.test");
    await registry.setImportant("transient.test", true);

    const removed = await h.remove("/api/admin/domains/transient.test");
    assert.equal(removed.status, 200);

    const back = await h.post("/api/admin/domains", { domain: "transient.test" });
    assert.equal(back.body.record.policy, "normal", "old importance must not silently return");
  });
});

test("domains API: 503 when no registry is wired (not a fabricated empty list)", async () => {
  const h = await harness({ domainRegistry: null });
  const res = await h.get("/api/admin/domains");
  assert.equal(res.status, 503);
  assert.match(res.body.error, /domain registry/i);
  await h.close();
});

/**
 * The UI bug: `render()` called `renderSources()` with no data, which throws on
 * destructuring `undefined` and left the tab blank. `renderSources` must be
 * reachable only through `loadSources()`, which always passes an object.
 */
test("sources UI: the tab is rendered only from loaded API state", async () => {
  // Resolve the shipped SPA from the repo, not a machine-specific absolute path.
  const appJs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "admin", "public", "app.js");
  const html = await import("node:fs/promises").then((fs) => fs.readFile(appJs, "utf8"));

  // `render()` must NOT call renderSources: it runs before any state exists.
  assert.ok(
    !/function render\(\)[\s\S]*?renderSources\(\);[\s\S]*?\n}/.test(
      html.match(/function render\(\) \{[\s\S]*?\n\}/)[0],
    ),
    "render() must never call renderSources() with no data",
  );
  // loadSources must render, and must pass an object even when the API fails.
  assert.match(html, /async function loadSources\(\)[\s\S]*?renderSources\(\{ stats, domains, error \}\)/);
});
