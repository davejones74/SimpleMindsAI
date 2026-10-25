import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Frontier } from "../src/frontier.js";
import { runCrawlBatches, runCrawlCycle, collectDocuments, harvest } from "../src/harness/crawler.js";
import { AdmissionStore } from "../src/gateway/admission-store.js";
import { AcquisitionGateway, deriveAcquisitionIdentity } from "../src/gateway/acquisition-gateway.js";
import { DiscoveryService } from "../src/discovery/discovery-service.js";
import { createDiscoveryPolicy } from "../src/discovery/discovery-policy.js";
import { createDomainRegistry } from "../src/storage/domain-registry.js";
import { config } from "../src/config.js";

const FIXED_CLOCK = () => new Date("2026-10-25T00:00:00.000Z");
const ROBOTS = "User-agent: *\nAllow: /\n";

function response({ status = 200, body = "", headers = {} } = {}) {
  return new Response(status === 304 || status === 204 ? null : body, { status, headers });
}

function mockFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const target = String(url);
    calls.push({ url: target, headers: opts.headers ?? {} });
    const route = routes[target] ?? routes[new URL(target).pathname];
    if (!route) return response({ status: 404, body: "missing" });
    return typeof route === "function" ? route({ url: target, headers: opts.headers ?? {}, calls }) : route;
  };
  return { calls, fetchImpl };
}

function targetCalls(calls, target) {
  return calls.filter((c) => c.url === target);
}

async function makeHarness(t, {
  urls = [],
  capLimit = 10,
  capEpoch = "test-epoch",
  routes = {},
  faultInjector = null,
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "sma-admission-integration-"));
  const frontier = new Frontier({ dir: path.join(root, "frontier") });
  await frontier.init();
  for (const url of urls) await frontier.enqueue(url, { depth: 0 });
  const store = await AdmissionStore.open({
    dir: path.join(root, "admission"),
    config: {
      capLimit,
      capEpoch,
      ackRequired: false,
      protocolVersion: "baseline-v1",
    },
    clock: FIXED_CLOCK,
    faultInjector,
  });
  const realGateway = new AcquisitionGateway({ store });
  const events = [];
  const results = [];
  const admissionGateway = {
    async authorize(args) {
      events.push("admit:start");
      const result = await realGateway.authorize(args);
      results.push(result);
      events.push("admit:end");
      return result;
    },
  };
  const net = mockFetch(routes);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, frontier, store, admissionGateway, events, results, ...net };
}

test("admission precedes robots, target, and redirect fetches and consumes one cap unit", async (t) => {
  const target = "https://example.test/final";
  const redirect = "https://example.test/redirect";
  const harness = await makeHarness(t, {
    urls: [redirect],
    capLimit: 5,
    routes: {
      "https://example.test/robots.txt": response({ headers: { "content-type": "text/plain" }, body: ROBOTS }),
      [redirect]: response({ status: 302, headers: { location: target } }),
      [target]: response({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: "<html><body><p>body</p></body></html>",
      }),
    },
  });

  const summary = await runCrawlCycle({
    frontier: harness.frontier,
    admissionGateway: harness.admissionGateway,
    fetchImpl: harness.fetchImpl,
    respectRobots: true,
    allowPrivate: true,
    maxDepth: 1,
  });

  assert.equal(summary.errors, 0);
  assert.equal(summary.documents.length, 1);
  assert.equal(harness.store.capUsage(), 1);
  assert.equal(harness.results.length, 1);
  assert.equal(harness.results[0].decision, "ADMITTED");
  assert.equal(harness.results[0].compliance, "COMPLIANT");

  assert.deepEqual(
    harness.calls.map((c) => c.url),
    ["https://example.test/robots.txt", redirect, target],
  );
  const admitEnd = harness.events.indexOf("admit:end");
  assert.equal(harness.events[0], "admit:start");
  assert.ok(admitEnd > 0);
  assert.equal(harness.events.length, 2, "the admission gate is recorded once");

  const key = [...harness.frontier.state.keys()][0];
  const record = harness.frontier.state.get(key);
  assert.equal(record.state, "visited");
  assert.equal(record.generation, 1, "one terminal success advances the generation");
});

