import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArticleStore } from "../src/storage/article-store.js";
import { RegistryStore } from "../src/storage/registry-store.js";
import { JobSupervisor } from "../src/jobs/supervisor.js";
import { JOB_STATUS } from "../src/jobs/job-store.js";
import { config } from "../src/config.js";

/**
 * Continuous jobs must surface a stall — a rejection streak, or a learning pass
 * that acquires nothing — instead of silently churning (the run-46..run-52
 * failure: seven rejected runs staging the same version, no visible error).
 * Training is perpetual, so a rejection streak is a visible signal and a backoff,
 * never a terminal stop; these tests drive the ACTUAL worker lifecycle, not just
 * the config flags.
 */

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-resilience-")));

const EVAL_SEED = [{ promptId: "q1", prompt: "2+2?", completion: "four" }];

async function seededStore(n = 3) {
  const store = await ArticleStore.open(tmp());
  for (let i = 0; i < n; i++) {
    const a = await store.ingestArticle({ text: `Resilience article ${i} with enough reasoning prose.`, domain: "reasoning" });
    await store.recordReview({ articleId: a.articleId, verdict: "approve", authority: "human" });
  }
  return store;
}

// A store whose reviewed material is never consumed and never shrinks, so we can
// observe the supervisor's OWN circuit breaker rather than the eligibility gate.
// Deferral/retirement is stubbed for the same reason: a rejected run normally
// retires its batch once the retry budget is exhausted (see
// `test/lifecycle.test.js`), which would empty the store mid-streak and hide the
// breaker this test exists to exercise.
function reusableStore(base, trainable) {
  return new Proxy(base, {
    get(target, prop) {
      if (prop === "markConsumed") return async () => ({ consumed: [], skipped: [] });
      if (prop === "deferArticles") return async () => ({ deferred: [], retired: [], skipped: [] });
      if (prop === "getStats") return () => ({ ...target.getStats(), trainable });
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

async function waitTerminal(sup, jobId, timeoutMs = 15000) {
  const start = Date.now();
  for (;;) {
    const job = sup.getJob(jobId);
    if (job && job.terminal) return job;
    if (Date.now() - start > timeoutMs) throw new Error(`job ${jobId} did not finish (last: ${job?.status} / ${job?.phase})`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function waitFor(predicate, timeoutMs = 5000, stepMs = 5) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met before timeout");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function rejectingTrainerFactory() {
  let n = 1; // first candidate is v002, distinct from the v001 baseline
  return () => ({
    kind: "python",
    version: "py-1",
    resolveBaseline: async () => ({ version: "v001", path: "x/v001" }),
    resolveVersion: async (v) => ({ version: v, path: `x/${v}` }),
    train: async ({ runId }) => {
      n += 1;
      return {
        checkpointPath: `x/v${n}`,
        version: `v${String(n).padStart(3, "0")}`,
        parentVersion: "v001",
        trainingRunId: `trid-${n}`,
        nodeRunId: runId,
        datasetHash: "DH",
        recordsProcessed: 3,
        finalTrainLoss: 1.2,
        note: "python",
      };
    },
  });
}

const rejectingEval = async ({ version }) => ({
  version,
  loss: version === "v001" ? 1.0 : 2.0, // candidate always worse => rejected
  datasetHash: "EVAL",
  ok: true,
});

test("continuous training keeps running through a rejection streak instead of stopping", async () => {
  const prevMax = config.jobs.training.maxConsecutiveRejections;
  const prevPoll = config.jobs.pollIntervalMs;
  config.jobs.training.maxConsecutiveRejections = 3;
  config.jobs.pollIntervalMs = 5;
  try {
    const store = reusableStore(await seededStore(3), 3);
    const registry = await RegistryStore.open(tmp());
    const jobDir = tmp();
    let activateCalls = 0;
    let trainCalls = 0;
    const factory = rejectingTrainerFactory();
    const sup = new JobSupervisor({
      store,
      registry,
      dir: jobDir,
      trainerFactory: () => {
        const t = factory();
        const inner = t.train;
        t.train = async (args) => { trainCalls += 1; return inner(args); };
        return t;
      },
      trainingDeps: {
        paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() },
        evalSeed: async () => EVAL_SEED,
        evaluateLoss: rejectingEval,
        setActive: async () => { activateCalls += 1; return {}; },
      },
    });
    await sup.init({ reconcile: false });

    const cap = config.jobs.training.maxConsecutiveRejections;
    const job = await sup.startTraining({ mode: "continuous", minEligible: 1 });
    // Keep training well past the rejection cap: the old behaviour stopped at `cap`.
    await waitFor(() => trainCalls > cap + 2, 10000);
    const mid = sup.getJob(job.jobId);
    assert.equal(mid.terminal, false, "continuous training must not terminate on a rejection streak");
    assert.ok(trainCalls > cap, "it must keep training past the configured rejection cap");

    await sup.stop(job.jobId);
    const done = await waitTerminal(sup, job.jobId);
    assert.equal(done.result.outcome, "stopped");
    assert.equal(activateCalls, 0, "a rejected candidate must never become active");

    await sup.close();
    await registry.close();
    await store.close();

    const events = readFileSync(path.join(jobDir, "job-events.ndjson"), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.ok(
      events.some((e) => e.phase === "repeated-rejection"),
      "the rejection streak must still be surfaced as a visible phase",
    );
  } finally {
    config.jobs.training.maxConsecutiveRejections = prevMax;
    config.jobs.pollIntervalMs = prevPoll;
  }
});

test("continuous training respects the max-runtime guard", async () => {
  const prevMax = config.jobs.maxRuntimeMs;
  const prevPoll = config.jobs.pollIntervalMs;
  config.jobs.maxRuntimeMs = 1000;
  config.jobs.pollIntervalMs = 5;
  try {
    const store = reusableStore(await seededStore(3), 3);
    const registry = await RegistryStore.open(tmp());
    let fakeNow = 0;
    const factory = rejectingTrainerFactory();
    const sup = new JobSupervisor({
      store,
      registry,
      dir: tmp(),
      clock: () => fakeNow,
      trainerFactory: () => {
        const t = factory();
        const inner = t.train;
        // Simulate a run that burns past the configured wall-clock budget.
        t.train = async (args) => { const r = await inner(args); fakeNow = 10_000; return r; };
        return t;
      },
      trainingDeps: {
        paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() },
        evalSeed: async () => EVAL_SEED,
        evaluateLoss: rejectingEval,
        setActive: async () => ({}),
      },
    });
    await sup.init({ reconcile: false });

    const job = await sup.startTraining({ mode: "continuous", minEligible: 1 });
    const done = await waitTerminal(sup, job.jobId);
    assert.equal(done.result.outcome, "max-runtime");
    assert.equal(done.result.runs, 1);

    await sup.close();
    await registry.close();
    await store.close();
  } finally {
    config.jobs.maxRuntimeMs = prevMax;
    config.jobs.pollIntervalMs = prevPoll;
  }
});

test("continuous learning stops when it acquires nothing new for the configured streak", async () => {
  const prevNoProgress = config.jobs.learning.noProgressCycles;
  const prevPoll = config.jobs.pollIntervalMs;
  config.jobs.learning.noProgressCycles = 2;
  config.jobs.pollIntervalMs = 5;
  try {
    const store = await ArticleStore.open(tmp()); // empty: nothing becomes trainable
    const registry = await RegistryStore.open(tmp());
    const sup = new JobSupervisor({
      store,
      registry,
      dir: tmp(),
      ollama: { model: "x", clean: async () => [{ text: "" }] }, // every unit is empty => nothing ingested
      scorer: { scoreOffline: async () => ({ verdict: "approve", score: 9 }) },
      learningDeps: {
        collectDocuments: async () => ({
          mode: "fixture",
          capability: "fixture-harvest",
          documents: [{ text: "A doc that yields no ingestable unit.", domain: "reasoning" }],
          failures: [],
        }),
      },
    });
    await sup.init({ reconcile: false });

    const job = await sup.startLearning({ mode: "continuous", targetArticles: 5 });
    const done = await waitTerminal(sup, job.jobId);
    assert.equal(done.result.outcome, "no-progress");
    assert.ok(done.result.cycles >= 3, "the streak guard must fire after the configured number of stalled cycles");

    await sup.close();
    await registry.close();
    await store.close();
  } finally {
    config.jobs.learning.noProgressCycles = prevNoProgress;
    config.jobs.pollIntervalMs = prevPoll;
  }
});

test("continuous learning treats the article target as a milestone, not a stop", async () => {
  const prevPoll = config.jobs.pollIntervalMs;
  const prevBackoffBase = config.jobs.learning.waitBackoffBaseMs;
  const prevBackoffMax = config.jobs.learning.waitBackoffMaxMs;
  config.jobs.pollIntervalMs = 5;
  config.jobs.learning.waitBackoffBaseMs = 5;
  config.jobs.learning.waitBackoffMaxMs = 20;
  try {
    const store = await seededStore(3); // 3 trainable (human-reviewed, unconsumed)
    const registry = await RegistryStore.open(tmp());
    const sup = new JobSupervisor({
      store,
      registry,
      dir: tmp(),
      ollama: { model: "x", clean: async () => [] },
      scorer: { scoreOffline: async () => ({ verdict: "approve", score: 9 }) },
      learningDeps: {
        collectDocuments: async () => ({ mode: "fixture", capability: "fixture-harvest", documents: [], failures: [] }),
      },
    });
    await sup.init({ reconcile: false });

    // target 1 is already exceeded by the 3 trainable articles.
    const job = await sup.startLearning({ mode: "continuous", targetArticles: 1 });

    // The target is a MILESTONE, not a stop: an empty discovery pass must not
    // terminate the job (it persists a non-terminal WAITING and keeps cycling).
    let milestoneSeen = false;
    for (let i = 0; i < 400 && !milestoneSeen; i++) {
      await new Promise((r) => setTimeout(r, 10));
      const events = readFileSync(path.join(sup.dir, "job-events.ndjson"), "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
      milestoneSeen = events.some((e) => e.phase === "target-milestone");
    }
    assert.ok(milestoneSeen, "reaching the target is still reported as a milestone");

    const live = sup.getJob(job.jobId);
    assert.equal(live.terminal, false, "a continuous job must not stop on empty discovery");

    await sup.stop(job.jobId);
    await sup.close();
    await registry.close();
    await store.close();
  } finally {
    config.jobs.pollIntervalMs = prevPoll;
    config.jobs.learning.waitBackoffBaseMs = prevBackoffBase;
    config.jobs.learning.waitBackoffMaxMs = prevBackoffMax;
  }
});

test("continuous training WAITS on a held RUN.lock; one-shot keeps the honest failure", async () => {
  const prevPoll = config.jobs.pollIntervalMs;
  config.jobs.pollIntervalMs = 5;
  try {
    const store = reusableStore(await seededStore(3), 3);
    const registry = await RegistryStore.open(tmp());
    // Another co-operating process holds the run lock.
    assert.equal(await registry.acquireRunLock(10 * 60 * 1000), true);

    const sup = new JobSupervisor({
      store,
      registry,
      dir: tmp(),
      trainerFactory: () => ({
        kind: "python",
        train: async () => {
          throw new Error("must not train while RUN.lock is held");
        },
      }),
      trainingDeps: { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } },
    });
    await sup.init({ reconcile: false });

    const cont = await sup.startTraining({ mode: "continuous", minEligible: 1 });
    for (let i = 0; i < 400 && sup.getJob(cont.jobId).phase !== "waiting-for-lock"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const waiting = sup.getJob(cont.jobId);
    assert.equal(waiting.status, JOB_STATUS.WAITING);
    assert.equal(waiting.phase, "waiting-for-lock");
    assert.equal(waiting.terminal, false, "lock contention must never fail a continuous job");

    await sup.stop(cont.jobId);
    const stopped = await waitTerminal(sup, cont.jobId);
    assert.equal(stopped.result.outcome, "stopped");

    const one = await sup.startTraining({ mode: "one-shot", minEligible: 1 });
    const failed = await waitTerminal(sup, one.jobId);
    assert.equal(failed.status, JOB_STATUS.FAILED);
    assert.match(failed.error, /RUN\.lock/);

    registry.releaseRunLock();
    await sup.close();
    await registry.close();
    await store.close();
  } finally {
    config.jobs.pollIntervalMs = prevPoll;
  }
});

test("continuous learning does not exhaust its no-progress budget while reviews are merely cooling down", async () => {
  const prevNoProgress = config.jobs.learning.noProgressCycles;
  const prevPoll = config.jobs.pollIntervalMs;
  config.jobs.learning.noProgressCycles = 2;
  config.jobs.pollIntervalMs = 5;
  try {
    const store = await ArticleStore.open(tmp());
    const pending = await store.ingestArticle({ text: "A pending article dwelling in review cooldown.", domain: "reasoning", reviewRequested: true });
    await store.recordReview({ articleId: pending.articleId, verdict: "uncertain", authority: "teacher", score: 0 });

    const registry = await RegistryStore.open(tmp());
    const sup = new JobSupervisor({
      store,
      registry,
      dir: tmp(),
      ollama: { model: "x", clean: async () => [{ text: "" }] }, // nothing ingestable
      scorer: { scoreOffline: async () => ({ verdict: "uncertain", score: 0 }) },
      learningDeps: {
        collectDocuments: async () => ({
          mode: "fixture",
          capability: "fixture-harvest",
          documents: [{ text: "A doc yielding no ingestable unit.", domain: "reasoning" }],
          failures: [],
        }),
      },
    });
    await sup.init({ reconcile: false });

    const job = await sup.startLearning({ mode: "continuous", targetArticles: 5 });
    // Well past the (tiny) no-progress cap: a cooldown wait must not be counted.
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(sup.getJob(job.jobId).terminal, false, "a cooling backlog is a wait, not a stall");

    await sup.stop(job.jobId);
    const done = await waitTerminal(sup, job.jobId);
    assert.equal(done.result.outcome, "stopped");
    assert.ok(done.result.reviewSkippedCooldown >= 1, "the pass must report the cooling backlog it deferred");

    await sup.close();
    await registry.close();
    await store.close();
  } finally {
    config.jobs.learning.noProgressCycles = prevNoProgress;
    config.jobs.pollIntervalMs = prevPoll;
  }
});

test("review drain job: processes the whole pending backlog and reports it drained", async () => {
  const prevPoll = config.jobs.pollIntervalMs;
  config.jobs.pollIntervalMs = 5;
  try {
    const store = await ArticleStore.open(tmp());
    for (let i = 0; i < 3; i++) {
      await store.ingestArticle({ text: `Drainable pending article number ${i}.`, domain: "reasoning", reviewRequested: true });
    }
    const registry = await RegistryStore.open(tmp());
    const sup = new JobSupervisor({
      store,
      registry,
      dir: tmp(),
      scorer: { scoreOffline: async () => ({ verdict: "approve", score: 9, rationale: "fine" }) },
    });
    await sup.init({ reconcile: false });

    const job = await sup.startReview({ mode: "drain" });
    const done = await waitTerminal(sup, job.jobId);
    assert.equal(done.result.outcome, "drained");
    assert.equal(done.result.reviewed, 3);
    assert.equal(store.getStats().reviewed, 3);
    assert.equal(store.getStats().pendingReview, 0);

    await sup.close();
    await registry.close();
    await store.close();
  } finally {
    config.jobs.pollIntervalMs = prevPoll;
  }
});
