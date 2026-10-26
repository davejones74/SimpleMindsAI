import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RegistryStore } from "../src/storage/registry-store.js";
import { ArticleStore } from "../src/storage/article-store.js";
import { executeFullRun } from "../src/training/lifecycle.js";
import { NoBaselineError, pythonTrainer, resolvePythonBaseline } from "../src/training/python-trainer.js";
import { REPO_ROOT } from "../src/brain/python-cli.js";
import { loadEvalCache, saveEvalCache } from "../src/training/eval-cache.js";

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
    if (verb === "publish") {
      return { ok: true, verb: "publish", version: args[args.indexOf("--version") + 1], published: true, alreadyCommitted: false };
    }
    if (verb === "discard") {
      return { ok: true, verb: "discard", version: args[args.indexOf("--version") + 1], discarded: true };
    }
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
  assert.equal(trainCall[trainCall.indexOf("--corpus") + 1], path.join(REPO_ROOT, "corpus.jsonl"), "relative corpus resolved against REPO_ROOT");
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

test("pythonTrainer.train --stage-only stages without publishing and points at the .tmp dir", async () => {
  const { run, calls } = makeFakeBrain({
    status: { versions: [{ version: "v001", committed: true }] },
    active: "v001",
    train: { ok: true, published: false, staged: true, version: "v004", parentVersion: "v001", articleCount: 5 },
  });
  const t = pythonTrainer({ run, device: "cpu" });
  const res = await t.train({ datasetFile: "corpus.jsonl", runId: "run-4", stageOnly: true, configuration: { parentVersion: "v001" } });

  assert.equal(res.staged, true);
  assert.equal(res.published, false);
  assert.equal(res.version, "v004");
  assert.ok(res.checkpointPath.endsWith(path.join("v004.tmp")), res.checkpointPath);
  const trainCall = calls.find((c) => c[0] === "train");
  assert.ok(trainCall.includes("--stage-only"), "stage-only forwarded to Python");
});

test("pythonTrainer.publishCandidate / discardCandidate forward to the publish and discard verbs", async () => {
  const { run, calls } = makeFakeBrain({
    status: { versions: [{ version: "v001", committed: true }] },
    active: "v001",
  });
  const t = pythonTrainer({ run, device: "cpu" });
  assert.ok(typeof t.publishCandidate === "function" && typeof t.discardCandidate === "function");

  await t.publishCandidate("v004");
  await t.discardCandidate("v005", { recordDir: "rejected/v005" });

  const publishCall = calls.find((c) => c[0] === "publish");
  const discardCall = calls.find((c) => c[0] === "discard");
  assert.equal(publishCall[publishCall.indexOf("--version") + 1], "v004");
  assert.equal(discardCall[discardCall.indexOf("--version") + 1], "v005");
  assert.equal(discardCall[discardCall.indexOf("--keep-record") + 1], "rejected/v005");
});

// ----------------------------------------------------------- full lifecycle

const EVAL_SEED = [
  { promptId: "q1", prompt: "Capital of France?", completion: "Paris is the capital of France." },
  { promptId: "q2", prompt: "What is 2+2?", completion: "Two plus two equals four." },
];

/**
 * Attach paired per-document evidence to a synthetic evaluation, so the
 * enforce-mode promotion gate can reach a decision in lifecycle tests that are
 * about mechanics rather than about the statistics.
 */
function withPaired(result) {
  if (!result || result.ok !== true || !Number.isFinite(result.loss)) return result;
  const perDocument = Array.from({ length: 30 }, (_, i) => ({ articleId: `a${i}`, group: `g${i}`, tokens: 200, loss: result.loss }));
  return {
    ...result,
    blockCount: 459,
    tokensSeen: 6000,
    evaluationSet: { ...(result.evaluationSet ?? {}), datasetHash: result.datasetHash, blockCount: 459, tokensSeen: 6000 },
    perDocument,
  };
}

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
    evaluateLoss: async ({ version }) => withPaired(lossFor(version)),
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