test("retry after a transient failure reuses the request identity and does not consume cap", async (t) => {
  const target = "https://example.test/retry";
  let targetAttempts = 0;
  const harness = await makeHarness(t, {
    urls: [target],
    capLimit: 5,
    routes: {
      "https://example.test/robots.txt": response({ headers: { "content-type": "text/plain" }, body: ROBOTS }),
      [target]: () => {
        targetAttempts++;
        if (targetAttempts === 1) return response({ status: 500, body: "unavailable" });
        return response({
          headers: { "content-type": "text/html; charset=utf-8" },
          body: "<html><body><p>recovered</p></body></html>",
        });
      },
    },
  });

  const first = await runCrawlCycle({
    frontier: harness.frontier,
    admissionGateway: harness.admissionGateway,
    fetchImpl: harness.fetchImpl,
    respectRobots: true,
    allowPrivate: true,
    maxDepth: 1,
  });
  assert.equal(first.errors, 1);
  assert.equal(harness.store.capUsage(), 1);

  const key = [...harness.frontier.state.keys()][0];
  const afterFailure = harness.frontier.state.get(key);
  assert.equal(afterFailure.state, "deferred");
  assert.equal(afterFailure.generation, 0);
  assert.ok(afterFailure.requestId);

  const second = await runCrawlCycle({
    frontier: harness.frontier,
    admissionGateway: harness.admissionGateway,
    fetchImpl: harness.fetchImpl,
    respectRobots: true,
    allowPrivate: true,
    maxDepth: 1,
    claimNow: Date.now() + 10 * 60 * 1000,
  });
  assert.equal(second.errors, 0);
  assert.equal(second.documents.length, 1);
  assert.equal(harness.results.length, 2);
  assert.equal(harness.results[0].requestId, harness.results[1].requestId);
  assert.equal(harness.results[0].replayed, false);
  assert.equal(harness.results[1].replayed, true);
  assert.equal(harness.store.capUsage(), 1);
  assert.equal(harness.frontier.state.get(key).generation, 1);
});

test("crash after admission but before fetch recovers the same generation as a replay", async (t) => {
  const target = "https://example.test/crash";
  const harness = await makeHarness(t, {
    urls: [target],
    capLimit: 5,
    routes: {
      "https://example.test/robots.txt": response({ headers: { "content-type": "text/plain" }, body: ROBOTS }),
      [target]: response({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: "<html><body><p>after crash</p></body></html>",
      }),
    },
  });

  const key = [...harness.frontier.state.keys()][0];
  const claimed = await harness.frontier.claimNext();
  assert.equal(claimed.canonical, key);
  const first = await harness.admissionGateway.authorize({
    url: key,
    generation: claimed.record.generation ?? 0,
    etag: claimed.record.etag,
    lastModified: claimed.record.lastModified,
    userAgent: config.crawlUserAgent,
    respectRobots: true,
    allowPrivate: true,
    maxRedirects: config.crawlMaxRedirects,
  });
  await harness.frontier.recordAdmission(key, {
    requestId: first.requestId,
    payloadDigest: first.payloadDigest,
  });

  const restarted = new Frontier({ dir: harness.frontier.dir });
  await restarted.init();
  await restarted.recoverStaleClaims({ claimTimeoutMs: -1 });
  assert.equal(restarted.state.get(key).state, "deferred");

  const recovered = await runCrawlCycle({
    frontier: restarted,
    admissionGateway: harness.admissionGateway,
    fetchImpl: harness.fetchImpl,
    respectRobots: true,
    allowPrivate: true,
    maxDepth: 1,
    claimNow: Date.now() + 1000,
  });

  assert.equal(recovered.errors, 0);
  assert.equal(recovered.documents.length, 1);
  assert.equal(harness.results.length, 2);
  assert.equal(harness.results[1].requestId, first.requestId);
  assert.equal(harness.results[1].replayed, true);
  assert.equal(harness.store.capUsage(), 1);
  assert.equal(targetCalls(harness.calls, target).length, 1, "the recovered operation fetched once");
});

test("rediscovery after terminal success creates a new generation and a new admission", async (t) => {
  const target = "https://example.test/rediscover";
  let conditionalSeen = false;
  const harness = await makeHarness(t, {
    urls: [target],
    capLimit: 5,
    routes: {
      "https://example.test/robots.txt": response({ headers: { "content-type": "text/plain" }, body: ROBOTS }),
      [target]: ({ headers }) => {
        if (headers["if-none-match"] === '"v1"') {
          conditionalSeen = true;
          return response({ status: 304, headers: { etag: '"v1"' } });
        }
        return response({
          headers: { "content-type": "text/html; charset=utf-8", etag: '"v1"' },
          body: "<html><body><p>version one</p></body></html>",
        });
      },
    },
  });

  const first = await runCrawlCycle({
    frontier: harness.frontier,
    admissionGateway: harness.admissionGateway,
    fetchImpl: harness.fetchImpl,
    respectRobots: true,
    allowPrivate: true,
    maxDepth: 1,
    rediscoveryEnabled: true,
  });
  assert.equal(first.documents.length, 1);

  const key = [...harness.frontier.state.keys()][0];
  const record = harness.frontier.state.get(key);
  assert.equal(record.generation, 1);
  record.nextCrawlAt = new Date(Date.now() - 1000).toISOString();
  await harness.frontier.persist();

  const second = await runCrawlCycle({
    frontier: harness.frontier,
    admissionGateway: harness.admissionGateway,
    fetchImpl: harness.fetchImpl,
    respectRobots: true,
    allowPrivate: true,
    maxDepth: 1,
    rediscoveryEnabled: true,
    rediscoveryTtlMs: 60_000,
  });

  assert.equal(second.rediscoveries, 1);
  assert.equal(second.notModified, 1);
  assert.equal(second.documents.length, 0);
  assert.equal(conditionalSeen, true);
  assert.equal(harness.results.length, 2);
  assert.notEqual(harness.results[0].requestId, harness.results[1].requestId);
  assert.deepEqual(harness.results.map((r) => r.generation), [0, 1]);
  assert.equal(harness.store.capUsage(), 2);
  assert.equal(harness.frontier.state.get(key).generation, 2);
});

