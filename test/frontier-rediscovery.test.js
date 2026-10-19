import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Frontier } from "../src/frontier.js";

const tmp = () => mkdtempSync(path.join(tmpdir(), "sma-frontier-redisc-"));

const HOUR = 60 * 60 * 1000;

async function freshFrontier() {
  const f = new Frontier({ dir: tmp() });
  await f.init();
  return f;
}

test("markVisited stores conditional validators and a rediscovery deadline", async () => {
  const f = await freshFrontier();
  const key = await f.enqueue("https://example.com/a", { depth: 0 });
  assert.ok(key);
  const nextCrawlAt = new Date(Date.now() + 7 * 24 * HOUR).toISOString();
  await f.markVisited(key, {
    contentHash: "abc",
    etag: '"v1"',
    lastModified: "Wed, 01 Jan 2026 00:00:00 GMT",
    nextCrawlAt,
  });
  const rec = f.state.get(key);
  assert.equal(rec.state, "visited");
  assert.equal(rec.etag, '"v1"');
  assert.equal(rec.lastModified, "Wed, 01 Jan 2026 00:00:00 GMT");
  assert.equal(rec.contentHash, "abc");
  assert.equal(rec.nextCrawlAt, nextCrawlAt);
  assert.ok(rec.lastFetchedAt);
});

test("validators survive a persist/reload round-trip", async () => {
  const dir = tmp();
  const f = new Frontier({ dir });
  await f.init();
  const key = await f.enqueue("https://example.com/b", { depth: 0 });
  await f.markVisited(key, { etag: '"e"', lastModified: "lm", nextCrawlAt: new Date(Date.now() - 1000).toISOString() });
  const f2 = new Frontier({ dir });
  await f2.init();
  const rec = f2.state.get(key);
  assert.equal(rec.etag, '"e"');
  assert.equal(rec.lastModified, "lm");
  assert.ok(rec.nextCrawlAt);
});

test("rediscovery: a due VISITED URL is claimable, but NOT before its TTL and NOT when disabled", async () => {
  const f = await freshFrontier();
  const key = await f.enqueue("https://example.com/c", { depth: 0 });
  await f.markVisited(key, { nextCrawlAt: new Date(Date.now() + HOUR).toISOString() });

  // Not yet due.
  assert.equal(await f.claimNext({ rediscoveryEnabled: true }), null);
  // Disabled: never re-claimed even if due.
  const f2 = await freshFrontier();
  const k2 = await f2.enqueue("https://example.com/d", { depth: 0 });
  await f2.markVisited(k2, { nextCrawlAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(await f2.claimNext({ rediscoveryEnabled: false }), null);
  // Enabled + due → claimed as a rediscovery.
  const claimed = await f2.claimNext({ rediscoveryEnabled: true });
  assert.ok(claimed);
  assert.equal(claimed.canonical, k2);
  assert.equal(claimed.rediscovery, true);
});

test("revisiting does NOT starve new work: QUEUED is claimed before a due discovery", async () => {
  const f = await freshFrontier();
  const old = await f.enqueue("https://example.com/old", { depth: 0 });
  await f.markVisited(old, { nextCrawlAt: new Date(Date.now() - 1000).toISOString() });
  const fresh = await f.enqueue("https://example.com/new", { depth: 0 });

  const first = await f.claimNext({ rediscoveryEnabled: true });
  assert.equal(first.canonical, fresh);
  assert.equal(first.rediscovery, false);
  const second = await f.claimNext({ rediscoveryEnabled: true });
  assert.equal(second.canonical, old);
  assert.equal(second.rediscovery, true);
});

test("failed URLs back off independently and never block queued work", async () => {
  const f = await freshFrontier();
  const bad = await f.enqueue("https://example.com/bad", { depth: 0 });
  const claimed = await f.claimNext();
  assert.equal(claimed.canonical, bad);
  await f.markFailed(bad, {
    reason: "FETCH_TIMEOUT",
    maxRetries: 3,
    backoffBaseMs: HOUR,
    backoffMaxMs: 24 * HOUR,
    now: Date.now(),
  });
  const rec = f.state.get(bad);
  assert.equal(rec.state, "deferred");
  assert.ok(rec.nextAttemptAt, "a retry is scheduled");
  // Not yet due → claimNext returns null even though retries remain.
  assert.equal(await f.claimNext(), null);

  // New work is still claimable immediately, ahead of the backed-off retry.
  const fresh = await f.enqueue("https://example.com/new", { depth: 0 });
  assert.equal((await f.claimNext()).canonical, fresh);

  // Once the backoff elapses, the retry becomes claimable.
  const due = await f.claimNext({ now: Date.now() + 2 * HOUR });
  assert.equal(due.canonical, bad);
});

test("exhausted retries become terminal FAILED with no further retry schedule", async () => {
  const f = await freshFrontier();
  const key = await f.enqueue("https://example.com/x", { depth: 0 });
  await f.claimNext();
  await f.markFailed(key, { reason: "FETCH_NETWORK", maxRetries: 2, backoffBaseMs: HOUR, now: Date.now() });
  // Second claim/failure exhausts retries.
  assert.equal((await f.claimNext({ now: Date.now() + 10 * HOUR })).canonical, key);
  await f.markFailed(key, { reason: "FETCH_NETWORK", maxRetries: 2, backoffBaseMs: HOUR, now: Date.now() + 10 * HOUR });
  const rec = f.state.get(key);
  assert.equal(rec.state, "failed");
  assert.equal(rec.retries, 2);
  assert.equal(rec.nextAttemptAt, null);
  assert.equal(await f.claimNext({ now: Date.now() + 100 * HOUR }), null);
});

test("a policy refusal is terminal (not retried)", async () => {
  const f = await freshFrontier();
  const key = await f.enqueue("https://example.com/blocked", { depth: 0 });
  await f.claimNext();
  await f.markFailed(key, { reason: "domain_blocked", incrementRetries: false });
  const rec = f.state.get(key);
  assert.equal(rec.state, "failed");
  assert.equal(rec.nextAttemptAt, null);
});

test("summary reports rediscovery due and the next scheduled deadline", async () => {
  const f = await freshFrontier();
  const dueKey = await f.enqueue("https://example.com/due", { depth: 0 });
  await f.markVisited(dueKey, { nextCrawlAt: new Date(Date.now() - 1000).toISOString() });
  const laterKey = await f.enqueue("https://example.com/later", { depth: 0 });
  await f.markVisited(laterKey, { nextCrawlAt: new Date(Date.now() + HOUR).toISOString() });

  const s = f.summary();
  assert.equal(s.rediscoveryDue, 1);
  const nextTs = new Date(s.nextDueAt).getTime();
  assert.ok(Number.isFinite(nextTs));
  // The earliest deadline is the already-due one, not the one an hour out.
  assert.ok(nextTs < Date.now() + 1000);
});
