import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Frontier } from "../src/frontier.js";
import { config } from "../src/config.js";
import { DiscoveryService } from "../src/discovery/discovery-service.js";
import { createDiscoveryPolicy } from "../src/discovery/discovery-policy.js";
import { createDomainRegistry } from "../src/storage/domain-registry.js";
import {
  createDiscoveryOperationGovernor,
  createGovernedFetchText,
} from "../src/discovery/discovery-operations.js";

const tmp = () => mkdtempSync(path.join(tmpdir(), "sma-discovery-ops-"));
const WINDOW = 60 * 60 * 1000;
const T0 = Date.parse("2026-10-26T10:00:00.000Z");

function readLedger(dir) {
  const records = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ndjson"))) {
    for (const line of readFileSync(path.join(dir, file), "utf8").split("\n")) {
      if (!line.trim()) continue;
      records.push(JSON.parse(line));
    }
  }
  return records;
}

test("discovery governor grants durably, enforces the global budget and survives restart", async () => {
  const dir = tmp();
  let now = T0;
  const clock = () => new Date(now);
  const governor = createDiscoveryOperationGovernor({
    dir,
    windowMs: WINDOW,
    maxPerWindow: 2,
    maxPerDomainPerWindow: 2,
    maxConcurrent: 1,
    clock,
    limits: { timeoutMs: 1000, maxBytes: 2000, maxRedirects: 3 },
  });
  let calls = 0;
  const fetchText = createGovernedFetchText({
    governor,
    fetchText: async () => {
      calls++;
      return "ok";
    },
  });

  assert.equal(await fetchText("https://a.test/robots.txt", { adapter: "sitemap", isRobots: true }), "ok");
  assert.equal(await fetchText("https://b.test/sitemap.xml", { adapter: "sitemap" }), "ok");
  await assert.rejects(
    () => fetchText("https://c.test/sitemap.xml", { adapter: "sitemap" }),
    (err) => err.code === "DISCOVERY_BUDGET_EXHAUSTED",
  );
  assert.equal(calls, 2, "the third request was denied before network I/O");

  const records = readLedger(dir);
  assert.equal(records.filter((r) => r.type === "grant").length, 2);
  assert.equal(records.filter((r) => r.type === "complete").length, 2);
  assert.ok(records.some((r) => r.adapter === "sitemap" && r.purpose === "robots"));
  assert.deepEqual(records.find((r) => r.type === "grant").limits, {
    timeoutMs: 1000,
    maxBytes: 2000,
    maxRedirects: 3,
  });

  const reopened = createDiscoveryOperationGovernor({
    dir,
    windowMs: WINDOW,
    maxPerWindow: 2,
    maxPerDomainPerWindow: 2,
    maxConcurrent: 1,
    clock,
  });
  await assert.rejects(
    () =>
      createGovernedFetchText({
        governor: reopened,
        fetchText: async () => {
          calls++;
          return "should-not-run";
        },
      })("https://d.test/", { adapter: "sitemap" }),
    (err) => err.code === "DISCOVERY_BUDGET_EXHAUSTED",
  );
  assert.equal(calls, 2, "restart retains the consumed budget");

  now = T0 + WINDOW;
  const nextWindow = createDiscoveryOperationGovernor({
    dir,
    windowMs: WINDOW,
    maxPerWindow: 2,
    maxPerDomainPerWindow: 2,
    maxConcurrent: 1,
    clock,
  });
  await createGovernedFetchText({
    governor: nextWindow,
    fetchText: async () => {
      calls++;
      return "ok";
    },
  })("https://d.test/", { adapter: "sitemap" });
  assert.equal(calls, 3, "the next window grants a fresh operation");
  rmSync(dir, { recursive: true, force: true });
});

