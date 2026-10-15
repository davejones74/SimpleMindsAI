import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createDomainRegistry,
  canonicalDomain,
  matchesDomain,
  DOMAIN_POLICY,
  DOMAIN_ORIGIN,
} from "../src/storage/domain-registry.js";

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-domreg-")), "registry");
const cleanup = (dir) => rmSync(path.dirname(dir), { recursive: true, force: true });
// Isolated instance per test: `forceNew` bypasses the per-directory singleton
// so two tests never share state.
const registry = (dir) => createDomainRegistry({ dir, forceNew: true });

/** 1. A newly discovered domain is registered once. */
test("registerDomain: registers a new domain", async () => {
  const dir = tmp();
  const reg = registry(dir);
  await reg.init();
  const r = await reg.registerDomain("https://en.wikipedia.org/wiki/Steam_engine", { source: "seed" });
  assert.equal(r.ok, true);
  assert.equal(r.domain, "en.wikipedia.org");
  assert.equal(reg.has("en.wikipedia.org"), true);
  const rec = reg.get("en.wikipedia.org");
  assert.equal(rec.policy, DOMAIN_POLICY.NORMAL);
  assert.equal(rec.origin, DOMAIN_ORIGIN.AUTO);
  assert.equal(rec.discoverySource, "seed");
  cleanup(dir);
});

/** 2. Re-registering the same domain is idempotent. */
test("registerDomain: repeated discovery does not duplicate", async () => {
  const dir = tmp();
  const reg = registry(dir);
  await reg.init();
  await reg.registerDomain("en.wikipedia.org");
  await reg.registerDomain("EN.Wikipedia.ORG");
  await reg.registerDomain("https://en.wikipedia.org/wiki/Other");
  assert.equal(reg.list().length, 1);
  const rec = reg.get("en.wikipedia.org");
  assert.ok(rec.firstDiscoveredAt, "first-discovered is preserved");
  cleanup(dir);
});

/** 3. Persistence survives a restart. */
test("persistence: domain policies survive a restart", async () => {
  const dir = tmp();
  const reg = registry(dir);
  await reg.init();
  await reg.registerDomain("example.com");
  await reg.setImportant("example.com", true);
  await reg.registerDomain("blocked.test");
  await reg.blockDomain("blocked.test", { reason: "operator choice" });

  // Simulate a process restart: fresh registry over the same directory.
  const reg2 = registry(dir);
  await reg2.init();
  assert.equal(reg2.get("example.com").policy, DOMAIN_POLICY.IMPORTANT);
  const blocked = reg2.get("blocked.test");
  assert.equal(blocked.policy, DOMAIN_POLICY.BLOCKED);
  assert.equal(blocked.policyReason, "operator choice");
  assert.ok(blocked.policyChangedAt);
  cleanup(dir);
});

/** 4. A missing directory must not break persistence (operator cleanup). */
test("persistence: recreates a deleted data directory instead of throwing", async () => {
  const dir = tmp();
  const reg = registry(dir);
  await reg.init();
  await reg.registerDomain("example.com");

  // Remove the whole registry directory, as an operator cleanup would.
  rmSync(path.dirname(dir), { recursive: true, force: true });
  assert.equal(existsSync(path.dirname(dir)), false);

  // The NEXT write must recreate the directory rather than throwing ENOENT.
  const reg2 = registry(dir);
  await reg2.init();
  await reg2.registerDomain("second.test");
  assert.equal(reg2.has("second.test"), true);

  const reg3 = registry(dir);
  await reg3.init();
  assert.equal(reg3.has("second.test"), true, "record survives the recreation");
  cleanup(dir);
});

/** 5. A torn tail must not lose earlier records on reload. */
test("persistence: a truncated final line does not lose earlier domains", async () => {
  const dir = tmp();
  const reg = registry(dir);
  await reg.init();
  await reg.registerDomain("first.test");
  await reg.registerDomain("second.test");

  // Simulate a crash mid-write: append a partial line to the ledger.
  const file = path.join(dir, "domains.ndjson");
  writeFileSync(file, readFileSync(file, "utf8") + '{"domain":"torn.te', { flag: "a" });

  const reg2 = registry(dir);
  await reg2.init();
  assert.equal(reg2.has("first.test"), true);
  assert.equal(reg2.has("second.test"), true);
  cleanup(dir);
});

