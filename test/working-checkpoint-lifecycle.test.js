import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ArticleStore } from "../src/storage/article-store.js";
import { RegistryStore } from "../src/storage/registry-store.js";
import { executeFullRun, recoverPendingPromotions } from "../src/training/lifecycle.js";
import { decideWorkingAdvancement } from "../src/training/working-guard.js";
import { config } from "../src/config.js";

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-working-")));

const EVAL_GROUPS = Array.from({ length: 20 }, (_, i) => `https://example.test/source-${i}`);

function evalResult(version, loss, { ok = true } = {}) {
  const perDocument = EVAL_GROUPS.map((group, i) => ({
    articleId: `doc-${i}`,
    group,
    loss,
    tokens: 100,
  }));
  const groups = EVAL_GROUPS.map((group) => ({ group, documents: 1, tokens: 100, loss }));
  return {
    ok,
    version,
    loss,
    datasetHash: "frozen-eval-hash",
    metricSignature: "same-metric",
    evaluationSet: { tokensSeen: 2000, blockCount: 16 },
    perDocument,
    groups,
    error: ok ? null : "synthetic eval failure",
  };
}

async function seededStore(count = 8) {
  const store = await ArticleStore.open(tmp());
  for (let i = 0; i < count; i += 1) {
    const text = `Article ${i}. ` + Array.from({ length: 30 }, (_, j) => `Unique sentence ${i}-${j} discusses topic ${i * 31 + j} with a complete clause.`).join(" ");
    const a = await store.ingestArticle({
      text,
      domain: i % 2 ? "science" : "history",
      sourceUrl: `https://example.test/article-${i}`,
      fetchedContentHash: `fetched-${i}`,
    });
    await store.recordReview({ articleId: a.articleId, verdict: "approve", authority: "human" });
  }
  return store;
}

function fakePythonTrainer({ stableVersion = "v100", startingWorking = null, losses = {}, workingPointer = null } = {}) {
  const calls = {
    publish: [],
    discard: [],
    working: [],
    lastGood: [],
    activate: [],
    trainParents: [],
  };
  let working = startingWorking;
  let pointer = workingPointer;
  let next = startingWorking ? Number(String(startingWorking).replace(/^v/, "")) + 1 : 900;
  const versionLosses = { [stableVersion]: 10, ...losses };
  const trainer = {
    kind: "python",
    version: "fake-python",
    async resolveBaseline() {
      return { version: stableVersion, path: `/tmp/${stableVersion}` };
    },
    async resolveVersion(version) {
      return { version, path: `/tmp/${version}` };
    },
    async resolveWorking() {
      return working ? { version: working, path: `/tmp/${working}`, pointer, lastGoodVersion: pointer?.lastGoodVersion ?? null } : null;
    },
    async setWorking(version, meta = null) {
      const previous = working;
      working = version;
      pointer = { version, drift: meta?.drift ?? null, lastGoodVersion: previous, ...(meta ?? {}) };
      calls.working.push(version);
      return { version };
    },
    async setWorkingLastGood(version) {
      calls.lastGood.push(version);
      return { version };
    },
    async preflight() {
      return {
        ok: true,
        trainBlockCount: 8,
        blockCount: 8,
        trainTokensSeen: 5000,
        tokensSeen: 6000,
        validationTokensSeen: 1000,
        validationBlockCount: 2,
      };
    },
    async train({ configuration = {} }) {
      const version = `v${next++}`;
      calls.trainParents.push(configuration.parentVersion);
      return {
        version,
        staged: true,
        published: false,
        parentVersion: configuration.parentVersion,
        finalTrainLoss: 1.0,
        finalValidationLoss: 1.0,
        initialTrainLoss: 1.2,
        initialValidationLoss: 1.2,
        datasetHash: `dataset-${version}`,
        tokensSeen: 5000,
        trainTokensSeen: 4000,
        replayTokensSeen: 1000,
        validationTokensSeen: 1000,
        trainBlockCount: 8,
        validationBlockCount: 2,
        freshDocumentCount: 6,
        replayDocumentCount: 2,
        corpusSplit: { mode: "test" },
        stepsCompleted: 4,
        selectBest: true,
        selectedStep: 3,
        selectedValidationLoss: 1.0,
      };
    },
    async publishCandidate(version) {
      calls.publish.push(version);
      return { published: version };
    },
    async discardCandidate(version) {
      calls.discard.push(version);
      return { discarded: version };
    },
  };
  return {
    trainer,
    calls,
    setLoss(version, loss) {
      versionLosses[version] = loss;
    },
    get working() {
      return working;
    },
    async evaluateLoss({ version }) {
      return evalResult(version, versionLosses[version] ?? 10.04);
    },
  };
}

async function withConfig(patch, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(patch)) {
    previous[key] = config[key];
    config[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) config[key] = value;
  }
}

