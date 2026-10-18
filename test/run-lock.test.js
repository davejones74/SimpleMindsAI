import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import path from "node:path";
import { RegistryStore } from "../src/storage/registry-store.js";

/**
 * RUN.lock robustness. The production symptom was a continuous training job
 * failing on legitimate contention with `npm run perpetual`, and a lock that
 * could be released by an unrelated process. These tests pin (a) the sanitized
 * diagnostics exposed to operators and (b) ownership-safe release.
 */

const tmpDir = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-runlock-")));
const lockFile = (dir) => path.join(dir, "RUN.lock");

test("runLockInfo exposes holder diagnostics but never the lock token", async () => {
  const dir = tmpDir();
  const r = await RegistryStore.open(dir);
  await r.acquireRunLock(60_000, { runId: "run-abc" });

  const info = r.runLockInfo();
  assert.equal(info.held, true);
  assert.equal(info.pid, process.pid);
  assert.equal(info.runId, "run-abc");
  assert.ok(info.host);
  assert.ok(Number.isFinite(info.heartbeatAgeMs));
  assert.equal("token" in info, false, "the ownership token must never be exposed over an admin view");

  r.releaseRunLock();
  assert.equal(r.runLockInfo(), null);
  await r.close();
});

test("releaseRunLock removes only the lock we hold", async () => {
  const dir = tmpDir();
  const r = await RegistryStore.open(dir);
  await r.acquireRunLock(60_000);
  assert.ok(existsSync(lockFile(dir)));

  // Another process replaces RUN.lock while we still "hold" ours.
  writeFileSync(
    lockFile(dir),
    JSON.stringify({ pid: 999_999, host: "elsewhere", token: "replacement", runId: "run-other", acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() }),
  );

  const res = r.releaseRunLock();
  assert.equal(res.removed, false, "a replaced lock must not be removed");
  assert.ok(existsSync(lockFile(dir)), "the replacement owner's lock must survive our release");

  await r.close();
});

test("releaseRunLock removes our own lock cleanly", async () => {
  const dir = tmpDir();
  const r = await RegistryStore.open(dir);
  await r.acquireRunLock(60_000);
  const res = r.releaseRunLock();
  assert.deepEqual(res, { removed: true, reason: "removed" });
  assert.equal(existsSync(lockFile(dir)), false);
  await r.close();
});

test("a dead owner's lock is still reclaimed and only its run is recovered", async () => {
  const dir = tmpDir();
  const r = await RegistryStore.open(dir);
  const held = await r.createRun({ datasetId: "d" });
  await r.runEvent(held.runId, { status: "running" });

  const ancient = new Date(Date.now() - 120_000).toISOString();
  writeFileSync(lockFile(dir), JSON.stringify({ token: "dead", runId: held.runId, acquiredAt: ancient, heartbeatAt: ancient }));

  assert.equal(await r.acquireRunLock(1_000), true);
  assert.equal(r.getRun(held.runId).status, "failed");
  assert.equal(r.listLockRecoveries().some((x) => x.action === "reclaimed"), true);
  r.releaseRunLock();
  await r.close();
});

test("a dead owner's lock is reclaimed even with a FRESH heartbeat", async () => {
  const dir = tmpDir();
  const r = await RegistryStore.open(dir);
  const held = await r.createRun({ datasetId: "d" });
  await r.runEvent(held.runId, { status: "running" });

  // Owner pid is dead (999999), but the heartbeat is brand-new. The old logic
  // treated a fresh heartbeat as "active" and waited the whole stale window
  // even though the owner was gone; it must reclaim immediately.
  const now = new Date().toISOString();
  writeFileSync(
    lockFile(dir),
    JSON.stringify({ pid: 999_999, host: hostname(), token: "dead", runId: held.runId, acquiredAt: now, heartbeatAt: now }),
  );

  assert.equal(await r.acquireRunLock(60_000), true, "a dead owner's fresh lock must be reclaimed, not waited on");
  assert.equal(r.getRun(held.runId).status, "failed");
  assert.equal(r.listLockRecoveries().some((x) => x.action === "reclaimed"), true);
  r.releaseRunLock();
  await r.close();
});
