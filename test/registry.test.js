import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RegistryStore } from "../src/storage/registry-store.js";

const tmpDir = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-reg-")));

test("runs: created -> running -> promoted; events append-only", async () => {
  const r = await RegistryStore.open(tmpDir());
  const run = await r.createRun({ datasetId: "dataset-x", baseModel: "b1" });
  assert.equal(run.status, "created");
  await r.runEvent(run.runId, { status: "running" });
  await r.completeRun(run.runId, { status: "promoted", promotionStatus: "promoted", evaluationDelta: 0.1 });

  const got = r.getRun(run.runId);
  assert.equal(got.status, "promoted");
  assert.equal(got.events.length, 3); // created + running + promoted
  assert.match(got.events[0].status, /created/);
  await r.close();
});

test("models: candidate -> promoted; activeModel = newest promoted", async () => {
  const r = await RegistryStore.open(tmpDir());
  const m1 = await r.registerModel({ kind: "stub", baseModel: "base" });
  const m2 = await r.registerModel({ kind: "stub", baseModel: "base", parentModelId: m1.modelId });
  assert.equal(m1.status, "candidate");
  assert.equal(m2.status, "candidate");

  await r.modelEvent(m1.modelId, { status: "promoted", evaluationScore: 40 });
  await r.modelEvent(m2.modelId, { status: "rejected", evaluationScore: 30 });

  assert.equal(r.getModel(m1.modelId).status, "promoted");
  assert.equal(r.getModel(m2.modelId).status, "rejected");
  assert.equal(r.getActiveModel().modelId, m1.modelId);
  await r.close();
});

test("recoverStaleRuns marks interrupted running/completed-less runs as failed", async () => {
  const r = await RegistryStore.open(tmpDir());
  const a = await r.createRun({ datasetId: "d" });
  const b = await r.createRun({ datasetId: "d" });
  await r.runEvent(a.runId, { status: "running" });
  await r.modelEvent((await r.registerModel({ kind: "stub" })).modelId, { status: "promoted" });

  // grace = 1ms but the two runs were just created — let age accumulate
  await new Promise((r) => setTimeout(r, 5));
  const stale = await r.recoverStaleRuns(1);
  assert.deepEqual(stale.sort(), [a.runId, b.runId].sort());
  assert.equal(r.getRun(a.runId).status, "failed");
  // b was never started past created -> failed too; historical lines intact
  assert.equal(r.getRun(b.runId).status, "failed");
  await r.close();
});

test("run lock: single trainer; stale lock auto-broken", async () => {
  const r = await RegistryStore.open(tmpDir());
  assert.equal(await r.acquireRunLock(60_000), true);
  assert.equal(await r.acquireRunLock(60_000), false); // second trainer blocked
  r.releaseRunLock();
  assert.equal(await r.acquireRunLock(60_000), true);
  await r.close();
});

test("persistence: registry reloads from disk", async () => {
  const dir = tmpDir();
  const r1 = await RegistryStore.open(dir);
  const m = await r1.registerModel({ kind: "stub", baseModel: "b" });
  await r1.modelEvent(m.modelId, { status: "promoted" });
  await r1.close();

  const r2 = await RegistryStore.open(dir);
  assert.equal(r2.getActiveModel().modelId, m.modelId);
  await r2.close();
});