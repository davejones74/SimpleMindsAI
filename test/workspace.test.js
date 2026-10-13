import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { ArticleStore } from "../src/storage/article-store.js";
import { RegistryStore } from "../src/storage/registry-store.js";
import { GovernanceStore } from "../src/admin/governance-store.js";
import { ChangeFeed } from "../src/admin/change-feed.js";
import { attachAdmin } from "../src/admin/routes.js";

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-ws-")));
const writeJson = (file, obj) => writeFileSync(file, JSON.stringify(obj), "utf8");

const stubChat = {
  identity: () => ({ available: false, mode: "stub", version: null }),
  respond: async (message) => ({ reply: `echo:${message}`, version: null, at: new Date().toISOString() }),
  isUnavailable: () => false,
};

const jget = async (url) => {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
};
const jpost = async (url, body) => {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: await res.json() };
};

/** Filesystem fingerprint of a directory: names + byte sizes. */
function dirSnapshot(dir) {
  if (!existsSync(dir)) return null;
  return readdirSync(dir).sort().map((f) => `${f}:${statSync(path.join(dir, f)).size}`).join("|");
}

/** A minimal but real Python brain store on disk. */
function seedPythonStore(root, version, { parentVersion = null, valLoss = 2.5, trainLoss = 3.0 } = {}) {
  const v = path.join(root, version);
  mkdirSync(v, { recursive: true });
  writeFileSync(path.join(v, "COMMITTED"), JSON.stringify({ committedAt: new Date().toISOString() }));
  writeJson(path.join(v, "init-manifest.json"), { artifactName: `brain-${version}`, architecture: "smoke", sizes: { parametersUniqueByStorage: 1234 }, createdAt: new Date().toISOString() });
  writeJson(path.join(v, "provenance.json"), { actor: "cli", artifactName: `brain-${version}` });
  writeJson(path.join(v, "train-state.json"), { parentVersion, stepsCompleted: 60, tokensSeen: 4242, finalValidationLoss: valLoss, finalTrainLoss: trainLoss, packing: { datasetHash: "deadbeef" } });
  writeJson(path.join(root, "active.json"), { version });
}

/** Build a self-contained workspace (articles + registry + python store) on disk. */
async function buildWorkspace(dir, { articles = [], pythonVersion = "v004", parent = "v003", valLoss = 2.5, trainLoss = 3.0, run = null, extraRuns = [] } = {}) {
  const arts = path.join(dir, "articles");
  const reg = path.join(dir, "registry");
  const pyRoot = path.join(dir, "store");

  const store = await ArticleStore.open(arts);
  for (const text of articles) await store.ingestArticle({ text });
  await store.close();

  const registry = await RegistryStore.open(reg);
  if (run) {
    const r = await registry.createRun({ datasetId: "dataset-x", trainerKind: "python", baseModelVersion: parent, recordCount: articles.length });
    await registry.runEvent(r.runId, { status: "running" });
    const model = run.model ?? {};
    const m = await registry.registerModel({
      kind: "python",
      baseModel: "base",
      parentModelId: null,
      trainingRunId: r.runId,
      datasetId: "dataset-x",
      checkpointPath: path.join(pyRoot, pythonVersion),
      meta: { pythonVersion, parentVersion: parent, avgLoss: model.avgLoss ?? trainLoss, datasetHash: model.datasetHash ?? "trainhash", tokensSeen: model.tokensSeen ?? 100 },
    });
    await registry.modelEvent(m.modelId, { status: model.status ?? "promoted", evaluationScore: model.evaluationScore ?? valLoss, note: model.note ?? null });
    // The in-memory completion patch is intentionally NOT durable (exactly like
    // the real lifecycle): runs.ndjson keeps only the immutable creation line.
    await registry.completeRun(r.runId, {
      status: "promoted",
      trainedEvaluation: { loss: valLoss },
      baselineEvaluation: { loss: valLoss + 0.4 },
      runLinkage: { pythonVersion, parentVersion: parent, datasetHash: model.datasetHash ?? "trainhash" },
    });
    // Extra runs exercise the non-promotion outcomes with no candidate model at
    // all, which is exactly the case a version-only view would hide.
    for (const extra of extraRuns) {
      const r2 = await registry.createRun({ datasetId: "dataset-x", trainerKind: "python", baseModelVersion: parent, recordCount: articles.length });
      await registry.runEvent(r2.runId, { status: extra.status });
      if (extra.evaluationScore != null) {
        const m2 = await registry.registerModel({
          kind: "python",
          baseModel: "base",
          parentModelId: null,
          trainingRunId: r2.runId,
          datasetId: "dataset-x",
          checkpointPath: path.join(pyRoot, extra.pythonVersion ?? pythonVersion),
          meta: { pythonVersion: extra.pythonVersion ?? null, parentVersion: parent, datasetHash: extra.datasetHash ?? "trainhash", tokensSeen: extra.tokensSeen ?? null },
        });
        await registry.modelEvent(m2.modelId, { status: extra.status === "rejected" ? "rejected" : "candidate", evaluationScore: extra.evaluationScore });
      }
      if (extra.status === "promoted" || extra.status === "rejected" || extra.status === "failed") {
        await registry.completeRun(r2.runId, {
          status: extra.status,
          promotionStatus: extra.promotionStatus ?? extra.status,
          trainedEvaluation: extra.loss != null ? { loss: extra.loss, version: extra.pythonVersion ?? null } : null,
          evaluationDelta: extra.evaluationDelta ?? null,
          runLinkage: { pythonVersion: extra.pythonVersion ?? null, parentVersion: parent, datasetHash: extra.datasetHash ?? "trainhash" },
        });
      }
    }
  }
  await registry.close();

  const governance = await GovernanceStore.open(reg);
  await governance.close();

  seedPythonStore(pyRoot, pythonVersion, { parentVersion: parent, valLoss, trainLoss });
  return { dir, arts, reg, pyRoot };
}