test("rejected work does not fetch and cannot be re-enqueued or retried", async (t) => {
  const firstUrl = "https://example.test/first";
  const rejectedUrl = "https://example.test/rejected";
  const harness = await makeHarness(t, {
    urls: [firstUrl, rejectedUrl],
    capLimit: 1,
    routes: {
      "https://example.test/robots.txt": response({ headers: { "content-type": "text/plain" }, body: ROBOTS }),
      [firstUrl]: response({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: "<html><body><p>first</p></body></html>",
      }),
      [rejectedUrl]: response({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: "<html><body><p>must not be fetched</p></body></html>",
      }),
    },
  });

  await runCrawlCycle({
    frontier: harness.frontier,
    admissionGateway: harness.admissionGateway,
    fetchImpl: harness.fetchImpl,
    respectRobots: true,
    allowPrivate: true,
    maxDepth: 1,
  });
  const rejectedSummary = await runCrawlCycle({
    frontier: harness.frontier,
    admissionGateway: harness.admissionGateway,
    fetchImpl: harness.fetchImpl,
    respectRobots: true,
    allowPrivate: true,
    maxDepth: 1,
  });

  assert.equal(rejectedSummary.admissionRejected, 1);
  assert.equal(targetCalls(harness.calls, rejectedUrl).length, 0);
  const rejectedKey = [...harness.frontier.state.keys()].find((k) => k === rejectedUrl);
  assert.equal(harness.frontier.state.get(rejectedKey).state, "rejected");
  assert.equal(await harness.frontier.enqueue(rejectedUrl, { force: true }), null);
  assert.equal(await harness.frontier.claimNext(), null);
  assert.equal(await harness.frontier.markFailed(rejectedKey, { reason: "retry" }), false);
  assert.equal(harness.store.capUsage(), 1);
});

test("contradictory admission quarantines work without any fetch or re-enqueue", async (t) => {
  const target = "https://example.test/conflict";
  let inject = true;
  const harness = await makeHarness(t, {
    urls: [target],
    capLimit: 5,
    faultInjector: ({ phase }) => {
      if (inject && phase === "before_decision_commit") throw new Error("simulated pre-decision crash");
    },
    routes: {
      "https://example.test/robots.txt": response({ headers: { "content-type": "text/plain" }, body: ROBOTS }),
      [target]: response({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: "<html><body><p>must not be fetched</p></body></html>",
      }),
    },
  });

  const key = [...harness.frontier.state.keys()][0];
  const { requestId } = deriveAcquisitionIdentity({
    config: harness.store.sealedConfig,
    url: key,
    generation: 0,
  });
  await assert.rejects(
    harness.store.admit({ requestId, payloadDigest: "a".repeat(64) }),
    /simulated pre-decision crash/,
  );
  inject = false;

  const summary = await runCrawlCycle({
    frontier: harness.frontier,
    admissionGateway: harness.admissionGateway,
    fetchImpl: harness.fetchImpl,
    respectRobots: true,
    allowPrivate: true,
    maxDepth: 1,
  });

  assert.equal(summary.admissionQuarantined, 1);
  assert.equal(targetCalls(harness.calls, target).length, 0);
  assert.equal(harness.frontier.state.get(key).state, "quarantined");
  assert.equal(await harness.frontier.enqueue(target, { force: true }), null);
  assert.equal(await harness.frontier.claimNext(), null);
  assert.equal(harness.store.capUsage(), 0);
});