async function setup({ startingWorking = null } = {}) {
  const registry = await RegistryStore.open(tmp());
  const store = await seededStore(16);
  const options = { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } };
  const fake = fakePythonTrainer({ startingWorking });
  const setActive = async (version) => {
    fake.calls.activate.push(version);
    return { version };
  };
  return { registry, store, options, fake, setActive };
}

const baseConfig = {
  trainValidationPolicy: "document-source-disjoint",
  trainValidationRequireProspective: true,
  trainValBlocks: 1,
  trainSeqLen: 8,
  trainValidationFraction: 0.2,
  trainValidationTargetTokens: 0,
  trainMinValidationTokens: 0,
  trainMinValidationClusters: 1,
  trainReplayPercent: 0,
  snapshotLimit: 8,
  trainUseWorkingCheckpoint: true,
  trainMinUniqueTokens: 0,
  trainMaxSteps: 100,
  trainMinSteps: 0,
  promoteUncertaintyMode: "enforce",
  promoteMinGroups: 20,
  promoteBootstrapSamples: 200,
  promotePerDocument: true,
};

test("first run bootstraps working from stable; stable rejects, working accepts", async () => {
  await withConfig(baseConfig, async () => {
    const { registry, store, options, fake, setActive } = await setup();
    fake.setLoss("v900", 10.04);
    const out = await executeFullRun({
      registry,
      options,
      deps: {
        store,
        trainer: fake.trainer,
        evaluateLoss: fake.evaluateLoss,
        setActive,
        evalSeed: async () => [
          { promptId: "q1", prompt: "Question one?", completion: "A complete answer." },
          { promptId: "q2", prompt: "Question two?", completion: "Another complete answer." },
        ],
      },
    });

    assert.equal(out.decision.decision, "rejected", "stable gate must reject a regressing candidate");
    assert.equal(fake.calls.activate.length, 0, "active pointer must not move");
    assert.equal(fake.calls.working.length, 1, "working pointer must advance");
    assert.equal(fake.working, out.run.workingVersion);
    assert.equal(out.run.workingAdvanced, true);
    assert.equal(out.run.workingDecision, "accepted");
    assert.ok(fake.calls.publish.includes(out.run.workingVersion));
    assert.equal(store.getStats().uniqueConsumed, 7, "working-accepted batch is presented/consumed (one validation row reserved)");
    assert.equal(store.listContributions()[0].workingDecision, "accepted");
    assert.equal(store.listContributions()[0].checkpointRole, "working");
    await store.close();
    await registry.close();
  });
});

test("second run trains from the working pointer, not the stable active model", async () => {
  await withConfig(baseConfig, async () => {
    const { registry, store, options, fake, setActive } = await setup();
    fake.setLoss("v900", 10.04);
    const first = await executeFullRun({
      registry,
      options,
      deps: { store, trainer: fake.trainer, evaluateLoss: fake.evaluateLoss, setActive, evalSeed: async () => [
        { promptId: "q1", prompt: "Question one?", completion: "A complete answer." },
        { promptId: "q2", prompt: "Question two?", completion: "Another complete answer." },
      ] },
    });
    const workingAfterFirst = first.run.workingVersion;
    fake.setLoss("v901", 10.02);
    fake.setLoss(workingAfterFirst, 10.04);
    const second = await executeFullRun({
      registry,
      options: { ...options, paths: { ...options.paths, evaluation: tmp() } },
      deps: { store, trainer: fake.trainer, evaluateLoss: fake.evaluateLoss, setActive, evalSeed: async () => [
        { promptId: "q1", prompt: "Question one?", completion: "A complete answer." },
        { promptId: "q2", prompt: "Question two?", completion: "Another complete answer." },
      ] },
    });
    assert.equal(fake.calls.trainParents.at(-1), workingAfterFirst, "training parent is the working checkpoint");
    assert.equal(second.run.parentSelection, "working");
    assert.equal(second.run.workingVersion, "v901");
    assert.equal(fake.working, "v901");
    await store.close();
    await registry.close();
  });
});

test("working guard rejection leaves the working pointer and replay opportunity intact", async () => {
  await withConfig({ ...baseConfig, workingGuard: { ...config.workingGuard, maxRegressionNats: -1 } }, async () => {
    const { registry, store, options, fake, setActive } = await setup({ startingWorking: "v900" });
    fake.setLoss("v900", 10.0);
    fake.setLoss("v901", 10.2);
    const out = await executeFullRun({
      registry,
      options,
      deps: { store, trainer: fake.trainer, evaluateLoss: fake.evaluateLoss, setActive, evalSeed: async () => [
        { promptId: "q1", prompt: "Question one?", completion: "A complete answer." },
        { promptId: "q2", prompt: "Question two?", completion: "Another complete answer." },
      ] },
    });
    assert.equal(out.decision.decision, "rejected");
    assert.equal(out.run.workingDecision, "rejected");
    assert.equal(fake.working, "v900", "working pointer unchanged");
    assert.ok(fake.calls.discard.includes("v901"), "staged candidate discarded");
    assert.equal(store.getStats().uniqueConsumed, 0, "batch not consumed");
    assert.equal(store.getStats().deferredFresh, 7, "batch deferred for replay/retry (one validation row reserved)");
    assert.equal(fake.calls.activate.length, 0);
    await store.close();
    await registry.close();
  });
});

