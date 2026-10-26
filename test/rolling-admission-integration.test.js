import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Frontier } from "../src/frontier.js";
import { runCrawlCycle } from "../src/harness/crawler.js";
import { RollingAdmissionStore } from "../src/gateway/rolling-admission-store.js";
import { AcquisitionGateway, deriveAcquisitionIdentity } from "../src/gateway/acquisition-gateway.js";

const T0 = Date.parse("2026-10-26T21:00:00.000Z");
const tmp = () => mkdtempSync(path.join(tmpdir(), "sma-rolling-integration-"));
const response = ({ status = 200, body = "", headers = {} } = {}) =>
  new Response(status === 304 ? null : body, { status, headers });

function fetchFor(routes) {
  return async (url) => {
    const route = routes[String(url)];
    if (!route) return response({ status: 404, body: "missing" });
    return typeof route === "function" ? route({ url: String(url) }) : route;
  };
}

test("crawler defers quota work without fetch and retries the same request ID after capacity returns", async () => {
  const root = tmp();
  let now = T0;
  const clock = () => new Date(now);
  const store = await RollingAdmissionStore.open({
    dir: path.join(root, "admission"),
    clock,
    config: {
      policyVersion: "rolling-v1",
      policyMode: "rolling",
      capEpoch: "rolling-integration-epoch",
      ackRequired: false,
      protocolVersion: "baseline-v1",
      quotaWindowMs: 1000,
      quotaLimit: 1,
      perDomainLimit: 100,
      perDomainWindowMs: 1000,
      rateWindowMs: 1000,
      rateLimit: 100,
      maxConcurrent: 1,
      storageMinFreeBytes: 0,
      storageMaxDbBytes: 0,
      storageRetryMs: 100,
      deferralRetentionMs: 60_000,
      deferralMaxRows: 100,
    },
  });
  const frontier = new Frontier({ dir: path.join(root, "frontier") });
  await frontier.init();
  const first = await frontier.enqueue("https://a.test/one", { depth: 0 });
  const second = await frontier.enqueue("https://b.test/two", { depth: 0 });
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const routes = {
      "https://a.test/robots.txt": response({ headers: { "content-type": "text/plain" }, body: "User-agent: *\nAllow: /\n" }),
      "https://b.test/robots.txt": response({ headers: { "content-type": "text/plain" }, body: "User-agent: *\nAllow: /\n" }),
      "https://a.test/one": response({ headers: { "content-type": "text/html" }, body: "<html><body>one</body></html>" }),
      "https://b.test/two": response({ headers: { "content-type": "text/html" }, body: "<html><body>two</body></html>" }),
    };
    return routes[String(url)] ?? response({ status: 404, body: "missing" });
  };
  const gateway = new AcquisitionGateway({ store });
  try {
    const firstResult = await runCrawlCycle({
      frontier,
      admissionGateway: gateway,
      fetchImpl,
      allowPrivate: true,
      maxDepth: 1,
    });
    assert.equal(firstResult.documents.length, 1);

    const secondResult = await runCrawlCycle({
      frontier,
      admissionGateway: gateway,
      fetchImpl,
      allowPrivate: true,
      maxDepth: 1,
    });
    assert.equal(secondResult.documents.length, 0);
    assert.equal(secondResult.admissionQuotaDeferred, 1);
    assert.equal(secondResult.quotaExhausted, true);
    assert.equal(secondResult.quotaUsed, 1);
    assert.equal(secondResult.quotaLimit, 1);
    assert.equal(calls.filter((u) => u === "https://b.test/two").length, 0, "deferred URL is not fetched");
    assert.equal(frontier.state.get(second).state, "queued");
    assert.equal(frontier.state.get(second).admissionDeferral.reason, "quota");

    const identity = deriveAcquisitionIdentity({
      config: store.sealedConfig,
      url: second,
      generation: 0,
      userAgent: undefined,
      respectRobots: true,
      maxRedirects: 3,
    });
    assert.equal(store.getDecision(identity.requestId), null, "deferral wrote no durable decision");

    now = T0 + 1000;
    const retryResult = await runCrawlCycle({
      frontier,
      admissionGateway: gateway,
      fetchImpl,
      allowPrivate: true,
      maxDepth: 1,
    });
    assert.equal(retryResult.documents.length, 1);
    assert.equal(store.getDecision(identity.requestId).decision, "ADMITTED");
    assert.equal(calls.filter((u) => u === "https://b.test/two").length, 1);
    assert.equal(frontier.state.get(first).state, "visited");
    assert.equal(frontier.state.get(second).state, "visited");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