test("discovery adapters and direct real-fetch paths cannot bypass the gateway", async (t) => {
  const target = "https://example.test/discovery";
  const harness = await makeHarness(t, {
    capLimit: 5,
    routes: {
      "https://example.test/robots.txt": response({ headers: { "content-type": "text/plain" }, body: ROBOTS }),
      [target]: response({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: "<html><body><p>discovery</p></body></html>",
      }),
    },
  });
  const registry = createDomainRegistry({
    dir: path.join(harness.root, "registry"),
    forceNew: true,
  });
  await registry.init();

  const service = new DiscoveryService({
    frontier: harness.frontier,
    seeds: [target],
    discoverySeeds: [],
    defaultSeeds: [],
    adapters: null,
    admissionGateway: harness.admissionGateway,
    fetchImpl: harness.fetchImpl,
    policy: createDiscoveryPolicy({ mode: "open" }),
    domainRegistry: registry,
  });
  assert.deepEqual(service.adapters, [], "network-capable discovery adapters are disabled");

  assert.throws(
    () =>
      new DiscoveryService({
        frontier: harness.frontier,
        seeds: [],
        defaultSeeds: [],
        adapters: [{}],
        admissionGateway: harness.admissionGateway,
        policy: createDiscoveryPolicy({ mode: "open" }),
        domainRegistry: registry,
      }),
    (err) => err.code === "ADMISSION_PATH_DISABLED",
  );

  const result = await service.collect({ maxPages: 1, maxDepth: 0, allowPrivate: true });
  assert.equal(result.documents.length, 1);
  assert.equal(harness.store.capUsage(), 1);

  const beforeDirect = harness.calls.length;
  await assert.rejects(
    collectDocuments({
      mode: "real",
      urls: [target],
      admissionGateway: harness.admissionGateway,
      fetchImpl: harness.fetchImpl,
    }),
    (err) => err.code === "ADMISSION_PATH_DISABLED",
  );
  await assert.rejects(
    harvest({
      dir: path.join(harness.root, "raw"),
      mode: "real",
      urls: [target],
      admissionGateway: harness.admissionGateway,
      fetchImpl: harness.fetchImpl,
    }),
    (err) => err.code === "ADMISSION_PATH_DISABLED",
  );
  assert.equal(harness.calls.length, beforeDirect, "disabled paths made no network calls");
});

test("frontier harvest with a valid gateway reaches the admission gate", async (t) => {
  const target = "https://example.test/harvest-gate";
  const harness = await makeHarness(t, {
    urls: [target],
    capLimit: 5,
    routes: {
      "https://example.test/robots.txt": response({ headers: { "content-type": "text/plain" }, body: ROBOTS }),
      [target]: response({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: "<html><body><p>admitted harvest</p></body></html>",
      }),
    },
  });

  const registry = createDomainRegistry({ dir: path.join(harness.root, "registry"), forceNew: true });
  await registry.init();
  const result = await harvest({
    dir: path.join(harness.root, "raw"),
    mode: "real",
    urls: [target],
    frontier: harness.frontier,
    admissionGateway: harness.admissionGateway,
    fetchImpl: harness.fetchImpl,
    domainRegistry: registry,
    allowPrivate: true,
    respectRobots: true,
  });

  assert.equal(result.documents.length, 1);
  assert.equal(harness.results.length, 1);
  assert.equal(harness.results[0].decision, "ADMITTED");
  assert.equal(harness.store.capUsage(), 1);
});

test("concurrent admissions respect the global cap", async (t) => {
  const harness = await makeHarness(t, { capLimit: 3 });
  const urls = Array.from({ length: 10 }, (_, i) => `https://example.test/concurrent-${i}`);

  const results = await Promise.all(
    urls.map((url) => harness.admissionGateway.authorize({ url, generation: 0 })),
  );
  assert.equal(results.filter((r) => r.decision === "ADMITTED").length, 3);
  assert.equal(results.filter((r) => r.decision === "REJECTED").length, 7);
  assert.equal(harness.store.capUsage(), 3);
});

test("per-cycle limits remain independent of the global admission cap", async (t) => {
  const a = "https://example.test/cycle-a";
  const b = "https://example.test/cycle-b";
  const harness = await makeHarness(t, {
    urls: [a, b],
    capLimit: 10,
    routes: {
      "https://example.test/robots.txt": response({ headers: { "content-type": "text/plain" }, body: ROBOTS }),
      [a]: response({ headers: { "content-type": "text/html; charset=utf-8" }, body: "<html><body>a</body></html>" }),
      [b]: response({ headers: { "content-type": "text/html; charset=utf-8" }, body: "<html><body>b</body></html>" }),
    },
  });

  const result = await runCrawlBatches({
    frontier: harness.frontier,
    admissionGateway: harness.admissionGateway,
    fetchImpl: harness.fetchImpl,
    respectRobots: true,
    allowPrivate: true,
    maxCycles: 1,
    maxDepth: 0,
  });

  assert.equal(result.totalPagesFetched, 1);
  assert.equal(harness.store.capUsage(), 1);
  assert.equal(harness.frontier.summary().queued, 1);
  assert.equal(harness.calls.filter((c) => c.url === a || c.url === b).length, 1);
});
