import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DiscoveryService } from "../src/discovery/discovery-service.js";
import { createDomainRegistry } from "../src/storage/domain-registry.js";
import { createDiscoveryPolicy } from "../src/discovery/discovery-policy.js";
import { classifyDiscoveryLanguage, DISCOVERY_LANGUAGE_PRIORS } from "../src/discovery/language-prior.js";

/**
 * P4 — discovery language prior (locked decision #4).
 *
 * A candidate URL whose HOST declares a non-English content language is
 * classified up front. `warn` (default) enqueues and counts; `reject` refuses.
 * It is advisory and independent of the ingest-time language filter.
 *
 * A stub frontier (claimNext => null) isolates the candidate-enqueue loop from
 * the actual fetch, so these tests never touch the network.
 */

const reg = () => createDomainRegistry({ dir: mkdtempSync(path.join(tmpdir(), "sma-lp-reg-")), forceNew: true });
const openPolicy = () => createDiscoveryPolicy({ seedUrls: [], mode: "open" });

// No URLs to fetch => runCrawlBatches stops after the bootstrap/adapter pass.
const stubFrontier = () => ({
  initialized: true,
  state: new Map(),
  async init() {},
  async recoverStaleClaims() {},
  async enqueue() {
    return true;
  },
  async claimNext() {
    return null;
  },
  async markVisited() {},
  async markFailed() {},
  summary() {
    return { total: 0, queued: 0, deferred: 0, visited: 0 };
  },
});

function fakeAdapter(candidates) {
  return { name: "fake", kind: "independent", discover: async () => ({ status: "ok", candidates }) };
}

test("classifyDiscoveryLanguage distinguishes declared foreign hosts from English/ordinary ones", () => {
  assert.equal(classifyDiscoveryLanguage("https://ca.wikipedia.org/wiki/Foo", "warn").action, "warn");
  assert.equal(classifyDiscoveryLanguage("https://ca.wikipedia.org/wiki/Foo", "warn").declaredLang, "ca");
  assert.equal(classifyDiscoveryLanguage("https://ca.wikipedia.org/wiki/Foo", "reject").action, "reject");
  assert.equal(classifyDiscoveryLanguage("https://en.wikipedia.org/wiki/Foo", "reject").action, "allow", "English variant always allowed");
  assert.equal(classifyDiscoveryLanguage("https://www.example.com/x", "reject").action, "allow", "ordinary host carries no language signal");
  assert.equal(classifyDiscoveryLanguage("https://fr.wikipedia.org/wiki/X", "off").action, "allow");
  assert.deepEqual(DISCOVERY_LANGUAGE_PRIORS, ["off", "warn", "reject"]);
});

test("warn (default): foreign-language candidates are enqueued but counted", async () => {
  const service = new DiscoveryService({
    frontier: stubFrontier(),
    seeds: [],
    defaultSeeds: [],
    adapters: [fakeAdapter([{ url: "https://ca.wikipedia.org/wiki/Foo" }, { url: "https://en.wikipedia.org/wiki/Bar" }])],
    policy: openPolicy(),
    domainRegistry: reg(),
  });
  const res = await service.collect({ maxPages: 0, allowPrivate: true });
  assert.equal(res.discovery.bootstrap.languagePrior.mode, "warn");
  assert.equal(res.discovery.bootstrap.languagePrior.warned, 1);
  assert.equal(res.discovery.bootstrap.languagePrior.rejected, 0);
  const report = res.discovery.bootstrap.adapters[0];
  assert.equal(report.enqueued, 2, "both candidates enqueued under warn");
});

test("reject: foreign-language-host candidates are refused before fetch", async () => {
  const service = new DiscoveryService({
    frontier: stubFrontier(),
    seeds: [],
    defaultSeeds: [],
    adapters: [fakeAdapter([{ url: "https://ca.wikipedia.org/wiki/Foo" }, { url: "https://en.wikipedia.org/wiki/Bar" }])],
    policy: openPolicy(),
    domainRegistry: reg(),
    languagePrior: "reject",
  });
  const res = await service.collect({ maxPages: 0, allowPrivate: true });
  assert.equal(res.discovery.bootstrap.languagePrior.mode, "reject");
  assert.equal(res.discovery.bootstrap.languagePrior.rejected, 1);
  const report = res.discovery.bootstrap.adapters[0];
  assert.equal(report.enqueued, 1, "only the English candidate enqueued");
  assert.equal(report.rejected, 1, "foreign candidate refused");
});

test("off: declared language is ignored entirely", async () => {
  const service = new DiscoveryService({
    frontier: stubFrontier(),
    seeds: [],
    defaultSeeds: [],
    adapters: [fakeAdapter([{ url: "https://ca.wikipedia.org/wiki/Foo" }])],
    policy: openPolicy(),
    domainRegistry: reg(),
    languagePrior: "off",
  });
  const res = await service.collect({ maxPages: 0, allowPrivate: true });
  assert.equal(res.discovery.bootstrap.languagePrior.warned, 0);
  assert.equal(res.discovery.bootstrap.languagePrior.rejected, 0);
  assert.equal(res.discovery.bootstrap.adapters[0].enqueued, 1);
});