async function harness() {
  const dev = await buildWorkspace(tmp(), {
    articles: ["development article about reasoning"],
    pythonVersion: "v003",
    parent: "v002",
    valLoss: 3.1,
    trainLoss: 3.5,
    run: {
      model: { avgLoss: 3.5, datasetHash: "ddd", tokensSeen: 11, evaluationScore: 3.1, status: "promoted" },
    },
  });
  const trial = await buildWorkspace(tmp(), {
    articles: ["trial article one", "trial article two", "trial article three"],
    pythonVersion: "v004",
    parent: "v003",
    valLoss: 2.5,
    trainLoss: 3.0,
    run: {
      model: {
        avgLoss: 8.8147,
        datasetHash: "2074f38ab01048fe5e7795125e877795e9f8c4e8030f1260440508f6bc9dfa12",
        tokensSeen: 30720,
        evaluationScore: 11.380511601765951,
        status: "promoted",
        note: "loss 11.8392 -> 11.3805 (improvement 0.4587); loss improved by 0.4587 on 4c647fb91f2314e97e4d085e54251cedad42f9988f7a5c402f1de55ee4095c1b",
      },
    },
    // A rejected candidate (no published version), a hard failure, and a run
    // that is still in progress: all recorded, none published. The loss has to
    // come from the durable model event, because the run completion patch is
    // in-memory only and never reaches runs.ndjson.
    extraRuns: [
      { status: "rejected", evaluationScore: 11.95, datasetHash: "2074f38ab01048fe5e7795125e877795e9f8c4e8030f1260440508f6bc9dfa12", tokensSeen: 30720 },
      { status: "failed" },
      { status: "evaluating" },
    ],
  });

  const store = await ArticleStore.open(dev.arts);
  const registry = await RegistryStore.open(dev.reg);
  const governance = await GovernanceStore.open(dev.reg);

  const workspaces = [
    {
      id: "trial-100",
      label: "Trial 100 (20261010)",
      kind: "inspection",
      pythonStore: trial.pyRoot,
      articles: trial.arts,
      registry: trial.reg,
      governance: trial.reg,
    },
    {
      id: "missing-trial",
      label: "Missing trial",
      kind: "inspection",
      pythonStore: path.join(tmp(), "does-not-exist"),
      articles: path.join(tmp(), "nope-arts"),
      registry: path.join(tmp(), "nope-reg"),
    },
  ];

  const app = express();
  app.use(express.json());
  attachAdmin({ app, store, registry, governance, chat: stubChat, changeFeed: new ChangeFeed(), pythonStorePath: dev.pyRoot, workspaces, logger: { log() {} } });

  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, store, registry, governance, dev, trial,
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      await store.close();
      await registry.close();
      await governance.close();
    },
  };
}

test("workspaces: catalogue reports each store's real active version and availability", async () => {
  const h = await harness();
  try {
    const cat = await jget(`${h.base}/api/admin/workspaces`);
    assert.equal(cat.status, 200);
    assert.equal(cat.body.default, "development");

    const dev = cat.body.workspaces.find((w) => w.id === "development");
    assert.equal(dev.activeVersion, "v003");
    assert.equal(dev.readOnly, false);
    assert.equal(dev.available, true);

    const trial = cat.body.workspaces.find((w) => w.id === "trial-100");
    assert.equal(trial.activeVersion, "v004");
    assert.equal(trial.readOnly, true);
    assert.equal(trial.available, true);

    const missing = cat.body.workspaces.find((w) => w.id === "missing-trial");
    assert.equal(missing.available, false);
    assert.match(missing.reason, /not found|not configured/);
  } finally {
    await h.close();
  }
});

