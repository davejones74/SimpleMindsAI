import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RegistryStore } from "../src/storage/registry-store.js";
import { ArticleStore } from "../src/storage/article-store.js";
import { executeFullRun } from "../src/training/lifecycle.js";
import { NoBaselineError, pythonTrainer, resolvePythonBaseline } from "../src/training/python-trainer.js";

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-py-")));

/** A fake `sma.brain` invoked through the injectable `run` seam (no Python). */
function makeFakeBrain({ status, active = null, train = null, evalLossByVersion = {} } = {}) {
  const calls = [];
  const run = async (args) => {
    calls.push([...args]);
    const verb = args[0];
    if (verb === "status") return status;
    if (verb === "active") {
      const setIdx = args.indexOf("--set");
      if (setIdx >= 0) return { ok: true, verb: "active", activated: { version: args[setIdx + 1] } };
      return { ok: true, verb: "active", activeVersion: active };
    }
    if (verb === "train") return train;
    if (verb === "eval") {
      const version = args[args.indexOf("--version") + 1];
      return { ok: true, verb: "eval", version, evalLoss: evalLossByVersion[version], evaluationSet: { datasetHash: "EVALHASH" } };
    }
    throw new Error(`unexpected verb ${verb}`);
  };
  return { run, calls };
}

// ------------------------------------------------------------------ baseline

test("resolveBaseline returns the committed active version", async () => {
  const { run } = makeFakeBrain({
    status: { versions: [{ version: "v001", committed: true }, { version: "v002", committed: true }] },
    active: "v001",
  });
  const b = await resolvePythonBaseline({ run });
  assert.equal(b.version, "v001");
});

test("resolveBaseline refuses when committed versions exist but nothing is active", async () => {
  const { run } = makeFakeBrain({ status: { versions: [{ version: "v001", committed: true }] }, active: null });
  await assert.rejects(resolvePythonBaseline({ run }), (e) => e instanceof NoBaselineError && /--adopt v001/.test(e.message));
});

test("resolveBaseline guides the operator to init on an empty store", async () => {
  const { run } = makeFakeBrain({ status: { versions: [] }, active: null });
  await assert.rejects(resolvePythonBaseline({ run }), (e) => e instanceof NoBaselineError && /init:brain/.test(e.message));
});

test("resolveBaseline treats an active pointer to a non-committed version as corrupt", async () => {
  const { run } = makeFakeBrain({ status: { versions: [{ version: "v001", committed: true }] }, active: "v009" });
  await assert.rejects(resolvePythonBaseline({ run }), (e) => e instanceof NoBaselineError && /not committed/.test(e.message));
});

// --------------------------------------------------------------------- train

test("pythonTrainer.train forwards the descriptor and normalises the result", async () => {
  const trainOut = {
    ok: true,
    published: true,
    version: "v003",
    parentVersion: "v001",
    trainingRunId: "deadbeef",
    nodeRunId: "run-7",
    datasetHash: "DATAHASH",
    articleCount: 5,
    finalTrainLoss: 1.25,
    tokensSeen: 100,
    blockCount: 3,
    device: "cpu",
  };
  const { run, calls } = makeFakeBrain({
    status: { versions: [{ version: "v001", committed: true }] },
    active: "v001",
    train: trainOut,
  });
  const t = pythonTrainer({ run, device: "cpu", learningRate: 2e-4, steps: 7 });
  const res = await t.train({ datasetFile: "corpus.jsonl", runId: "run-7", configuration: { parentVersion: "v001", recordCount: 5 } });

  assert.equal(res.version, "v003");
  assert.equal(res.nodeRunId, "run-7");
  assert.equal(res.datasetHash, "DATAHASH");
  assert.equal(res.recordsProcessed, 5);

  const trainCall = calls.find((c) => c[0] === "train");
  assert.ok(trainCall, "train invoked");
  assert.equal(trainCall[trainCall.indexOf("--parent") + 1], "v001");
  assert.equal(trainCall[trainCall.indexOf("--corpus") + 1], "corpus.jsonl");
  assert.equal(trainCall[trainCall.indexOf("--lr") + 1], "0.0002");
  assert.equal(trainCall[trainCall.indexOf("--steps") + 1], "7");
  assert.equal(trainCall[trainCall.indexOf("--run-id") + 1], "run-7");
  assert.equal(trainCall[trainCall.indexOf("--compute-dtype") + 1], "float32", "cpu forces fp32");
});