test("working guard accepts a localized regression but blocks cumulative drift", () => {
  const stable = { ok: true, version: "stable", loss: 10, perDocument: [], groups: EVAL_GROUPS.map((group) => ({ group, tokens: 200, loss: 10 })) };
  const parent = { ok: true, version: "w1", loss: 10.2, perDocument: [], groups: EVAL_GROUPS.map((group) => ({ group, tokens: 200, loss: 10.2 })) };
  const candidate = { ok: true, version: "w2", loss: 10.26, perDocument: [], groups: EVAL_GROUPS.map((group) => ({ group, tokens: 200, loss: 10.26 })) };
  const accepted = decideWorkingAdvancement({ parent, candidate: { ...candidate, loss: 10.21, groups: parent.groups.map((g) => ({ ...g, loss: 10.21 })) }, stable, thresholds: { maxRegressionNats: 0.05, maxGroupRegressionNats: 0.15, maxDriftNats: 0.25, minGroupTokens: 100, maxRegressedGroupShare: 0.75, minGroups: 5 } });
  assert.equal(accepted.decision, "accepted");
  const rejected = decideWorkingAdvancement({ parent, candidate, stable, thresholds: { maxRegressionNats: 0.5, maxGroupRegressionNats: 0.5, maxDriftNats: 0.25, minGroupTokens: 100, maxRegressedGroupShare: 0.75, minGroups: 5 } });
  assert.equal(rejected.decision, "rejected");
  assert.match(rejected.reason, /drift|above the stable baseline/i);
});

test("cumulative drift above the budget rolls the working parent back to last-known-good", async () => {
  await withConfig(baseConfig, async () => {
    const { registry, store, options, fake, setActive } = await setup({ startingWorking: "v900" });
    // Recreate the fake with an explicit drifted pointer.
    const drifted = fakePythonTrainer({
      startingWorking: "v900",
      workingPointer: { version: "v900", drift: 0.9, lastGoodVersion: "v389" },
    });
    drifted.setLoss("v389", 10);
    drifted.setLoss("v901", 10.01);
    const out = await executeFullRun({
      registry,
      options,
      deps: {
        store,
        trainer: drifted.trainer,
        evaluateLoss: drifted.evaluateLoss,
        setActive,
        evalSeed: async () => [
          { promptId: "q1", prompt: "Question one?", completion: "A complete answer." },
          { promptId: "q2", prompt: "Question two?", completion: "Another complete answer." },
        ],
      },
    });
    assert.equal(out.run.parentSelection, "working-rollback-last-good");
    assert.equal(out.run.workingRollback.from, "v900");
    assert.equal(out.run.workingRollback.to, "v389");
    assert.equal(drifted.calls.working[0], "v389", "working pointer is first restored to last-good");
    assert.equal(drifted.calls.trainParents.at(-1), "v389", "training uses the restored parent");
    await store.close();
    await registry.close();
  });
});

test("recovery: a working-advanced manifest is re-driven without moving active", async () => {
  const dir = tmp();
  const manifest = {
    runId: "run-working",
    status: "rejected",
    decision: "rejected",
    consumed: false,
    published: true,
    workingAdvanced: true,
    workingVersion: "v777",
    workingLastGoodVersion: "v100",
    freshArticleIds: ["a1", "a2"],
    workingMeta: { guardDecision: "accepted" },
  };
  await import("node:fs/promises").then(({ mkdir, writeFile }) => mkdir(dir, { recursive: true }).then(() => writeFile(path.join(dir, "run-working-manifest.json"), JSON.stringify(manifest, null, 2))));
  const registry = await RegistryStore.open(tmp());
  const calls = { consume: [], working: [], lastGood: [], activate: [] };
  const trainer = {
    async publishCandidate() { return { published: true }; },
    async setWorking(v) { calls.working.push(v); return { version: v }; },
    async setWorkingLastGood(v) { calls.lastGood.push(v); return { version: v }; },
  };
  const store = {
    async markConsumed(ids) { calls.consume.push(ids); return { consumed: ids, skipped: [] }; },
    async deferArticles() { throw new Error("must not defer a working-accepted batch"); },
  };
  const recovered = await recoverPendingPromotions({
    registry,
    store,
    trainer,
    setActive: async (v) => { calls.activate.push(v); return { version: v }; },
    options: { paths: { snapshots: dir, models: tmp() } },
    logger: { error() {}, log() {} },
  });
  assert.deepEqual(recovered, [{ runId: "run-working", decision: "rejected", workingAdvanced: true }]);
  assert.deepEqual(calls.consume, [["a1", "a2"]]);
  assert.deepEqual(calls.working, ["v777"]);
  assert.deepEqual(calls.activate, [], "stable active pointer must not move");
  await registry.close();
});