test("workspaces: overview reads the selected store and never mixes them", async () => {
  const h = await harness();
  try {
    const dev = await jget(`${h.base}/api/admin/overview?workspace=development`);
    assert.equal(dev.status, 200);
    assert.equal(dev.body.workspace.id, "development");
    assert.equal(dev.body.workspace.readOnly, false);
    assert.equal(dev.body.articles.totalArticles, 1);
    assert.equal(dev.body.pythonStore.activeVersion, "v003");
    assert.equal(dev.body.registry.runCount, 1);

    const trial = await jget(`${h.base}/api/admin/overview?workspace=trial-100`);
    assert.equal(trial.status, 200);
    assert.equal(trial.body.workspace.id, "trial-100");
    assert.equal(trial.body.workspace.readOnly, true);
    assert.equal(trial.body.articles.totalArticles, 3);
    assert.equal(trial.body.pythonStore.activeVersion, "v004");
    // One promoted run plus a rejected candidate, a failure and an in-progress
    // run: runCount counts RUNS, so all four are present.
    assert.equal(trial.body.registry.runCount, 4);

    // Re-read development after the trial to prove nothing bled across.
    const dev2 = await jget(`${h.base}/api/admin/overview?workspace=development`);
    assert.equal(dev2.body.articles.totalArticles, 1);
    assert.equal(dev2.body.pythonStore.activeVersion, "v003");
  } finally {
    await h.close();
  }
});

test("workspaces: training-history + metrics load the trial from persisted artifacts", async () => {
  const h = await harness();
  try {
    const hist = await jget(`${h.base}/api/admin/training-history?workspace=trial-100`);
    assert.equal(hist.status, 200);
    assert.equal(hist.body.workspace.id, "trial-100");
    const run = hist.body.registry.runs.find((r) => r.runId === "run-1");
    assert.ok(run);
    // These survive a restart ONLY because they are read from the immutable run
    // registration + the durable candidate-model lineage — NOT from the
    // in-memory completion patch.
    assert.equal(run.status, "promoted");
    assert.equal(run.promotionStatus, "promoted");
    assert.equal(run.pythonVersion, "v004");
    assert.equal(run.parentVersion, "v003");
    assert.equal(run.activatedVersion, "v004");
    assert.equal(run.trainedLoss, 11.380511601765951);
    assert.equal(run.candidate.modelId, "model-1");
    assert.equal(run.candidate.avgTrainLoss, 8.8147);
    assert.equal(run.candidate.tokensSeen, 30720);
    assert.match(run.candidate.note, /11\.8392 -> 11\.3805/);
    // The run registration line on disk carries no promotion field — proof the
    // view is derived from persisted artifacts, not fabricated.
    const rawRuns = readFileSync(path.join(h.trial.reg, "runs.ndjson"), "utf8");
    assert.doesNotMatch(rawRuns, /promotionStatus|trainedEvaluation|runLinkage/);

    const m = await jget(`${h.base}/api/admin/metrics?workspace=trial-100`);
    assert.equal(m.status, 200);
    assert.equal(m.body.workspace.id, "trial-100");
    assert.equal(m.body.available, true);
    assert.equal(m.body.effectiveVersion, "v004");
    const seg = m.body.segments.find((s) => s.version === "v004");
    assert.equal(seg.finalValidationLoss, 2.5);
    // `markers` is the measurable subset of those events: a finite loss and a
    // plottable step. Two of the four runs qualify, including the rejected one.
    assert.equal(m.body.markers.length, 2);
    const promotedMarker = m.body.markers.find((mk) => mk.version === "v004");
    assert.equal(promotedMarker.loss, 11.380511601765951);
    assert.equal(promotedMarker.promotionStatus, "promoted");
    assert.equal(promotedMarker.tokensSeen, 30720);
    assert.ok(m.body.markers.some((mk) => mk.promotionStatus === "rejected" && mk.loss === 11.95));

    // Diamonds are RUNS, not versions: the rejected candidate, the failed run
    // and the in-progress run are all present even though only one of the four
    // runs produced a published version.
    const byOutcome = Object.fromEntries(m.body.events.map((e) => [e.outcome, e]));
    assert.deepEqual(Object.keys(byOutcome).sort(), ["failed", "in_progress", "promoted", "rejected"]);
    assert.equal(byOutcome.rejected.loss, 11.95);
    assert.equal(byOutcome.rejected.version, null);
    assert.equal(byOutcome.failed.loss, null);
    assert.equal(byOutcome.in_progress.loss, null);
    assert.equal(byOutcome.promoted.loss, 11.380511601765951);
    assert.equal(byOutcome.promoted.version, "v004");
    // Every event carries a step so the graph can place it, and events with no
    // loss say so instead of inventing one.
    for (const e of m.body.events) assert.ok(Number.isInteger(e.step), `${e.outcome} has no step`);
    assert.equal(m.body.events.find((e) => e.outcome === "promoted").stepBasis, "run-final-step");
    assert.equal(m.body.events.find((e) => e.outcome === "failed").stepBasis, "lineage-end");

    // The same run id exists in development with a DIFFERENT python version.
    const devHist = await jget(`${h.base}/api/admin/training-history?workspace=development`);
    const devRun = devHist.body.registry.runs.find((r) => r.runId === "run-1");
    assert.equal(devRun.pythonVersion, "v003");
  } finally {
    await h.close();
  }
});