test("python-mode lifecycle: stale aggregate-only baseline cache is rejected and refreshed", async () => {
  const options = { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } };
  const lossFor = (v) => ({ version: v, loss: 1.4, datasetHash: "EVALSET", ok: true });

  // Warm a real per-document cache with an inconclusive (equal-loss) run.
  const registryA = await RegistryStore.open(tmp());
  const storeA = await seededStore();
  await executeFullRun({
    registry: registryA,
    options,
    deps: pythonRunDeps({ store: storeA, lossFor, onActivate: () => { throw new Error("must not activate"); } }),
  });
  const cacheA = loadEvalCache(registryA.dir);
  const baselineKey = Object.keys(cacheA).find((key) => cacheA[key]?.version === "v001");
  assert.ok(baselineKey, "the baseline evaluation was cached");
  assert.ok(Array.isArray(cacheA[baselineKey].perDocument) && cacheA[baselineKey].perDocument.length > 0);
  await storeA.close();
  await registryA.close();

  // A stale aggregate-only entry under the SAME key must be ignored, forcing a
  // fresh parent evaluation and repairing the cache.
  const registryB = await RegistryStore.open(tmp());
  const storeB = await seededStore();
  const stale = JSON.parse(JSON.stringify(cacheA));
  delete stale[baselineKey].perDocument;
  delete stale[baselineKey].blockCount;
  delete stale[baselineKey].tokensSeen;
  saveEvalCache(registryB.dir, stale);
  const counted = { baseline: 0 };
  const depsB = pythonRunDeps({ store: storeB, lossFor, onActivate: () => { throw new Error("must not activate"); } });
  depsB.evaluateLoss = async ({ version }) => {
    if (version === "v001") counted.baseline += 1;
    return withPaired(lossFor(version));
  };
  const outB = await executeFullRun({ registry: registryB, options, deps: depsB });
  assert.equal(counted.baseline, 1, "the stale aggregate-only entry was not used");
  assert.equal(outB.decision.decision, "inconclusive");
  const repaired = loadEvalCache(registryB.dir);
  assert.ok(Array.isArray(repaired[baselineKey].perDocument) && repaired[baselineKey].perDocument.length > 0);
  await storeB.close();
  await registryB.close();

  // The same cache with per-document evidence is a valid hit: no parent eval.
  const registryC = await RegistryStore.open(tmp());
  const storeC = await seededStore();
  saveEvalCache(registryC.dir, cacheA);
  const countedC = { baseline: 0 };
  const depsC = pythonRunDeps({ store: storeC, lossFor, onActivate: () => { throw new Error("must not activate"); } });
  depsC.evaluateLoss = async ({ version }) => {
    if (version === "v001") countedC.baseline += 1;
    return withPaired(lossFor(version));
  };
  await executeFullRun({ registry: registryC, options, deps: depsC });
  assert.equal(countedC.baseline, 0, "a per-document cache hit skips the parent evaluation");
  await storeC.close();
  await registryC.close();
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

// ------------------------------------------------ commit-on-promotion (staging)

/**
 * A trainer that supports staging: `train` must be asked to stage, and the
 * candidate becomes a version only via `publishCandidate`.
 */
function stagingRunDeps({
  store,
  lossFor,
  onActivate = () => {},
  onPublish = () => {},
  onDiscard = () => {},
  onEvaluate = () => {},
  failActivateOnce = false,
  version = "v002",
}) {
  let activateCalls = 0;
  const trainer = {
    kind: "python",
    version: "python-staging",
    resolveBaseline: async () => ({ version: "v001", path: "/store/v001" }),
    train: async ({ runId, stageOnly }) => {
      if (!stageOnly) throw new Error("staging trainer must be asked to stage");
      return {
        checkpointPath: `/store/${version}.tmp`,
        version,
        staged: true,
        published: false,
        parentVersion: "v001",
        trainingRunId: "trid",
        nodeRunId: runId,
        datasetHash: "DATAHASH",
        recordsProcessed: 3,
        finalTrainLoss: 1.2,
        note: "python causal-LM training",
      };
    },
    publishCandidate: async (v) => {
      onPublish(v);
      return { ok: true, version: v, published: true, alreadyCommitted: false };
    },
    discardCandidate: async (v, { recordDir } = {}) => {
      onDiscard(v, recordDir);
      return { ok: true, version: v, discarded: true };
    },
  };
  return {
    store,
    trainer,
    evalSeed: async () => EVAL_SEED,
    evaluateLoss: async ({ version: v, staged }) => {
      onEvaluate(v, staged === true);
      return { ...withPaired(lossFor(v)), staged: staged === true };
    },
    setActive: async (v) => {
      activateCalls += 1;
      if (failActivateOnce && activateCalls === 1) throw new Error("activation crashed");
      onActivate(v);
      return { version: v };
    },
  };
}

test("staging: a promoted candidate is published exactly once, activated once, and never discarded", async () => {
  const registry = await RegistryStore.open(tmp());
  const store = await seededStore();
  const options = { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } };
  const published = [];
  const discarded = [];
  const activated = [];
  const evalStaged = [];

  const out = await executeFullRun({
    registry,
    options,
    deps: stagingRunDeps({
      store,
      lossFor: (v) => ({ version: v, loss: v === "v001" ? 2.0 : 1.4, datasetHash: "EVALSET", ok: true }),
      onPublish: (v) => published.push(v),
      onDiscard: (v) => discarded.push(v),
      onActivate: (v) => activated.push(v),
      onEvaluate: (v, staged) => evalStaged.push([v, staged]),
    }),
  });

  assert.equal(out.decision.decision, "promoted");
  assert.equal(out.run.status, "promoted");
  assert.deepEqual(published, ["v002"], "the staged candidate is promoted into a version");
  assert.deepEqual(discarded, [], "a promoted candidate is never discarded");
  assert.deepEqual(activated, ["v002"]);
  assert.equal(evalStaged.find(([v]) => v === "v001")?.[1], false, "the committed baseline is scored in place");
  assert.equal(evalStaged.find(([v]) => v === "v002")?.[1], true, "the candidate is scored as staged before publication");
  assert.equal(store.getStats().uniqueConsumed, 3);
  await store.close();
  await registry.close();
});