/** 6. No temp debris is left behind after a successful write. */
test("persistence: leaves no temp file behind", async () => {
  const dir = tmp();
  const reg = registry(dir);
  await reg.init();
  await reg.registerDomain("example.com");
  const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp"));
  assert.deepEqual(leftovers, []);
  cleanup(dir);
});

/** 7. Canonicalisation: path/query/port/scheme/case are stripped. */
test("canonicalDomain: strips path, query, port, scheme and case", () => {
  assert.equal(canonicalDomain("https://EN.wikipedia.org:443/wiki/X?q=1#frag"), "en.wikipedia.org");
  assert.equal(canonicalDomain("http://example.com:8080/a?b=c"), "example.com");
  assert.equal(canonicalDomain("HTTPS://Sub.Example.COM/x"), "sub.example.com");
  assert.equal(canonicalDomain("example.com"), "example.com");
  assert.equal(canonicalDomain(""), null);
  assert.equal(canonicalDomain("not a url"), null);
  assert.equal(canonicalDomain(null), null);
});

/** 8. Subdomain matching happens on DNS label boundaries. */
test("matchesDomain: label boundaries only", () => {
  assert.equal(matchesDomain("wikipedia.org", "wikipedia.org"), true);
  assert.equal(matchesDomain("en.wikipedia.org", "wikipedia.org"), true);
  assert.equal(matchesDomain("a.b.wikipedia.org", "wikipedia.org"), true);
  // Must NOT match a domain that merely ends with the same characters.
  assert.equal(matchesDomain("notwikipedia.org", "wikipedia.org"), false);
  assert.equal(matchesDomain("xwikipedia.org", "wikipedia.org"), false);
  assert.equal(matchesDomain("wikipedia.org.evil.test", "wikipedia.org"), false);
});

/** 9. Removal is not a block: the domain disappears and can come back. */
test("removeDomain: removal is not a permanent block", async () => {
  const dir = tmp();
  const reg = registry(dir);
  await reg.init();
  await reg.registerDomain("example.test");
  await reg.setImportant("example.test", true);
  const removed = await reg.removeDomain("example.test");
  assert.equal(removed.ok, true);
  assert.equal(reg.has("example.test"), false, "removed from the active registry");
  // Rediscovery recreates a record — with NORMAL policy, not the old preference.
  await reg.registerDomain("example.test");
  assert.equal(reg.has("example.test"), true);
  assert.equal(reg.get("example.test").policy, DOMAIN_POLICY.NORMAL);
  cleanup(dir);
});

/** 10. Block takes precedence over importance and rejects unknown domains. */
test("setPolicy: blocked beats important; unknown domains are refused", async () => {
  const dir = tmp();
  const reg = registry(dir);
  await reg.init();
  await reg.registerDomain("example.test");
  await reg.blockDomain("example.test", { reason: "operator" });
  const attempt = await reg.setImportant("example.test", true);
  assert.equal(attempt.ok, false, "importance must not override a block");
  assert.equal(attempt.reason, "blocked-domain");
  assert.equal(reg.get("example.test").policy, DOMAIN_POLICY.BLOCKED,
    "a block must never be overridden by importance");

  // An explicit unblock is the ONLY way out of `blocked`.
  const unblocked = await reg.unblockDomain("example.test");
  assert.equal(unblocked.ok, true);
  assert.equal(reg.get("example.test").policy, DOMAIN_POLICY.NORMAL);

  const unknown = await reg.setImportant("never-seen.test", true);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, "not-found");
  cleanup(dir);
});

/** 11. Operator actions on a non-registered domain fail cleanly. */
test("blockDomain/unblockDomain: refuse unknown domains", async () => {
  const dir = tmp();
  const reg = registry(dir);
  await reg.init();
  const b = await reg.blockDomain("nope.test");
  assert.equal(b.ok, false);
  assert.equal(b.reason, "not-found");
  const u = await reg.unblockDomain("nope.test");
  assert.equal(u.ok, false);
  assert.equal(u.reason, "not-found");
  cleanup(dir);
});

