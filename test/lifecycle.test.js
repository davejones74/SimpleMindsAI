import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RegistryStore } from "../src/storage/registry-store.js";
import { ArticleStore } from "../src/storage/article-store.js";
import { stubTrainer } from "../src/training/trainer-interface.js";
import { executeFullRun } from "../src/training/lifecycle.js";

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-")));

const EVAL_SEED = [
  { promptId: "q1", prompt: "Capital of France?", completion: "Paris is the capital of France." },
  { promptId: "q2", prompt: "What is 2+2?", completion: "Two plus two equals four." },
];

async function seededStore() {
  const store = await ArticleStore.open(tmp());
  for (let i = 0; i < 3; i++) {
    const a = await store.ingestArticle({ text: `Sample reasoning article number ${i} with enough prose.`, domain: "reasoning" });
    await store.recordReview({ articleId: a.articleId, verdict: "approve", authority: "human" });
  }
  return store;
}

// Always returns the exact reference completion => baseline and candidate tie.
const exactComplete = async (p) => ({ text: EVAL_SEED.find((i) => i.prompt === p)?.completion ?? "" });

// First evalSet.size calls exact (baseline), then wrong (candidate) => regression.
function regressingComplete() {
  let calls = 0;
  return async (p) => {
    calls++;
    return { text: calls <= EVAL_SEED.length ? (EVAL_SEED.find((i) => i.prompt === p)?.completion ?? "") : "not known exactly" };
  };
}

test("full run: baseline eval -> train -> candidate eval -> promoted, consumption committed", async () => {
  const options = { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } };
  const registry = await RegistryStore.open(tmp());
  const store = await seededStore();

  const out = await executeFullRun({
    registry,
    options,
    deps: { store, trainer: stubTrainer(), complete: exactComplete, evalSeed: async () => EVAL_SEED },
  });
  const run = out.run;

  assert.equal(run.status, "promoted");
  assert.equal(run.promotionStatus, "promoted");
  assert.ok(run.resultModelId);
  assert.equal(registry.getModel(run.resultModelId).status, "promoted");
  assert.equal(registry.getActiveModel().modelId, run.resultModelId);
  // exactly-once consumption happened AFTER training + eval succeeded
  assert.equal(store.getStats().uniqueConsumed, 3);
  assert.equal(store.getStats().trainable, 0);
  await store.close();
  await registry.close();
});

test("failed trainer leaves articles unconsumed (crash-safe boundary)", async () => {
  const registry = await RegistryStore.open(tmp());
  const store = await seededStore();
  const options = { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } };

  await assert.rejects(
    executeFullRun({
      registry,
      options,
      deps: {
        store,
        trainer: { kind: "stub", version: "x", async train() { throw new Error("kaboom"); } },
        complete: exactComplete,
        evalSeed: async () => EVAL_SEED,
      },
    }),
    /kaboom/,
  );

  const runs = registry.listRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "failed");
  assert.equal(store.getStats().uniqueConsumed, 0); // nothing consumed
  assert.equal(store.getStats().trainable, 3);
  await store.close();
  await registry.close();
});

test("regression candidate is rejected; run + model both record rejection", async () => {
  const registry = await RegistryStore.open(tmp());
  const store = await seededStore();
  const options = { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } };

  const out = await executeFullRun({
    registry,
    options,
    deps: { store, trainer: stubTrainer(), complete: regressingComplete(), evalSeed: async () => EVAL_SEED },
  });
  assert.equal(out.decision.decision, "rejected");
  assert.equal(out.run.status, "rejected");
  assert.equal(out.run.promotionStatus, "rejected");
  assert.equal(registry.getModel(out.run.resultModelId).status, "rejected");
  assert.equal(registry.getActiveModel(), null);
  assert.ok(out.run.evaluationDelta < 0);
  await store.close();
  await registry.close();
});

test("chain: second run trains FROM the promoted model as its baseline", async () => {
  const registry = await RegistryStore.open(tmp());
  const store = await seededStore();
  const opts = { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } };

  await executeFullRun({
    registry,
    options: opts,
    deps: { store, trainer: stubTrainer(), complete: exactComplete, evalSeed: async () => EVAL_SEED },
  });
  const first = registry.getActiveModel();
  assert.ok(first);

  for (let i = 0; i < 2; i++) {
    const a = await store.ingestArticle({ text: `Chain article number ${i} with additional reasoning prose.`, domain: "reasoning" });
    await store.recordReview({ articleId: a.articleId, verdict: "approve", authority: "human" });
  }

  const out2 = await executeFullRun({
    registry,
    options: { ...opts, paths: { ...opts.paths, evaluation: tmp() } },
    deps: { store, trainer: stubTrainer(), complete: exactComplete, evalSeed: async () => EVAL_SEED },
  });
  assert.equal(out2.run.baseModel, first.modelId); // promoted model = new baseline
  assert.equal(registry.getRun(out2.run.runId).status, "promoted");
  await store.close();
  await registry.close();
});
