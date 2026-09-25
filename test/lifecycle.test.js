import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RegistryStore } from "../src/storage/registry-store.js";
import { BufferStore } from "../src/storage/buffer-store.js";
import { stubTrainer } from "../src/training/trainer-interface.js";
import { executeFullRun } from "../src/training/lifecycle.js";

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-")));

const EVAL_SEED = [
  { promptId: "q1", prompt: "Capital of France?", completion: "Paris is the capital of France." },
  { promptId: "q2", prompt: "What is 2+2?", completion: "Two plus two equals four." },
];

async function seededStore() {
  const dir = tmp();
  const store = await BufferStore.open(dir);
  for (let i = 0; i < 3; i++) {
    const p = await store.ingestPrompt({ text: `Sample prompt ${i}`, domain: "reasoning" });
    const c = await store.ingestCompletion({ promptId: p.id, text: `Answer for prompt ${i}.`, model: "test", origin: "curated" });
    await store.scoreCompletion({ completionId: c.id, score: 9 });
  }
  return store;
}

function evaluatorDeps(evalSet) {
  // count-guided completor: first evalSet.size calls = exact (baseline),
  // afterwards = wrong (candidate). Lets us script promote vs reject without GPU.
  let calls = 0;
  return {
    complete: async (p) => {
      const it = evalSet.items.find((i) => i.prompt === p);
      calls++;
      return { text: calls <= evalSet.size ? (it ? it.completion : "") : "it is not known exactly" };
    },
  };
}

test("full run: baseline eval -> train -> candidate eval -> promoted, consumption committed", async () => {
  const options = { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } };
  const registry = await RegistryStore.open(tmp());
  const store = await seededStore();
  let evalSet;

  const out = await executeFullRun({
    registry,
    options,
    deps: {
      store,
      trainer: stubTrainer(),
      markConsumed: (ids, runId) => store.markTrained(ids, runId),
      evalSeed: async () => EVAL_SEED,
    },
  });
  evalSet = out.run.baselineEvaluation; // internal record
  const run = out.run;

  assert.equal(run.status, "promoted");
  assert.equal(run.promotionStatus, "promoted");
  assert.ok(run.resultModelId);
  const candidate = registry.getModel(run.resultModelId);
  assert.equal(candidate.status, "promoted");
  assert.equal(registry.getActiveModel().modelId, candidate.modelId);
  // dataset snapshot locked in
  assert.ok(run.datasetId);
  assert.ok(run.datasetVersion);
  assert.ok(existsSync(run.datasetFile));
  // crash-safe consumption happened AFTER success
  assert.equal(store.getStats().trainedPrompts, 3);
  assert.equal(store.getStats().untrainedPrompts, 0);
  // baseline evaluation recorded
  assert.ok(run.baselineEvaluation?.evalRunId);
  assert.equal(typeof run.evaluationDelta, "number");
  assert.ok(out.baseline.score <= 1 && out.candidate.score <= 1);

  await store.close();
  await registry.close();
});

test("failed trainer => run failed, NO consumption, buffer intact (crash safety)", async () => {
  const registry = await RegistryStore.open(tmp());
  const store = await seededStore();
  const opts = { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } };

  await assert.rejects(
    executeFullRun({
      registry,
      options: opts,
      deps: {
        store,
        trainer: { kind: "stub", version: "x", async train() { throw new Error("kaboom"); } },
        markConsumed: (ids, runId) => store.markTrained(ids, runId),
        evalSeed: async () => EVAL_SEED,
      },
    }),
    /kaboom/
  );

  const runs = registry.listRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "failed");
  assert.equal(store.getStats().untrainedPrompts, 3); // nothing consumed
  assert.equal(store.getStats().trainedPrompts, 0);
  await store.close();
  await registry.close();
});

test("regression candidate is rejected; run + model both record rejection", async () => {
  const registry = await RegistryStore.open(tmp());
  const store = await seededStore();
  const opts = { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } };
  const evalSet = await (await import("../src/dataset/evaluation-set.js")).loadEvaluationSet({ dir: opts.paths.evaluation, seed: async () => EVAL_SEED });

  const out = await executeFullRun({
    registry,
    options: opts,
    deps: {
      store,
      trainer: stubTrainer(),
      markConsumed: (ids, runId) => store.markTrained(ids, runId),
      evalSeed: async () => EVAL_SEED,
      ...evaluatorDeps(evalSet), // baseline exact => high, candidate wrong => 0 => regression
    },
  });
  assert.equal(out.decision.decision, "rejected");
  const run = out.run;
  assert.equal(run.status, "rejected");
  assert.equal(run.promotionStatus, "rejected");
  assert.equal(registry.getModel(run.resultModelId).status, "rejected");
  assert.equal(registry.getActiveModel(), null); // nothing promoted yet
  assert.ok(run.evaluationDelta < 0);
  await store.close();
  await registry.close();
});

test("chain: second run trains FROM the promoted model as its baseline", async () => {
  const registry = await RegistryStore.open(tmp());
  const store = await seededStore();
  const opts = { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } };

  // run 1
  await executeFullRun({ registry, options: opts, deps: { store, trainer: stubTrainer(), markConsumed: (ids, r) => store.markTrained(ids, r), evalSeed: async () => EVAL_SEED } });
  const first = registry.getActiveModel();
  assert.ok(first);

  // run 2: fresh eval set needed (immutable, per test) + 2 more prompts
  const evalDir2 = tmp();
  for (let i = 0; i < 2; i++) {
    const p = await store.ingestPrompt({ text: `Chain prompt ${i}`, domain: "reasoning" });
    const c = await store.ingestCompletion({ promptId: p.id, text: `Chain answer ${i}.`, model: "test", origin: "curated" });
    await store.scoreCompletion({ completionId: c.id, score: 8 });
  }
  const out2 = await executeFullRun({
    registry,
    options: { ...opts, paths: { ...opts.paths, evaluation: evalDir2 } },
    deps: { store, trainer: stubTrainer(), markConsumed: (ids, r) => store.markTrained(ids, r), evalSeed: async () => EVAL_SEED },
  });
  assert.equal(out2.run.baseModel, first.modelId); // promoted model = new baseline
  assert.equal(registry.getRun(out2.run.runId).status, "promoted");
  await store.close();
  await registry.close();
});