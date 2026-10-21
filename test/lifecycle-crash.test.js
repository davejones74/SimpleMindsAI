import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArticleStore } from "../src/storage/article-store.js";
import { RegistryStore } from "../src/storage/registry-store.js";
import { executeFullRun, recoverPendingPromotions } from "../src/training/lifecycle.js";

/**
 * Crash recovery around the promotion boundary. The exactly-once consumption
 * commit runs LAST, after publish/activate/manifest, so a crash anywhere before
 * it must be recoverable: the version is named in the manifest, every earlier
 * step is idempotent, and a restart finishes the run without double-consuming or
 * double-publishing. These tests write the manifests a crashed process would
 * leave behind and drive the real recovery code.
 */

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-crash-")));

async function writeManifest(dir, runId, manifest) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${runId}-manifest.json`);
  await writeFile(file, JSON.stringify({ runId, ...manifest }, null, 2), "utf8");
  return file;
}

async function readManifest(dir, runId) {
  return JSON.parse(await readFile(path.join(dir, `${runId}-manifest.json`), "utf8"));
}

function recorder() {
  const calls = { publish: [], activate: [], consume: [], defer: [] };
  return {
    calls,
    trainer: {
      publishCandidate: async (v) => { calls.publish.push(v); return { published: v }; },
      discardCandidate: async () => ({ discarded: true }),
    },
    setActive: async (v) => { calls.activate.push(v); return { version: v }; },
    store: {
      markConsumed: async (ids) => { calls.consume.push(ids); return { consumed: ids, skipped: [] }; },
      deferArticles: async (ids) => { calls.defer.push(ids); return { deferred: ids, retired: [], skipped: [] }; },
    },
  };
}

test("recovery: a promoted manifest left unconsumed is published, activated and consumed exactly once", async () => {
  const dir = tmp();
  await writeManifest(dir, "run-1", {
    decision: "promoted",
    status: "promoted",
    consumed: false,
    published: false,
    resultVersion: "v002",
    snapshotArticleIds: ["a1", "a2"],
  });
  const registry = await RegistryStore.open(tmp());
  const r = recorder();

  const recovered = await recoverPendingPromotions({
    registry,
    store: r.store,
    trainer: r.trainer,
    setActive: r.setActive,
    options: { paths: { snapshots: dir, models: tmp() } },
    logger: { error() {}, log() {} },
  });

  assert.deepEqual(recovered, [{ runId: "run-1", decision: "promoted" }]);
  assert.deepEqual(r.calls.publish, ["v002"], "an unpublished staged candidate must be published");
  assert.deepEqual(r.calls.activate, ["v002"], "the active pointer must move to the candidate");
  assert.deepEqual(r.calls.consume, [["a1", "a2"]], "consumption must be committed exactly once");

  const after = await readManifest(dir, "run-1");
  assert.equal(after.consumed, true);
  assert.equal(after.published, true);
  assert.equal(after.status, "promoted");

  // Idempotent: a second sweep must do nothing to an already-committed run.
  const again = await recoverPendingPromotions({
    registry,
    store: r.store,
    trainer: r.trainer,
    setActive: r.setActive,
    options: { paths: { snapshots: dir, models: tmp() } },
    logger: { error() {}, log() {} },
  });
  assert.deepEqual(again, [], "a consumed manifest is skipped");
  assert.deepEqual(r.calls.consume, [["a1", "a2"]], "no second consumption");
  assert.deepEqual(r.calls.activate, ["v002"], "no second activation");

  await registry.close();
});

test("recovery: a crash AFTER publishing does not re-publish, but still activates and consumes", async () => {
  const dir = tmp();
  await writeManifest(dir, "run-2", {
    decision: "promoted",
    status: "promoted",
    consumed: false,
    published: true, // publication already durable before the crash
    resultVersion: "v007",
    snapshotArticleIds: ["b1"],
  });
  const registry = await RegistryStore.open(tmp());
  const r = recorder();

  await recoverPendingPromotions({
    registry,
    store: r.store,
    trainer: r.trainer,
    setActive: r.setActive,
    options: { paths: { snapshots: dir, models: tmp() } },
    logger: { error() {}, log() {} },
  });

  assert.deepEqual(r.calls.publish, [], "an already-published version must not be published again");
  assert.deepEqual(r.calls.activate, ["v007"]);
  assert.deepEqual(r.calls.consume, [["b1"]]);
  await registry.close();
});

test("recovery: a rejected manifest is deferred, never consumed, published or activated", async () => {
  const dir = tmp();
  await writeManifest(dir, "run-3", {
    decision: "rejected",
    status: "rejected",
    consumed: false,
    published: false,
    resultVersion: "v009",
    snapshotArticleIds: ["c1", "c2", "c3"],
  });
  const registry = await RegistryStore.open(tmp());
  const r = recorder();

  const recovered = await recoverPendingPromotions({
    registry,
    store: r.store,
    trainer: r.trainer,
    setActive: r.setActive,
    options: { paths: { snapshots: dir, models: tmp() } },
    logger: { error() {}, log() {} },
  });

  assert.deepEqual(recovered, [{ runId: "run-3", decision: "rejected", deferred: true }]);
  assert.deepEqual(r.calls.publish, [], "a rejected candidate is never published");
  assert.deepEqual(r.calls.activate, [], "a rejected candidate never becomes active");
  assert.deepEqual(r.calls.consume, [], "the rejected run's material must NOT be consumed");
  assert.deepEqual(r.calls.defer, [["c1", "c2", "c3"]], "the rejected run's material is deferred for retry");
  const after = await readManifest(dir, "run-3");
  assert.equal(after.consumed, false);
  assert.equal(after.settled, true);
  await registry.close();
});

test("recovery: consumed terminal manifests are ignored entirely", async () => {
  const dir = tmp();
  await writeManifest(dir, "run-4", { decision: "promoted", consumed: true, resultVersion: "v001", snapshotArticleIds: ["z"] });
  await writeManifest(dir, "run-5", { decision: "rejected", consumed: true, resultVersion: "v002", snapshotArticleIds: ["z"] });
  const registry = await RegistryStore.open(tmp());
  const r = recorder();

  const recovered = await recoverPendingPromotions({
    registry,
    store: r.store,
    trainer: r.trainer,
    setActive: r.setActive,
    options: { paths: { snapshots: dir, models: tmp() } },
    logger: { error() {}, log() {} },
  });

  assert.deepEqual(recovered, []);
  assert.deepEqual(r.calls.publish, []);
  assert.deepEqual(r.calls.activate, []);
  assert.deepEqual(r.calls.consume, []);
  await registry.close();
});

test("recovery: a promoted manifest that cannot name its candidate fails closed without consuming (F2 regression)", async () => {
  const dir = tmp();
  // Before the fix, `resultVersion` was never written: this is the exact state a
  // crash after the promotion decision used to leave behind.
  await writeManifest(dir, "run-6", {
    decision: "promoted",
    status: "promoted",
    consumed: false,
    published: false,
    resultVersion: null,
    snapshotArticleIds: ["d1"],
  });
  const registry = await RegistryStore.open(tmp());
  const r = recorder();

  const recovered = await recoverPendingPromotions({
    registry,
    store: r.store,
    trainer: r.trainer,
    setActive: r.setActive,
    options: { paths: { snapshots: dir, models: tmp() } },
    logger: { error() {}, log() {} },
  });

  assert.deepEqual(recovered, [], "an unrecoverable promotion must not be reported as recovered");
  assert.deepEqual(r.calls.consume, [], "material must NOT be consumed when the candidate cannot be published");
  assert.deepEqual(r.calls.activate, []);
  const after = await readManifest(dir, "run-6");
  assert.equal(after.consumed, false);
  assert.equal(after.status, "failed");
  assert.match(after.error, /no candidate version/);
  await registry.close();
});

test("executeFullRun: an in-process crash before the consumption commit is re-driven, consumption committed once", async () => {
  const store = await ArticleStore.open(tmp());
  for (let i = 0; i < 2; i++) {
    const a = await store.ingestArticle({ text: `Crash-recovery article ${i} with enough reasoning prose.`, domain: "reasoning" });
    await store.recordReview({ articleId: a.articleId, verdict: "approve", authority: "human" });
  }
  const registry = await RegistryStore.open(tmp());
  const paths = { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() };

  const calls = { publish: [], activate: [], consume: 0 };
  const trainer = {
    kind: "python",
    version: "py-1",
    resolveBaseline: async () => ({ version: "v001", path: "x/v001" }),
    resolveVersion: async (v) => ({ version: v, path: `x/${v}` }),
    train: async ({ runId }) => ({
      checkpointPath: "x/v002",
      version: "v002",
      parentVersion: "v001",
      trainingRunId: "trid",
      nodeRunId: runId,
      datasetHash: "DH",
      recordsProcessed: 2,
      finalTrainLoss: 1.0,
      staged: true,
      note: "python",
    }),
    publishCandidate: async (v) => { calls.publish.push(v); return { published: v }; },
    discardCandidate: async () => ({ discarded: true }),
  };

  await assert.rejects(
    executeFullRun({
      registry,
      deps: {
        store,
        trainer,
        evalSeed: async () => [{ promptId: "q1", prompt: "2+2?", completion: "four" }],
        evaluateLoss: async ({ version }) => {
          const loss = version === "v001" ? 2.0 : 1.0;
          // Paired evidence so the enforce-mode gate can promote. 30 independent
          // groups is above the configured minimum.
          const perDocument = Array.from({ length: 30 }, (_, i) => ({ articleId: `a${i}`, group: `g${i}`, tokens: 200, loss }));
          return {
            version, loss, datasetHash: "EVAL", ok: true,
            blockCount: 459, tokensSeen: 6000,
            evaluationSet: { datasetHash: "EVAL", blockCount: 459, tokensSeen: 6000 },
            perDocument,
          };
        },
        setActive: async (v) => { calls.activate.push(v); return { version: v }; },
        markConsumed: async (ids, runId) => {
          calls.consume += 1;
          if (calls.consume === 1) throw new Error("simulated crash before consumption commit");
          return store.markConsumed(ids, { runId });
        },
      },
      options: { paths },
      logger: { log() {}, error() {} },
    }),
    /simulated crash before consumption commit/,
  );

  // The error surfaced, but recovery re-drove the durable tail: exactly one real
  // consumption commit, the candidate published and activated, manifest closed.
  assert.equal(calls.consume, 2, "the failed commit is retried exactly once");
  assert.ok(calls.publish.length >= 1, "the staged candidate is published");
  assert.ok(calls.activate.length >= 1 && calls.activate.every((v) => v === "v002"), "the active pointer moved to (and only to) the new version");

  const files = readdirSync(paths.snapshots).filter((f) => f.endsWith("-manifest.json"));
  assert.equal(files.length, 1);
  const manifest = JSON.parse(await readFile(path.join(paths.snapshots, files[0]), "utf8"));
  assert.equal(manifest.decision, "promoted");
  assert.equal(manifest.consumed, true);
  assert.equal(manifest.published, true);
  assert.equal(manifest.resultVersion, "v002");
  assert.equal(store.getStats().trainable, 0, "the snapshot's articles are consumed after the recovery commit");

  await registry.close();
  await store.close();
});