test("staging: a rejected candidate is never published and is discarded with its record retained", async () => {
  const registry = await RegistryStore.open(tmp());
  const store = await seededStore();
  const options = { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } };
  const published = [];
  const discarded = [];
  const activated = [];

  const out = await executeFullRun({
    registry,
    options,
    deps: stagingRunDeps({
      store,
      lossFor: (v) => ({ version: v, loss: v === "v001" ? 1.4 : 2.0, datasetHash: "EVALSET", ok: true }),
      onPublish: (v) => published.push(v),
      onDiscard: (v, recordDir) => discarded.push([v, recordDir]),
      onActivate: (v) => activated.push(v),
    }),
  });

  assert.equal(out.decision.decision, "rejected");
  assert.deepEqual(published, [], "a rejected candidate must never become a version");
  assert.equal(discarded.length, 1);
  assert.equal(discarded[0][0], "v002");
  assert.match(discarded[0][1], /rejected[\\/]/, "rejection provenance is retained somewhere durable");
  assert.deepEqual(activated, [], "a rejected candidate never moves the pointer");
  // A rejection DEFERS its batch instead of consuming it: the material stays
  // eligible so a later run can retry it alongside new articles. The deferral
  // is durable (an appended article-store event), not an in-memory flag.
  assert.equal(store.getStats().uniqueConsumed, 0, "a rejection must not consume its batch");
  const deferredArticles = store.articlesPage({ limit: 50 }).items;
  assert.equal(deferredArticles.length, 3);
  for (const a of deferredArticles) {
    assert.equal(a.deferralRetries, 1, "each rejected article records one deferral");
    assert.equal(a.deferredRunId, out.run.runId, "the deferral names the run that rejected it");
    assert.equal(a.status, "REVIEWED", "one rejection defers, it does not retire");
    assert.equal(a.trainable, true, "deferred material stays eligible for a later run");
  }
  await store.close();
  await registry.close();
});

test("staging: an unevaluable candidate is discarded and leaves articles unconsumed", async () => {
  const registry = await RegistryStore.open(tmp());
  const store = await seededStore();
  const options = { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } };
  const published = [];
  const discarded = [];

  const out = await executeFullRun({
    registry,
    options,
    deps: stagingRunDeps({
      store,
      lossFor: (v) => (v === "v001"
        ? { version: v, loss: 1.4, datasetHash: "EVALSET", ok: true }
        : { version: v, loss: null, datasetHash: null, ok: false, error: "eval failed" }),
      onPublish: (v) => published.push(v),
      onDiscard: (v) => discarded.push(v),
    }),
  });

  assert.equal(out.decision.decision, "not_evaluated");
  assert.deepEqual(published, []);
  assert.deepEqual(discarded, ["v002"]);
  assert.equal(store.getStats().uniqueConsumed, 0, "a failed evaluation must not consume articles");
  await store.close();
  await registry.close();
});

test("staging crash recovery: a crash after the decision re-drives publish/activate/consume without duplicating", async () => {
  const registry = await RegistryStore.open(tmp());
  const store = await seededStore();
  const options = { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } };
  const published = [];
  const activated = [];

  await assert.rejects(
    executeFullRun({
      registry,
      options,
      deps: stagingRunDeps({
        store,
        lossFor: (v) => ({ version: v, loss: v === "v001" ? 2.0 : 1.4, datasetHash: "EVALSET", ok: true }),
        onPublish: (v) => published.push(v),
        onActivate: (v) => activated.push(v),
        failActivateOnce: true,
      }),
    }),
    /activation crashed/,
  );

  // Publication is idempotent: it ran in the branch and again during recovery.
  assert.ok(published.every((v) => v === "v002"));
  assert.ok(published.length >= 1);
  assert.ok(activated.includes("v002"), "the retry moved the pointer");
  assert.equal(store.getStats().uniqueConsumed, 3, "consumption happened exactly once");
  await store.close();
  await registry.close();
});

