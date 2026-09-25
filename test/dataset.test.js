import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RegistryStore } from "../src/storage/registry-store.js";
import { buildSnapshot, enforceSyntheticCap, snapshotRowReader } from "../src/dataset/snapshot.js";
import { loadEvaluationSet, makeEvalGuard, pairHash } from "../src/dataset/evaluation-set.js";

const tmpDir = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-ds-")));

const row = (i, origin = "curated", reward = 8) => ({
  promptId: `p_${i}`, prompt: `Prompt ${i}`, completionId: `c_${i}`,
  completion: `Completion ${i}`, origin, domain: "general", reward, createdAt: new Date().toISOString(),
});

test("snapshot is immutable, hash-sealed, provenance-carrying", async () => {
  const reg = await RegistryStore.open(tmpDir());
  const snapDir = tmpDir();
  const rows = [row(1), row(2), row(3, "synthetic", 9)];

  const a = await buildSnapshot({ registry: reg, rowsRaw: rows, source: "buffer", dir: snapDir, maxSyntheticShare: 1 });
  assert.equal(a.manifest.recordCount, 3);
  assert.equal(a.manifest.syntheticCount, 1);
  assert.equal(a.manifest.source, "buffer");
  assert.equal(a.manifest.datasetVersion, a.hash.slice(0, 12));
  assert.ok(existsSync(a.file));
  assert.deepEqual((await snapshotRowReader.read(a.file)).map((r) => r.promptId), ["p_1", "p_2", "p_3"]);

  // A different rows set => NEW datasetId/version/file; old file untouched.
  const b = await buildSnapshot({ registry: reg, rowsRaw: [row(1), row(2)], dir: snapDir, maxSyntheticShare: 1 });
  assert.notEqual(a.manifest.datasetId, b.manifest.datasetId);
  assert.notEqual(a.manifest.datasetVersion, b.manifest.datasetVersion);
  assert.equal(reg.listSnapshots().length, 2);
  await reg.close();
});

test("maxSyntheticShare: excess synthetic dropped lowest-reward-first, recorded", async () => {
  const rows = [
    row(1, "synthetic", 5), row(2, "synthetic", 2), row(3, "synthetic", 9),
    row(4, "curated", 7), row(5, "curated", 7), row(6, "curated", 7), row(7, "curated", 7),
  ];
  const { rows: kept, dropped, cap } = enforceSyntheticCap(rows, { maxSyntheticShare: 0.2 });
  assert.equal(cap, 1); // 7 * 0.2 = 1
  assert.equal(kept.length, 5); // 6 - 1 allowed synthetic
  assert.equal(dropped.length, 2);
  assert.deepEqual(dropped.map((r) => r.reward).sort((a, b) => a - b), [2, 5]); // lowest dropped first

  const reg = await RegistryStore.open(tmpDir());
  const snap = await buildSnapshot({ registry: reg, rowsRaw: rows, dir: tmpDir() });
  assert.equal(snap.manifest.syntheticCount, 1); // exactly the surviving 9-reward row
  assert.equal(snap.manifest.droppedSynthetic.length, 2);
  assert.equal(snap.dropped.length, 2);
  await reg.close();
});

test("evaluation leak guard: eval-set pairs can never enter training snapshot", async () => {
  const evalDir = tmpDir();
  const evalSet = await loadEvaluationSet({
    dir: evalDir,
    seed: () => [{ promptId: "e1", prompt: "Prompt 1", completion: "Completion 1" }],
  });
  assert.equal(evalSet.size, 1);

  // Re-load: file is frozen, seed is never consulted again -> still 1, not appended.
  const reloaded = await loadEvaluationSet({
    dir: evalDir,
    seed: () => [{ promptId: "e9", prompt: "Prompt 9", completion: "Completion 9" }],
  });
  assert.equal(reloaded.items.length, 1);

  const guard = makeEvalGuard(evalSet);
  const { kept, excluded } = guard.filter([row(1), row(2), row(3)]);
  assert.deepEqual(excluded.map((r) => r.promptId), ["p_1"]);
  assert.deepEqual(kept.map((r) => r.promptId), ["p_2", "p_3"]);
  assert.equal(guard.contains(row(1)), true);
  assert.equal(pairHash("Prompt 2", "Completion 2").length, 32);
});