import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { ArticleStore } from "../src/storage/article-store.js";
import { RegistryStore } from "../src/storage/registry-store.js";
import { GovernanceStore } from "../src/admin/governance-store.js";
import { ChangeFeed } from "../src/admin/change-feed.js";
import { attachAdmin } from "../src/admin/routes.js";

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-admin-")));

const stubChat = {
  identity: () => ({ available: false, mode: "stub", version: null }),
  respond: async (message) => ({ reply: `echo:${message}`, version: null, at: new Date().toISOString() }),
  isUnavailable: () => false,
};

async function harness() {
  const store = await ArticleStore.open(tmp());
  const registry = await RegistryStore.open(tmp());
  const governance = await GovernanceStore.open(tmp());
  const changeFeed = new ChangeFeed();
  const app = express();
  app.use(express.json());
  attachAdmin({
    app,
    store,
    registry,
    governance,
    chat: stubChat,
    changeFeed,
    pythonStorePath: path.join(tmp(), "empty-python-store"),
    logger: { log() {} },
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, store, registry, governance, changeFeed,
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      await store.close();
      await registry.close();
      await governance.close();
    },
  };
}

const jget = async (url) => {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
};
const jpost = async (url, body) => {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
  return { status: res.status, body: await res.json() };
};

test("admin API: overview + articles + review actions drive the real store", async () => {
  const h = await harness();
  try {
    const a = await h.store.ingestArticle({ text: "Portal article body with plenty of prose.", domain: "reasoning" });

    const overview = await jget(`${h.base}/api/admin/overview`);
    assert.equal(overview.status, 200);
    assert.equal(overview.body.articles.totalArticles, 1);
    assert.ok(overview.body.mission.primary.text.length > 0);
    assert.equal(overview.body.pythonStore.available, false);

    const page = await jget(`${h.base}/api/admin/articles?limit=10`);
    assert.equal(page.status, 200);
    assert.equal(page.body.items.length, 1);

    await jpost(`${h.base}/api/admin/articles/${a.articleId}/request-review`);
    assert.equal(h.store.getArticle(a.articleId).status, "PENDING_REVIEW");

    await jpost(`${h.base}/api/admin/articles/${a.articleId}/review`, { verdict: "approve", authority: "human" });
    assert.equal(h.store.getArticle(a.articleId).status, "REVIEWED");

    const detail2 = await jget(`${h.base}/api/admin/articles/${a.articleId}`);
    assert.ok(Array.isArray(detail2.body.reviews));
    assert.ok(Array.isArray(detail2.body.events));
  } finally {
    await h.close();
  }
});

test("admin API: mission proposal lifecycle, strategy versioning, review cycles", async () => {
  const h = await harness();
  try {
    const proposed = await jpost(`${h.base}/api/admin/mission/proposals`, { text: "A refined secondary mission statement.", rationale: "test" });
    assert.equal(proposed.status, 200);
    const withPending = await jget(`${h.base}/api/admin/mission`);
    assert.equal(withPending.body.proposals.length, 1);

    await jpost(`${h.base}/api/admin/mission/proposals/${proposed.body.proposalId}/approve`);
    const after = await jget(`${h.base}/api/admin/mission`);
    assert.equal(after.body.proposals.length, 0); // approved => no longer pending
    assert.equal(after.body.secondary.text, "A refined secondary mission statement.");
    assert.equal(after.body.versions.length, 2); // seed + approved

    await jpost(`${h.base}/api/admin/strategy`, { strategy: { domains: ["reasoning"], reviewSampleRate: 0.2 }, rationale: "tune" });
    const strat = await jget(`${h.base}/api/admin/strategy`);
    assert.equal(strat.body.active.version, 2);

    const cycles = await jget(`${h.base}/api/admin/review-cycles`);
    await jpost(`${h.base}/api/admin/review-cycles/ensure`, { uniqueConsumed: cycles.body.interval });
    const afterCycles = await jget(`${h.base}/api/admin/review-cycles`);
    assert.equal(afterCycles.body.cycles.length, 1);
    assert.equal(afterCycles.body.cycles[0].status, "open");

    const hist = await jget(`${h.base}/api/admin/training-history`);
    assert.equal(hist.status, 200);
    assert.ok(Array.isArray(hist.body.registry.runs));
    assert.ok(Array.isArray(hist.body.discrepancies));
  } finally {
    await h.close();
  }
});

test("admin SSE endpoint streams a hello frame and a change frame", async () => {
  const h = await harness();
  try {
    h.changeFeed.emit("test.event", { ok: true });
    const res = await fetch(`${h.base}/api/admin/events?since=0`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = res.body.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.match(text, /event: hello/);
    assert.match(text, /event: change/);
    await reader.cancel();
  } finally {
    await h.close();
  }
});

test("Observatory: training-history projects Python loss metrics + run linkage", async () => {
  const h = await harness();
  try {
    const run = await h.registry.createRun({ datasetId: "dataset-1", trainerKind: "python", baseModelVersion: "v1" });
    await h.registry.completeRun(run.runId, {
      status: "promoted",
      promotionStatus: "promoted",
      baselineEvaluation: { loss: 3.2, datasetHash: "abc", version: "v1" },
      trainedEvaluation: { loss: 2.8, datasetHash: "abc", version: "v2" },
      evaluationDelta: 0.4,
      runLinkage: {
        nodeRunId: run.runId,
        pythonTrainingRunId: "tr-1",
        pythonVersion: "v2",
        parentVersion: "v1",
        datasetHash: "abc",
        checkpointPath: "C:/store/v2/model",
      },
    });

    const hist = await jget(`${h.base}/api/admin/training-history`);
    assert.equal(hist.status, 200);
    const projected = hist.body.registry.runs.find((r) => r.runId === run.runId);
    assert.equal(projected.baselineLoss, 3.2);
    assert.equal(projected.trainedLoss, 2.8);
    assert.ok(Math.abs(projected.lossDelta - 0.4) < 1e-9);
    assert.equal(projected.pythonVersion, "v2");
    assert.equal(projected.parentVersion, "v1");
    assert.equal(projected.runLinkage.pythonTrainingRunId, "tr-1");
    assert.equal(projected.evaluationDelta, 0.4);
  } finally {
    await h.close();
  }
});
