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
import { JobSupervisor } from "../src/jobs/supervisor.js";
import { Frontier } from "../src/frontier.js";

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
  const frontier = new Frontier({ dir: tmp() });
  await frontier.init();
  const app = express();
  app.use(express.json());
  const supervisor = new JobSupervisor({ store, registry, governance, changeFeed, dir: tmp() });
  await supervisor.init({ reconcile: false });
  attachAdmin({
    app,
    store,
    registry,
    governance,
    chat: stubChat,
    changeFeed,
    pythonStorePath: path.join(tmp(), "empty-python-store"),
    supervisor,
    frontier,
    logger: { log() {} },
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, store, registry, governance, changeFeed, supervisor, frontier,
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      await supervisor.close();
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("admin API: jobs, eligibility, brain versions, teacher readiness, guarded start/stop", async () => {
  const h = await harness();
  try {
    const empty = await jget(`${h.base}/api/admin/jobs`);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.jobs, []);

    const elig = await jget(`${h.base}/api/admin/training/eligibility`);
    assert.equal(elig.status, 200);
    assert.equal(elig.body.trainable, 0);
    assert.equal(elig.body.eligible, false);

    const versions = await jget(`${h.base}/api/admin/brain/versions`);
    assert.equal(versions.status, 200);
    assert.equal(versions.body.available, false);
    assert.deepEqual(versions.body.versions, []);

    const teacher = await jget(`${h.base}/api/admin/teacher`);
    assert.equal(teacher.status, 200);
    assert.equal(typeof teacher.body.ready, "boolean");

    // unknown job stop => 404
    const missing = await jpost(`${h.base}/api/admin/jobs/nope/stop`);
    assert.equal(missing.status, 404);

    // fresh brain requires explicit confirmation => 400 from the supervisor
    const unconfirmed = await jpost(`${h.base}/api/admin/brain/fresh`, { confirm: false });
    assert.equal(unconfirmed.status, 400);

    // A one-shot training start with no eligible material becomes a durable,
    // failed job (never a second run).
    const started = await jpost(`${h.base}/api/admin/training/start`, { mode: "one-shot", minEligible: 1 });
    assert.equal(started.status, 200);
    const jobId = started.body.job.jobId;

    let job = null;
    for (let i = 0; i < 100; i++) {
      job = (await jget(`${h.base}/api/admin/jobs/${jobId}`)).body.job;
      if (job?.terminal) break;
      await sleep(20);
    }
    assert.equal(job.status, "failed");
    assert.match(job.error, /insufficient eligible material/);

    const listed = await jget(`${h.base}/api/admin/jobs`);
    assert.equal(listed.body.jobs.length, 1);
    assert.equal(listed.body.jobs[0].jobId, jobId);
  } finally {
    await h.close();
  }
});

test("admin API: overview reports advisory evaluation warnings, and never invents them", async () => {
  const h = await harness();
  try {
    // Nothing recorded yet: an empty, honest advisory block (not a missing key).
    const quiet = await jget(`${h.base}/api/admin/overview`);
    assert.equal(quiet.status, 200);
    assert.deepEqual(quiet.body.evaluation.warnings, []);
    assert.equal(quiet.body.evaluation.runId, null);

    // A run that recorded an undersized frozen eval set surfaces it verbatim.
    const warning = {
      code: "eval-set-undersized",
      severity: "advisory",
      datasetId: "eval-001",
      size: 2,
      minDocuments: 19,
      message: "frozen evaluation set 'eval-001' holds 2 document(s), below the advisory minimum of 19",
    };
    const run = await h.registry.createRun({
      datasetId: "ds-1",
      evaluationSetSize: 2,
      evaluationWarnings: [warning],
    });
    await h.registry.completeRun(run.runId, { status: "promoted", promotionStatus: "promoted" });

    const seen = await jget(`${h.base}/api/admin/overview`);
    assert.equal(seen.status, 200);
    assert.equal(seen.body.evaluation.warnings.length, 1);
    assert.deepEqual(seen.body.evaluation.warnings[0], warning);
    assert.equal(seen.body.evaluation.runId, run.runId);
    assert.equal(seen.body.evaluation.size, 2);
    // Advisory, not a gate: the run still completed as a promotion.
    assert.equal(h.registry.getRun(run.runId).status, "promoted");

    // Retired material is reported as its own category in the same payload.
    assert.equal(seen.body.articles.retired, 0);
  } finally {
    await h.close();
  }
});

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
    assert.ok(hist.body.lifecycle, "training-history must expose lifecycle-aware gap counts");
    assert.equal(typeof hist.body.lifecycle.discarded, "number");
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

// ---------------------------------------------------------- Slice 7: observability

test("observability: /overview exposes the live frontier summary", async () => {
  const h = await harness();
  try {
    await h.frontier.enqueue("https://example.com/queued", { depth: 0 });
    const visited = await h.frontier.enqueue("https://example.com/visited", { depth: 0 });
    await h.frontier.markVisited(visited, { nextCrawlAt: new Date(Date.now() - 1000).toISOString() });

    const res = await jget(`${h.base}/api/admin/overview`);
    assert.equal(res.status, 200);
    assert.ok(res.body.frontier, "overview includes the frontier summary");
    assert.ok(res.body.frontier.queued >= 1);
    assert.ok(res.body.frontier.visited >= 1);
    assert.ok(res.body.frontier.rediscoveryDue >= 1);
  } finally {
    await h.close();
  }
});

test("observability: a WAITING transition is emitted over the change feed with its reason", async () => {
  const h = await harness();
  try {
    const events = [];
    h.changeFeed.subscribe((e) => events.push(e));
    const job = await h.supervisor.startTraining({ mode: "continuous", minEligible: 1 });
    for (let i = 0; i < 300; i++) {
      if (events.some((e) => e.type === "job.status" && e.data?.waitingReason)) break;
      await sleep(10);
    }
    const waitEvent = events.find((e) => e.type === "job.status" && e.data?.waitingReason);
    assert.ok(waitEvent, "a job.status event carrying the waiting reason is emitted");
    assert.equal(waitEvent.data.waitingReason, "no-eligible-unconsumed-material");
    await h.supervisor.stop(job.jobId);
  } finally {
    await h.close();
  }
});