test("discovery governor enforces per-domain limits", async () => {
  const dir = tmp();
  const governor = createDiscoveryOperationGovernor({
    dir,
    windowMs: WINDOW,
    maxPerWindow: 10,
    maxPerDomainPerWindow: 1,
    maxConcurrent: 1,
    clock: () => new Date(T0),
  });
  let calls = 0;
  const fetchText = createGovernedFetchText({
    governor,
    fetchText: async () => {
      calls++;
      return "ok";
    },
  });
  await fetchText("https://a.test/one", { adapter: "sitemap" });
  await assert.rejects(
    () => fetchText("https://a.test/two", { adapter: "sitemap" }),
    (err) => err.code === "DISCOVERY_BUDGET_EXHAUSTED" && /per-domain/.test(err.message),
  );
  await fetchText("https://b.test/one", { adapter: "sitemap" });
  assert.equal(calls, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("discovery governor enforces global concurrency", async () => {
  const dir = tmp();
  const governor = createDiscoveryOperationGovernor({
    dir,
    windowMs: WINDOW,
    maxPerWindow: 10,
    maxPerDomainPerWindow: 10,
    maxConcurrent: 1,
    clock: () => new Date(T0),
  });
  let active = 0;
  let maxActive = 0;
  const run = (url) =>
    governor.run({ adapter: "sitemap", url }, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
    });
  await Promise.all([run("https://a.test/one"), run("https://b.test/two")]);
  assert.equal(maxActive, 1);
  assert.equal(governor.status().used, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("a corrupt committed ledger fails closed", () => {
  const dir = tmp();
  const windowStart = Math.floor(T0 / WINDOW) * WINDOW;
  writeFileSync(path.join(dir, `operations-${windowStart}.ndjson`), "{\"type\":\"grant\"}\nnot-json\n{\"type\":\"grant\"}\n");
  assert.throws(
    () =>
      createDiscoveryOperationGovernor({
        dir,
        windowMs: WINDOW,
        clock: () => new Date(T0),
      }),
    (err) => err.code === "DISCOVERY_LEDGER_CORRUPT",
  );
  rmSync(dir, { recursive: true, force: true });
});

async function makeGatewayService({ discoveryDir, discoveryOperations = null, fetchText, gatewayCalls = [] }) {
  const root = tmp();
  const frontier = new Frontier({ dir: path.join(root, "frontier") });
  await frontier.init();
  const registry = createDomainRegistry({ dir: path.join(root, "registry"), forceNew: true });
  await registry.init();
  const admissionGateway = {
    async authorize(args) {
      gatewayCalls.push(args);
      return {
        decision: "REJECTED",
        compliance: "COMPLIANT",
        reason: "cap",
        requestId: "test-request",
        payloadDigest: "a".repeat(64),
        capEpoch: "test-epoch",
      };
    },
  };
  const service = new DiscoveryService({
    frontier,
    seeds: ["https://site.test/"],
    discoverySeeds: [],
    defaultSeeds: [],
    adapters: null,
    admissionGateway,
    fetchText,
    discoveryDir: discoveryDir ?? path.join(root, "discovery"),
    discoveryOperations,
    policy: createDiscoveryPolicy({ mode: "open" }),
    domainRegistry: registry,
  });
  return { root, frontier, registry, service, gatewayCalls };
}

test("gateway mode restores governed sitemap/feed discovery and keeps article URLs as candidates", async () => {
  const calls = [];
  const articleFetches = [];
  const mockFetchText = async (url) => {
    calls.push(String(url));
    if (String(url) === "https://site.test/robots.txt") {
      return "User-agent: *\nAllow: /\nSitemap: https://site.test/sitemap.xml\n";
    }
    if (String(url) === "https://site.test/sitemap.xml") {
      return `<urlset><url><loc>https://site.test/article</loc></url></urlset>`;
    }
    if (String(url) === "https://site.test/") {
      return "<html><body>root</body></html>";
    }
    if (String(url) === "https://site.test/article") {
      articleFetches.push(String(url));
      return "<html><body>article</body></html>";
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const gatewayCalls = [];
  const { root, frontier, service } = await makeGatewayService({
    fetchText: mockFetchText,
    gatewayCalls,
  });
  try {
    assert.deepEqual(service.adapters.map((a) => a.name), ["sitemap", "feed"]);
    assert.ok(service.discoveryOperations, "gateway mode creates the governed discovery ledger");

    const result = await service.collect({ maxPages: 1, maxCycles: 1 });
    const sitemap = result.discovery.bootstrap.adapters.find((a) => a.name === "sitemap");
    assert.equal(sitemap.status, "ok");
    assert.ok(sitemap.enqueued >= 1);
    assert.equal(frontier.has("https://site.test/article"), true);
    assert.equal(articleFetches.length, 0, "discovery only proposed the article URL; it was not fetched");
    assert.ok(gatewayCalls.length > 0, "the queued candidate still went through article admission");
    assert.ok(result.discovery.discoveryOperations.used >= 2);

    const grants = readLedger(service.discoveryOperations.dir);
    assert.ok(grants.some((r) => r.type === "grant" && r.adapter === "sitemap" && /sitemap\.xml/.test(r.url)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discovery budget exhaustion stops adapter network I/O and reports deferral", async () => {
  const calls = [];
  const mockFetchText = async (url) => {
    calls.push(String(url));
    if (String(url) === "https://site.test/robots.txt") {
      return "User-agent: *\nAllow: /\nSitemap: https://site.test/sitemap.xml\n";
    }
    if (String(url) === "https://site.test/sitemap.xml") {
      return `<urlset><url><loc>https://site.test/article</loc></url></urlset>`;
    }
    if (String(url) === "https://site.test/") return "<html><body>root</body></html>";
    throw new Error(`unexpected fetch ${url}`);
  };
  const root = tmp();
  const discoveryDir = path.join(root, "discovery");
  const governor = createDiscoveryOperationGovernor({
    dir: discoveryDir,
    windowMs: WINDOW,
    maxPerWindow: 1,
    maxPerDomainPerWindow: 10,
    maxConcurrent: 1,
    clock: () => new Date(T0),
  });
  const gatewayCalls = [];
  const { root: serviceRoot, service } = await makeGatewayService({
    discoveryDir,
    discoveryOperations: governor,
    fetchText: mockFetchText,
    gatewayCalls,
  });
  try {
    const result = await service.collect({ maxPages: 1, maxCycles: 1 });
    const sitemap = result.discovery.bootstrap.adapters.find((a) => a.name === "sitemap");
    assert.equal(sitemap.status, "budget-exhausted");
    assert.equal(sitemap.reason, "discovery-budget-exhausted");
    assert.equal(calls.filter((u) => /sitemap\.xml/.test(u)).length, 0, "no sitemap network call after budget exhaustion");
    assert.equal(governor.status().used, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(serviceRoot, { recursive: true, force: true });
  }
});


test("disabling discovery operations disables adapters without network I/O", async () => {
  const original = { ...config.discoveryOperations };
  config.discoveryOperations = { ...original, enabled: false };
  const root = tmp();
  try {
    const frontier = new Frontier({ dir: path.join(root, "frontier") });
    await frontier.init();
    const registry = createDomainRegistry({ dir: path.join(root, "registry"), forceNew: true });
    await registry.init();
    let calls = 0;
    const service = new DiscoveryService({
      frontier,
      seeds: ["https://site.test/"],
      discoverySeeds: [],
      defaultSeeds: [],
      adapters: null,
      admissionGateway: { async authorize() { throw new Error("not used"); } },
      fetchText: async () => {
        calls++;
        return "";
      },
      discoveryDir: path.join(root, "discovery"),
      policy: createDiscoveryPolicy({ mode: "open" }),
      domainRegistry: registry,
    });
    assert.deepEqual(service.adapters, []);
    assert.equal(calls, 0);
  } finally {
    config.discoveryOperations = original;
    rmSync(root, { recursive: true, force: true });
  }
});

test("gateway mode keeps search unavailable even if configured", async () => {
  const original = [...config.crawlDiscoveryAdapters];
  config.crawlDiscoveryAdapters = ["sitemap", "feed", "search"];
  const root = tmp();
  try {
    const frontier = new Frontier({ dir: path.join(root, "frontier") });
    await frontier.init();
    const registry = createDomainRegistry({ dir: path.join(root, "registry"), forceNew: true });
    await registry.init();
    const service = new DiscoveryService({
      frontier,
      seeds: ["https://site.test/"],
      discoverySeeds: [],
      defaultSeeds: [],
      adapters: null,
      admissionGateway: { async authorize() { throw new Error("not used"); } },
      fetchText: async () => "",
      discoveryDir: path.join(root, "discovery"),
      policy: createDiscoveryPolicy({ mode: "open" }),
      domainRegistry: registry,
    });
    assert.deepEqual(service.adapters.map((a) => a.name), ["sitemap", "feed"]);
    assert.equal(service.adapters.some((a) => a.name === "search"), false);
  } finally {
    config.crawlDiscoveryAdapters = original;
    rmSync(root, { recursive: true, force: true });
  }
});