/** 12. Fetch counters accumulate from real outcomes. */
test("recordDiscovery/recordFetchSuccess/recordFetchFailure: counters follow outcomes", async () => {
  const dir = tmp();
  const reg = registry(dir);
  await reg.init();
  await reg.registerDomain("example.test");
  await reg.recordDiscovery("example.test", { url: "https://example.test/a", parentUrl: "https://seed.test/", depth: 1, trust: "discovered" });
  await reg.recordDiscovery("example.test", { url: "https://example.test/b" });
  await reg.recordFetchSuccess("example.test", { url: "https://example.test/a", contentHash: "abc123" });
  await reg.recordFetchFailure("example.test", { url: "https://example.test/c", error: "robots-disallowed" });

  const rec = reg.get("example.test");
  assert.equal(rec.urlsDiscovered, 2);
  assert.equal(rec.documentsFetched, 1);
  assert.equal(rec.failureCount, 1);
  assert.equal(rec.lastContentHash, "abc123");
  assert.equal(rec.lastError, "robots-disallowed");
  assert.ok(rec.lastSuccessfulFetch);
  assert.ok(rec.firstDiscoveredVia, "first discovery keeps its provenance");
  cleanup(dir);
});

/** 13. Stats reflect policy and origin. */
test("getStats: counts by policy and origin", async () => {
  const dir = tmp();
  const reg = registry(dir);
  await reg.init();
  await reg.registerDomain("a.test");
  await reg.registerDomain("b.test", { origin: DOMAIN_ORIGIN.MANUAL });
  await reg.setImportant("a.test", true);
  await reg.registerDomain("c.test");
  await reg.blockDomain("c.test");
  const s = reg.getStats();
  assert.equal(s.total, 3);
  assert.equal(s.byPolicy.normal, 1);
  assert.equal(s.byPolicy.important, 1);
  assert.equal(s.byPolicy.blocked, 1);
  assert.equal(s.byOrigin.auto, 2);
  assert.equal(s.byOrigin.manual, 1);
  cleanup(dir);
});

/**
 * 14. CONCURRENCY REGRESSION.
 *
 * The original bug: three call sites each built their own registry over the same
 * file, so writes raced. One instance's cleanup unlinked another's temp file
 * and the next rename failed with ENOENT; Windows refused to overwrite a locked
 * destination and gave EPERM. A single page linking ~50 domains produced that
 * storm dozens of times per cycle.
 */
test("concurrency: many rapid discoveries are serialised into clean writes", async () => {
  const dir = tmp();
  const reg = registry(dir);
  await reg.init();

  // One crawl cycle discovering many links at once, all fired without awaiting.
  const pending = [];
  for (let i = 0; i < 60; i++) {
    pending.push(
      reg.recordDiscovery(`host${i}.test`, {
        url: `https://host${i}.test/page`,
        parentUrl: "https://seed.test/",
        depth: 1,
        trust: "discovered",
      }),
    );
  }
  await Promise.all(pending);

  assert.equal(reg.list().length, 60, "every discovery is registered");
  assert.equal(reg.get("host0.test").urlsDiscovered, 1);
  assert.equal(reg.get("host59.test").urlsDiscovered, 1);

  // No debris: a failed or interleaved write leaves a .tmp file behind.
  const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp"));
  assert.deepEqual(leftovers, [], `temp debris left behind: ${leftovers.join(", ")}`);

  // The final file must be complete and reloadable — a torn write loses domains.
  const reloaded = registry(dir);
  await reloaded.init();
  assert.equal(reloaded.list().length, 60, "no domain lost to a torn write");
  cleanup(dir);
});

/** 15. createDomainRegistry defaults to ONE shared instance per directory. */
test("createDomainRegistry: callers share one authority per directory", async () => {
  const dir = tmp();
  const a = createDomainRegistry({ dir });
  const b = createDomainRegistry({ dir });
  assert.equal(a, b, "two callers on the same dir must not race as strangers");
  await a.init();
  await a.registerDomain("shared.test");
  assert.equal(b.has("shared.test"), true, "the second caller sees the first caller's write");
  cleanup(dir);
});