test("workspaces: inspection-only rejects every mutation and writes no files", async () => {
  const h = await harness();
  try {
    const before = dirSnapshot(h.trial.arts);

    const page = await jget(`${h.base}/api/admin/articles?workspace=trial-100&limit=10`);
    const id = page.body.items[0].articleId;

    const select = await jpost(`${h.base}/api/admin/articles/select-for-review?workspace=trial-100`, { limit: 10 });
    assert.equal(select.status, 403);
    assert.match(select.body.error, /inspection-only/);

    const imp = await jpost(`${h.base}/api/admin/articles/${id}/importance?workspace=trial-100`, { importance: "Important" });
    assert.equal(imp.status, 403);

    const review = await jpost(`${h.base}/api/admin/articles/${id}/review?workspace=trial-100`, { verdict: "approve", authority: "human" });
    assert.equal(review.status, 403);

    const mission = await jpost(`${h.base}/api/admin/mission/secondary?workspace=trial-100`, { text: "mutated" });
    assert.equal(mission.status, 403);

    const strategy = await jpost(`${h.base}/api/admin/strategy?workspace=trial-100`, { strategy: { domains: ["x"] } });
    assert.equal(strategy.status, 403);

    const cycle = await jpost(`${h.base}/api/admin/review-cycles/ensure?workspace=trial-100`, { uniqueConsumed: 9999 });
    assert.equal(cycle.status, 403);

    const chat = await jpost(`${h.base}/api/admin/chat?workspace=trial-100`, { message: "hi" });
    assert.equal(chat.status, 403);

    // The frozen store is byte-for-byte unchanged.
    assert.equal(dirSnapshot(h.trial.arts), before);

    // Development remains writable (unchanged behaviour).
    const devWrite = await jpost(`${h.base}/api/admin/articles/select-for-review?workspace=development`, { limit: 10 });
    assert.equal(devWrite.status, 200);
  } finally {
    await h.close();
  }
});

test("workspaces: unknown is 404, missing store is 503, never fabricated", async () => {
  const h = await harness();
  try {
    const unknown = await jget(`${h.base}/api/admin/overview?workspace=does-not-exist`);
    assert.equal(unknown.status, 404);
    assert.match(unknown.body.error, /unknown workspace/);

    const missing = await jget(`${h.base}/api/admin/overview?workspace=missing-trial`);
    assert.equal(missing.status, 503);
    assert.match(missing.body.error, /unavailable/);

    const missingMetrics = await jget(`${h.base}/api/admin/metrics?workspace=missing-trial`);
    assert.equal(missingMetrics.status, 503);
  } finally {
    await h.close();
  }
});

test("read-only stores refuse writes and create nothing on disk", async () => {
  const dir = tmp();
  const store = await ArticleStore.open(path.join(dir, "articles"), { readOnly: true });
  assert.equal(existsSync(path.join(dir, "articles")), false);
  await assert.rejects(() => store.ingestArticle({ text: "nope" }), /read-only/);

  const registry = await RegistryStore.open(path.join(dir, "registry"), { readOnly: true });
  await assert.rejects(() => registry.createRun({}), /read-only/);

  const governance = await GovernanceStore.open(path.join(dir, "governance"), { readOnly: true });
  await assert.rejects(() => governance.append("missions", {}), /read-only/);

  assert.equal(existsSync(path.join(dir, "registry")), false);
  assert.equal(existsSync(path.join(dir, "governance")), false);
});