test("pythonTrainer.train fails closed when Python does not publish", async () => {
  const { run } = makeFakeBrain({
    status: { versions: [{ version: "v001", committed: true }] },
    active: "v001",
    train: { ok: false, published: false, kind: "numerical_failure", error: "loss spiked" },
  });
  const t = pythonTrainer({ run, device: "cpu" });
  await assert.rejects(
    t.train({ datasetFile: "corpus.jsonl", runId: "run-9", configuration: { parentVersion: "v001" } }),
    /did not publish \(numerical_failure\): loss spiked/,
  );
});

// ----------------------------------------------------------- full lifecycle

const EVAL_SEED = [
  { promptId: "q1", prompt: "Capital of France?", completion: "Paris is the capital of France." },
  { promptId: "q2", prompt: "What is 2+2?", completion: "Two plus two equals four." },
];

async function seededStore() {
  const store = await ArticleStore.open(tmp());
  for (let i = 0; i < 3; i++) {
    const a = await store.ingestArticle({ text: `Python-path article number ${i} with enough prose.`, domain: "reasoning" });
    await store.recordReview({ articleId: a.articleId, verdict: "approve", authority: "human" });
  }
  return store;
}

function pythonRunDeps({ store, lossFor, onActivate }) {
  const trainer = {
    kind: "python",
    version: "python-v1",
    async resolveBaseline() {
      return { version: "v001", path: "C:/store/v001" };
    },
    async train({ runId }) {
      return {
        checkpointPath: "C:/store/v002",
        version: "v002",
        parentVersion: "v001",
        trainingRunId: "trid",
        nodeRunId: runId,
        datasetHash: "DATAHASH",
        recordsProcessed: 3,
        finalTrainLoss: 1.2,
        note: "python causal-LM training",
      };
    },
  };
  return {
    store,
    trainer,
    evalSeed: async () => EVAL_SEED,
    evaluateLoss: async ({ version }) => lossFor(version),
    setActive: async (version) => {
      onActivate(version);
      return { version };
    },
  };
}

test("python-mode lifecycle: loss improvement promotes and moves the pointer", async () => {
  const registry = await RegistryStore.open(tmp());
  const store = await seededStore();
  const options = { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } };
  let activatedWith = null;

  const out = await executeFullRun({
    registry,
    options,
    deps: pythonRunDeps({
      store,
      lossFor: (v) => ({ version: v, loss: v === "v001" ? 2.0 : 1.4, datasetHash: "EVALSET", ok: true }),
      onActivate: (v) => { activatedWith = v; },
    }),
  });

  assert.equal(out.decision.decision, "promoted");
  assert.equal(out.run.status, "promoted");
  assert.equal(activatedWith, "v002");
  assert.equal(out.run.runLinkage.pythonTrainingRunId, "trid");
  assert.equal(out.run.runLinkage.nodeRunId, out.run.runId);
  assert.equal(registry.getModel(out.run.resultModelId).status, "promoted");
  assert.equal(store.getStats().uniqueConsumed, 3);
  await store.close();
  await registry.close();
});

test("python-mode lifecycle: a worse candidate is rejected and the pointer stays", async () => {
  const registry = await RegistryStore.open(tmp());
  const store = await seededStore();
  const options = { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } };
  let activated = false;

  const out = await executeFullRun({
    registry,
    options,
    deps: pythonRunDeps({
      store,
      lossFor: (v) => ({ version: v, loss: v === "v001" ? 1.4 : 2.0, datasetHash: "EVALSET", ok: true }),
      onActivate: () => { activated = true; },
    }),
  });

  assert.equal(out.decision.decision, "rejected");
  assert.equal(out.run.status, "rejected");
  assert.equal(activated, false);
  assert.equal(registry.getActiveModel(), null);
  await store.close();
  await registry.close();
});

test("python-mode lifecycle: an unevaluable candidate never activates and closes the run terminally", async () => {
  const registry = await RegistryStore.open(tmp());
  const store = await seededStore();
  const options = { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } };
  let activated = false;

  const out = await executeFullRun({
    registry,
    options,
    deps: pythonRunDeps({
      store,
      lossFor: (v) => (v === "v001"
        ? { version: v, loss: 1.4, datasetHash: "EVALSET", ok: true }
        : { version: v, loss: null, datasetHash: null, ok: false, error: "eval failed" }),
      onActivate: () => { activated = true; },
    }),
  });

  assert.equal(out.decision.decision, "not_evaluated");
  assert.equal(out.run.status, "rejected");
  assert.equal(out.run.promotionStatus, "not_evaluated");
  assert.equal(activated, false);
  await store.close();
  await registry.close();
});
