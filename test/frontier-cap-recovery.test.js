import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Frontier } from "../src/frontier.js";

const tmp = () => mkdtempSync(path.join(tmpdir(), "sma-frontier-cap-"));

test("cap-rejected recovery revives only lastError=cap, preserves audit, and is idempotent", async () => {
  const dir = tmp();
  const f = new Frontier({ dir });
  await f.init();
  const capA = await f.enqueue("https://example.test/cap-a", { depth: 0 });
  const capB = await f.enqueue("https://example.test/cap-b", { depth: 0 });
  const other = await f.enqueue("https://example.test/other-rejection", { depth: 0 });
  const quarantined = await f.enqueue("https://example.test/quarantined", { depth: 0 });
  const visited = await f.enqueue("https://example.test/visited", { depth: 0 });
  assert.ok(capA && capB && other && quarantined && visited);

  await f.markRejected(capA, { reason: "cap", requestId: "req-cap-a", payloadDigest: "a".repeat(64) });
  await f.markRejected(capB, { reason: "cap", requestId: "req-cap-b", payloadDigest: "b".repeat(64) });
  await f.markRejected(other, { reason: "robots-disallowed" });
  await f.markQuarantined(quarantined, { reason: "protocol-violation" });
  const claimed = await f.claimNext();
  assert.equal(claimed.canonical, visited);
  await f.markVisited(visited, { contentHash: "hash" });

  const preview = await f.recoverCapRejected({ epoch: "gateway-next", dryRun: true });
  assert.equal(preview.recovered, 2);
  assert.equal(f.state.get(capA).state, "rejected", "dry run does not mutate state");

  const result = await f.recoverCapRejected({ epoch: "gateway-next" });
  assert.equal(result.recovered, 2);
  assert.equal(f.capRejectedCount(), 0);
  for (const key of [capA, capB]) {
    const record = f.state.get(key);
    assert.equal(record.state, "queued");
    assert.equal(record.lastError, null);
    assert.equal(record.requestId, null);
    assert.equal(record.payloadDigest, null);
    assert.equal(record.recoveryHistory.length, 1);
    assert.equal(record.recoveryHistory[0].type, "cap-rejected-recovery");
    assert.equal(record.recoveryHistory[0].epoch, "gateway-next");
    assert.equal(record.recoveryHistory[0].previousLastError, "cap");
    assert.equal(record.recoveryHistory[0].previousState, "rejected");
  }
  assert.equal(f.state.get(capA).recoveryHistory[0].previousRequestId, "req-cap-a");
  assert.equal(f.state.get(other).state, "rejected", "other rejection reasons are untouched");
  assert.equal(f.state.get(other).lastError, "robots-disallowed");
  assert.equal(f.state.get(quarantined).state, "quarantined");
  assert.equal(f.state.get(visited).state, "visited");

  const audit = path.join(dir, "cap-recovery.ndjson");
  assert.equal(existsSync(audit), true);
  const batch = JSON.parse(readFileSync(audit, "utf8").trim());
  assert.equal(batch.type, "cap-recovery");
  assert.equal(batch.count, 2);
  assert.equal(batch.epoch, "gateway-next");

  const second = await f.recoverCapRejected({ epoch: "gateway-next" });
  assert.equal(second.recovered, 0, "a second run is a no-op");

  const reloaded = new Frontier({ dir });
  await reloaded.init();
  assert.equal(reloaded.capRejectedCount(), 0);
  assert.equal(reloaded.state.get(capA).state, "queued");
  assert.equal(reloaded.state.get(capA).recoveryHistory.length, 1, "audit survives restart");
  assert.equal(reloaded.state.get(other).state, "rejected");
  assert.equal(await reloaded.claimNext() !== null, true, "recovered URLs are claimable");
});

test("a crash before the frontier rewrite leaves the durable rejection recoverable", async () => {
  const dir = tmp();
  const f = new Frontier({ dir });
  await f.init();
  const a = await f.enqueue("https://example.test/crash-a", { depth: 0 });
  const b = await f.enqueue("https://example.test/crash-b", { depth: 0 });
  await f.markRejected(a, { reason: "cap" });
  await f.markRejected(b, { reason: "cap" });

  const originalPersist = f.persist.bind(f);
  f.persist = async () => {
    throw new Error("simulated crash before frontier rewrite");
  };
  await assert.rejects(f.recoverCapRejected({ epoch: "gateway-next" }), /simulated crash/);
  f.persist = originalPersist;

  const afterCrash = new Frontier({ dir });
  await afterCrash.init();
  assert.equal(afterCrash.capRejectedCount(), 2, "the durable file still holds the original rejections");

  const result = await afterCrash.recoverCapRejected({ epoch: "gateway-next" });
  assert.equal(result.recovered, 2);
  const reloaded = new Frontier({ dir });
  await reloaded.init();
  assert.equal(reloaded.capRejectedCount(), 0);
  assert.equal(reloaded.state.get(a).state, "queued");
});

test("a live cap rejection is deferred, not made permanently rejected", async () => {
  const dir = tmp();
  const f = new Frontier({ dir });
  await f.init();
  const url = await f.enqueue("https://example.test/defer", { depth: 0 });
  const claimed = await f.claimNext();
  assert.equal(claimed.canonical, url);
  await f.recordAdmission(url, { requestId: "req-old", payloadDigest: "c".repeat(64) });
  const before = f.state.get(url);
  before.retries = 1;

  await f.deferCapRejected(url, { epoch: "gateway-test-01" });
  const record = f.state.get(url);
  assert.equal(record.state, "queued");
  assert.equal(record.lastError, "cap-deferred");
  assert.equal(record.requestId, null);
  assert.equal(record.payloadDigest, null);
  assert.equal(record.retries, 1, "a cap rejection is not a fetch failure");
  assert.equal(record.capDeferrals.length, 1);
  assert.equal(record.capDeferrals[0].previousRequestId, "req-old");
  assert.equal(record.capDeferrals[0].epoch, "gateway-test-01");
  assert.ok(await f.claimNext(), "the deferred URL remains claimable for the next epoch");
});