test("python lifecycle applies the data-derived budget and records corpus accounting", async () => {
  const registry = await RegistryStore.open(tmp());
  const store = await seededStore();
  const options = { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } };
  let seenConfig = null;
  const trainer = {
    kind: "python",
    version: "python-v1",
    async resolveBaseline() {
      return { version: "v001", path: "C:/store/v001" };
    },
    async preflight() {
      return {
        ok: true,
        blockCount: 132,
        trainBlockCount: 100,
        validationBlockCount: 32,
        trainTokensSeen: 12000,
        validationTokensSeen: 4096,
        replayTokensSeen: 2000,
        freshTokensSeen: 10000,
        freshDocumentCount: 80,
        replayDocumentCount: 20,
        corpusSplitMode: "role-appended",
        validationShortfall: 0,
      };
    },
    async train({ runId, configuration }) {
      seenConfig = configuration;
      return {
        checkpointPath: "C:/store/v002",
        version: "v002",
        parentVersion: "v001",
        trainingRunId: "trid",
        nodeRunId: runId,
        datasetHash: "DATAHASH",
        recordsProcessed: 100,
        finalTrainLoss: 1.2,
        stepsCompleted: configuration.steps,
        trainBlockCount: 100,
        validationBlockCount: 32,
        trainTokensSeen: 12000,
        validationTokensSeen: 4096,
        replayTokensSeen: 2000,
        freshDocumentCount: 80,
        replayDocumentCount: 20,
        corpusSplit: { mode: "role-appended", shortfall: 0 },
        note: "python",
      };
    },
  };

  const out = await executeFullRun({
    registry,
    options,
    deps: {
      store,
      trainer,
      evalSeed: async () => EVAL_SEED,
      evaluateLoss: async ({ version }) => ({ version, loss: version === "v001" ? 2.0 : 1.4, datasetHash: "EVAL", ok: true }),
      setActive: async (version) => ({ version }),
    },
  });

  assert.equal(seenConfig.steps, 50, "ceil(2 epochs * 100 blocks / effective batch 4)");
  assert.equal(seenConfig.valBlocks, 32);
  assert.equal(out.run.trainingBudget.steps, 50);
  assert.equal(out.run.trainingBudget.capped, false);
  assert.equal(out.run.trainingBudget.completedSteps, 50);
  assert.ok(Math.abs(out.run.trainingBudget.actualEffectiveEpochs - 2) < 1e-9);
  assert.equal(out.run.corpusAccounting.trainTokensSeen, 12000);
  assert.equal(out.run.corpusAccounting.replayTokensSeen, 2000);
  assert.ok(Math.abs(out.run.corpusAccounting.replayShare - 1 / 6) < 1e-9);
  assert.equal(out.run.corpusAccounting.validationBlockCount, 32);
  await store.close();
  await registry.close();
});

test("python lifecycle refuses a corpus below the minimum-data floor before creating a run", async () => {
  const registry = await RegistryStore.open(tmp());
  const store = await seededStore();
  const options = { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } };
  let trained = false;
  const trainer = {
    kind: "python",
    version: "python-v1",
    async resolveBaseline() {
      return { version: "v001", path: "C:/store/v001" };
    },
    async preflight() {
      return {
        ok: true,
        blockCount: 12,
        trainBlockCount: 10,
        trainTokensSeen: 1699,
        tokensSeen: 1699,
      };
    },
    async train() {
      trained = true;
      throw new Error("train must not run below the minimum-data floor");
    },
  };

  await assert.rejects(
    executeFullRun({
      registry,
      options,
      deps: {
        store,
        trainer,
        evalSeed: async () => EVAL_SEED,
        evaluateLoss: async ({ version }) => ({ version, loss: 1, datasetHash: "EVAL", ok: true }),
        setActive: async (version) => ({ version }),
      },
    }),
    (err) => err.code === "INSUFFICIENT_TRAINING_DATA" && err.tokens === 1699 && err.minUniqueTokens === 1700,
  );
  assert.equal(trained, false);
  assert.equal(registry.listRuns().length, 0);
  await store.close();
  await registry.close();
});
