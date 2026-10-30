import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArticleStore } from "../src/storage/article-store.js";
import { RegistryStore } from "../src/storage/registry-store.js";
import { JobStore, JOB_STATUS } from "../src/jobs/job-store.js";
import { JobSupervisor, JobConflictError } from "../src/jobs/supervisor.js";
import { runLearningCycle } from "../src/jobs/learning.js";
import { probeTeacher } from "../src/admin/teacher.js";

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-jobs-")));

// The supervisor's pause/wait gates (src/jobs/supervisor.js #holdGate/#gate)
// schedule with `unref()`'d timers, so a test that awaits a paused boundary can
// leave the event loop empty — node:test then treats the still-pending subtest as
// `cancelledByParent` instead of letting it finish. Hold a referenced timer for
// the lifetime of this file so the loop never drains mid-test; it is cleared when
// the file's tests complete, so the runner still exits normally.
let keepAlive;
before(() => { keepAlive = setInterval(() => {}, 1000); });
after(() => { clearInterval(keepAlive); });

const EVAL_SEED = [
  { promptId: "q1", prompt: "Capital of France?", completion: "Paris is the capital of France." },
  { promptId: "q2", prompt: "What is 2+2?", completion: "Two plus two equals four." },
];

async function seededStore(n = 3) {
  const store = await ArticleStore.open(tmp());
  for (let i = 0; i < n; i++) {
    const a = await store.ingestArticle({ text: `Job article number ${i} with enough reasoning prose.`, domain: "reasoning" });
    await store.recordReview({ articleId: a.articleId, verdict: "approve", authority: "human" });
  }
  return store;
}

async function waitTerminal(sup, jobId, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    const job = sup.getJob(jobId);
    if (job && job.terminal) return job;
    if (Date.now() - start > timeoutMs) throw new Error(`job ${jobId} did not reach a terminal state (last: ${job?.status})`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ------------------------------------------------------------------ JobStore

test("JobStore: events fold over the creation line and reload from disk", async () => {
  const dir = tmp();
  const s = await JobStore.open(dir);
  const job = await s.createJob({ kind: "learning", mode: "bounded", params: { targetArticles: 5 } });
  assert.equal(job.jobId, "job-1");
  assert.equal(s.getJob(job.jobId).status, JOB_STATUS.QUEUED);

  await s.jobEvent(job.jobId, { status: JOB_STATUS.RUNNING, phase: "harvest" });
  await s.jobEvent(job.jobId, { progress: { cycle: 1, ingested: 2 } });
  await s.appendLog(job.jobId, { stream: "out", text: "hello" });
  assert.equal(s.getJob(job.jobId).status, JOB_STATUS.RUNNING);
  assert.equal(s.getJob(job.jobId).terminal, false);
  assert.deepEqual(s.getJob(job.jobId).progress, { cycle: 1, ingested: 2 });
  assert.equal(s.getLog(job.jobId).length, 1);

  await s.jobEvent(job.jobId, { status: JOB_STATUS.COMPLETED, result: { ok: true } });
  assert.equal(s.getJob(job.jobId).terminal, true);
  assert.deepEqual(s.getJob(job.jobId).result, { ok: true });
  await s.close();

  // Reload proves durability (append-only ndjson, folded on open).
  const s2 = await JobStore.open(dir);
  assert.equal(s2.getJob(job.jobId).status, JOB_STATUS.COMPLETED);
  assert.equal(s2.listJobs().length, 1);
  await s2.close();
});

test("JobStore: read-only instances refuse writes", async () => {
  const dir = tmp();
  const s = await JobStore.open(dir);
  await s.createJob({ kind: "training" });
  await s.close();
  const ro = await JobStore.open(dir, { readOnly: true });
  await assert.rejects(ro.createJob({ kind: "training" }), /read-only/);
  await ro.close();
});

// ------------------------------------------------------------ learning cycle

function fakeHarvest() {
  return async () => ({
    mode: "fixture",
    capability: "fixture-harvest",
    documents: [{ text: "A fixture document about reasoning.", domain: "reasoning", source: "fixture" }],
    failures: [],
  });
}

const fakeOllama = { model: "teacher-x", clean: async () => [{ text: "A curated reasoning unit of sufficient length.", domain: "reasoning" }] };
const fakeScorer = {
  scoreOffline: async () => ({
    verdict: "approve",
    score: 9,
    rationale: "clearly useful",
    criticModel: "teacher-x",
    criticVersion: "1",
    rubricVersion: "1",
    guardrailResult: { ok: true },
    suggestedImportance: "Normal",
  }),
};

test("learning cycle: acquires + dedupes, and reports exhaustion honestly", async () => {
  const store = await ArticleStore.open(tmp());
  const first = await runLearningCycle({
    store,
    ollama: fakeOllama,
    scorer: fakeScorer,
    collectDocuments: fakeHarvest(),
    maxRawDocs: 0,
  });
  assert.equal(first.rawDocs, 1);
  assert.equal(first.ingested, 1);
  assert.equal(first.deduped, 0);
  assert.equal(first.sourceExhausted, false);

  // A second pass finds the same document already ingested => deduped, and it
  // must NOT claim success. It is also NOT source exhaustion: the source still
  // yielded a document this pass (no new material is a no-progress condition,
  // handled by the supervisor's streak guard, not by source death).
  const second = await runLearningCycle({
    store,
    ollama: fakeOllama,
    scorer: fakeScorer,
    collectDocuments: fakeHarvest(),
    maxRawDocs: 0,
  });
  assert.equal(second.ingested, 0);
  assert.equal(second.deduped, 1);
  assert.equal(second.sourceExhausted, false);

  await store.close();
});


test("learning cycle: admission cap exhaustion is surfaced, not treated as source death", async () => {
  const store = await ArticleStore.open(tmp());
  const out = await runLearningCycle({
    store,
    ollama: fakeOllama,
    scorer: fakeScorer,
    collectDocuments: async () => ({
      mode: "real",
      capability: "configured-fetch",
      documents: [],
      failures: [],
      capExhausted: true,
      capEpoch: "gateway-test-01",
      admissionCapDeferred: 1,
    }),
    maxRawDocs: 0,
  });
  assert.equal(out.admissionCapExhausted, true);
  assert.equal(out.admissionCapEpoch, "gateway-test-01");
  assert.equal(out.admissionCapDeferred, 1);
  await store.close();
});

test("learning cycle: articles it acquires enter review, so they can become trainable", async () => {
  // The acquisition job's contract is "N TRAINABLE articles". Previously the
  // ingested articles were left to `selectionDecision`'s ~10% sampling gate, so
  // a small acquisition was silently dropped and the job reported
  // `reviewed: 0, trainable: 0` after ingesting everything it had fetched.
  const store = await ArticleStore.open(tmp());
  // Each raw document must curate to a DISTINCT unit, otherwise the second is
  // legitimately deduped by content hash and the acquisition count is 1.
  fakeOllama.__n = 0;
  const out = await runLearningCycle({
    store,
    ollama: {
      model: "teacher-x",
      clean: async () => {
        fakeOllama.__n += 1;
        return [{ text: `A curated reasoning unit of sufficient length #${fakeOllama.__n}.`, domain: "reasoning" }];
      },
    },
    scorer: fakeScorer,
    collectDocuments: async () => ({
      mode: "fixture",
      capability: "fixture-harvest",
      documents: [
        { text: "First fixture document about reasoning and logic.", domain: "reasoning", source: "fixture" },
        { text: "Second fixture document about recursion and proof.", domain: "reasoning", source: "fixture" },
      ],
      failures: [],
    }),
    maxRawDocs: 0,
  });

  assert.equal(out.ingested, 2, "both documents must be acquired");
  assert.equal(out.reviewed, 2, "acquired articles must reach the teacher critic, not a sampling gate");
  assert.equal(out.trainable, 2, "reviewed + approved articles are trainable");

  await store.close();
});

// The exhaustion signal must come from the AUTHORITATIVE acquisition
// classification, never from `rawDocs === 0` alone.

function harvestResult(overrides = {}) {
  return async () => ({
    mode: "real",
    capability: "configured-fetch",
    documents: [],
    failures: [],
    ...overrides,
  });
}

async function cycleWithHarvest(collectDocuments) {
  const store = await ArticleStore.open(tmp());
  try {
    return await runLearningCycle({ store, ollama: fakeOllama, scorer: fakeScorer, collectDocuments, maxRawDocs: 0 });
  } finally {
    await store.close();
  }
}

test("learning cycle: claimable queued work with no documents is NOT source exhaustion", async () => {
  const out = await cycleWithHarvest(
    harvestResult({ frontier: { queued: 1000, deferred: 0, deferredDue: 0, rediscoveryDue: 0 } }),
  );
  assert.equal(out.rawDocs, 0);
  assert.equal(out.acquisition.state, "work");
  assert.equal(out.sourceExhausted, false, "queued claimable work is never source exhaustion");
  assert.equal(out.noUsefulDocuments, true, "a zero-document pass is reported as a transient harvest state");
});

test("learning cycle: genuine exhaustion (empty frontier, no viable provider) sets sourceExhausted", async () => {
  const out = await cycleWithHarvest(
    harvestResult({ frontier: { queued: 0, deferred: 0, deferredDue: 0, rediscoveryDue: 0 } }),
  );
  assert.equal(out.acquisition.state, "exhausted");
  assert.equal(out.sourceExhausted, true);
  assert.equal(out.noUsefulDocuments, false);
});

test("learning cycle: a viable discovery provider prevents false exhaustion on an empty frontier", async () => {
  const out = await cycleWithHarvest(
    harvestResult({
      frontier: { queued: 0, deferred: 0, deferredDue: 0, rediscoveryDue: 0 },
      discovery: { status: "ok", providerAvailable: true, bootstrap: { adapters: [{ name: "sitemap", status: "ok", enqueued: 0 }] } },
    }),
  );
  assert.equal(out.acquisition.state, "viable");
  assert.equal(out.sourceExhausted, false);
});

test("learning cycle: admission quota exhaustion is distinct from source exhaustion", async () => {
  // Empty frontier would otherwise classify as exhausted — but a quota wait is a
  // lifecycle condition, not source death.
  const out = await cycleWithHarvest(
    harvestResult({
      frontier: { queued: 0, deferred: 0, deferredDue: 0, rediscoveryDue: 0 },
      quotaExhausted: true,
      admissionQuotaDeferred: 1,
      quotaUsed: 50000,
      quotaLimit: 50000,
    }),
  );
  assert.equal(out.admissionQuotaExhausted, true);
  assert.equal(out.admissionCapExhausted, true);
  assert.equal(out.sourceExhausted, false, "quota exhaustion must not be reported as source exhaustion");
});

test("learning cycle: reports the fixture source ceiling instead of implying it can meet any target", async () => {
  const store = await ArticleStore.open(tmp());
  const out = await runLearningCycle({
    store,
    ollama: fakeOllama,
    scorer: fakeScorer,
    collectDocuments: fakeHarvest(),
    maxRawDocs: 0,
  });
  assert.equal(out.mode, "fixture");
  assert.equal(out.corpusCeiling, out.rawDocs, "a fixture source can never supply more than it holds");
  await store.close();
});

test("learning cycle: reviews a queued article through the teacher scorer", async () => {
  const store = await ArticleStore.open(tmp());
  const a = await store.ingestArticle({ text: "An explicitly queued review candidate with enough prose.", domain: "reasoning" });
  await store.requestReview(a.articleId, { reason: "test" });

  const out = await runLearningCycle({
    store,
    ollama: fakeOllama,
    scorer: fakeScorer,
    collectDocuments: async () => ({ mode: "fixture", capability: "fixture-harvest", documents: [], failures: [] }),
    maxRawDocs: 0,
  });
  assert.ok(out.reviewed >= 1);
  assert.equal(out.trainable, 1);
  await store.close();
});

// ---------------------------------------------------------------- supervisor

test("supervisor: continuous learning parks when the admission epoch is full", async () => {
  const store = await ArticleStore.open(tmp());
  const registry = await RegistryStore.open(tmp());
  let cycles = 0;
  const sup = new JobSupervisor({
    store,
    registry,
    dir: tmp(),
    ollama: fakeOllama,
    scorer: fakeScorer,
    learningDeps: {
      collectDocuments: async () => {
        cycles += 1;
        return {
          mode: "real",
          capability: "configured-fetch",
          documents: [],
          failures: [],
          capExhausted: true,
          capEpoch: "gateway-test-01",
          admissionCapDeferred: 1,
        };
      },
    },
  });
  await sup.init({ reconcile: false });
  try {
    const job = await sup.startLearning({ mode: "continuous" });
    let current = sup.getJob(job.jobId);
    for (let i = 0; i < 200 && !(current.progress?.admissionCapExhausted && current.status === JOB_STATUS.WAITING); i++) {
      await new Promise((r) => setTimeout(r, 10));
      current = sup.getJob(job.jobId);
    }
    assert.ok(cycles >= 1, "the learning cycle ran");
    assert.equal(current.status, JOB_STATUS.WAITING);
    assert.equal(current.phase, "waiting-for-admission-cap");
    assert.equal(current.progress.admissionCapExhausted, true);
    assert.equal(current.progress.admissionCapEpoch, "gateway-test-01");

    await sup.stop(job.jobId);
    const done = await waitTerminal(sup, job.jobId);
    assert.equal(done.status, JOB_STATUS.STOPPED);
  } finally {
    await sup.close();
    await store.close();
    await registry.close();
  }
});

test("supervisor: continuous learning parks on rolling quota exhaustion", async () => {
  const store = await ArticleStore.open(tmp());
  const registry = await RegistryStore.open(tmp());
  let cycles = 0;
  const sup = new JobSupervisor({
    store,
    registry,
    dir: tmp(),
    ollama: fakeOllama,
    scorer: fakeScorer,
    learningDeps: {
      collectDocuments: async () => {
        cycles += 1;
        return {
          mode: "real",
          capability: "configured-fetch",
          documents: [],
          failures: [],
          quotaExhausted: true,
          admissionDeferred: 1,
          admissionQuotaDeferred: 1,
          quotaUsed: 50000,
          quotaLimit: 50000,
          quotaRetryAfterMs: 1000,
          quotaPolicyVersion: "rolling-v1",
          capExhausted: true,
          capEpoch: "rolling-test-epoch",
        };
      },
    },
  });
  await sup.init({ reconcile: false });
  try {
    const job = await sup.startLearning({ mode: "continuous" });
    let current = sup.getJob(job.jobId);
    for (let i = 0; i < 200 && !(current.progress?.admissionQuotaExhausted && current.status === JOB_STATUS.WAITING); i++) {
      await new Promise((r) => setTimeout(r, 10));
      current = sup.getJob(job.jobId);
    }
    assert.ok(cycles >= 1, "the learning cycle ran");
    assert.equal(current.status, JOB_STATUS.WAITING);
    assert.equal(current.phase, "waiting-for-admission-quota");
    assert.equal(current.progress.admissionQuotaExhausted, true);
    assert.equal(current.progress.admissionQuotaUsed, 50000);
    assert.equal(current.progress.admissionQuotaPolicyVersion, "rolling-v1");

    await sup.stop(job.jobId);
    const done = await waitTerminal(sup, job.jobId);
    assert.equal(done.status, JOB_STATUS.STOPPED);
  } finally {
    await sup.close();
    await store.close();
    await registry.close();
  }
});

test("supervisor: a second job of the same kind is a conflict (409)", async () => {
  const store = await seededStore(0);
  const registry = await RegistryStore.open(tmp());
  const sup = new JobSupervisor({ store, registry, dir: tmp() });
  await sup.init({ reconcile: false });

  // Continuous training with no eligible material parks in waiting-for-eligible.
  const job = await sup.startTraining({ mode: "continuous", minEligible: 1 });
  await assert.rejects(sup.startTraining({ mode: "continuous" }), (e) => e instanceof JobConflictError);
  await sup.stop(job.jobId);
  await waitTerminal(sup, job.jobId);
  assert.equal(sup.getJob(job.jobId).status, JOB_STATUS.STOPPED);

  await sup.close();
  await store.close();
  await registry.close();
});

test("supervisor: one-shot training refuses below the eligibility gate", async () => {
  const store = await seededStore(0);
  const registry = await RegistryStore.open(tmp());
  const sup = new JobSupervisor({ store, registry, dir: tmp() });
  await sup.init({ reconcile: false });

  const job = await sup.startTraining({ mode: "one-shot", minEligible: 1 });
  const done = await waitTerminal(sup, job.jobId);
  assert.equal(done.status, JOB_STATUS.FAILED);
  assert.match(done.error, /insufficient eligible material/);

  await sup.close();
  await store.close();
  await registry.close();
});

test("supervisor: continuous training waits for material, then stops cooperatively", async () => {
  const store = await seededStore(0);
  const registry = await RegistryStore.open(tmp());
  const sup = new JobSupervisor({ store, registry, dir: tmp() });
  await sup.init({ reconcile: false });

  const job = await sup.startTraining({ mode: "continuous", minEligible: 1 });
  // Give the loop a moment to enter the waiting state.
  for (let i = 0; i < 100 && sup.getJob(job.jobId).status !== JOB_STATUS.WAITING; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(sup.getJob(job.jobId).status, JOB_STATUS.WAITING);

  await sup.stop(job.jobId);
  const done = await waitTerminal(sup, job.jobId);
  assert.equal(done.status, JOB_STATUS.STOPPED);

  await sup.close();
  await store.close();
  await registry.close();
});

test("supervisor: continuous training can be paused and resumed at the boundary", async () => {
  const store = await seededStore(0);
  const registry = await RegistryStore.open(tmp());
  const sup = new JobSupervisor({ store, registry, dir: tmp() });
  await sup.init({ reconcile: false });

  const job = await sup.startTraining({ mode: "continuous", minEligible: 1 });
  for (let i = 0; i < 100 && sup.getJob(job.jobId).status !== JOB_STATUS.WAITING; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(sup.getJob(job.jobId).status, JOB_STATUS.WAITING);

  await sup.pause(job.jobId);
  // The pause must reach the safe boundary promptly (the gate resolves on request).
  let paused = sup.getJob(job.jobId);
  for (let i = 0; i < 100 && paused.status !== JOB_STATUS.PAUSED; i++) {
    await new Promise((r) => setTimeout(r, 10));
    paused = sup.getJob(job.jobId);
  }
  assert.equal(paused.status, JOB_STATUS.PAUSED);

  await sup.resume(job.jobId);
  let resumed = sup.getJob(job.jobId);
  for (let i = 0; i < 100 && resumed.status === JOB_STATUS.PAUSED; i++) {
    await new Promise((r) => setTimeout(r, 10));
    resumed = sup.getJob(job.jobId);
  }
  assert.notEqual(resumed.status, JOB_STATUS.PAUSED);

  await sup.stop(job.jobId);
  const done = await waitTerminal(sup, job.jobId);
  assert.equal(done.status, JOB_STATUS.STOPPED);

  await sup.close();
  await store.close();
  await registry.close();
});

test("supervisor: one-shot training honors a pause requested during the run", async () => {
  const store = await seededStore(3);
  const registry = await RegistryStore.open(tmp());
  let release;
  const gate = new Promise((r) => { release = r; });
  let trainStarted = false;
  const trainer = {
    kind: "python",
    version: "py-1",
    resolveBaseline: async () => ({ version: "v001", path: "x/v001" }),
    resolveVersion: async (v) => ({ version: v, path: `x/${v}` }),
    train: async ({ runId }) => {
      trainStarted = true;
      await gate;
      return {
        checkpointPath: "x/v002",
        version: "v002",
        parentVersion: "v001",
        trainingRunId: "trid",
        nodeRunId: runId,
        datasetHash: "DH",
        recordsProcessed: 3,
        finalTrainLoss: 1.2,
        note: "python",
      };
    },
  };
  const sup = new JobSupervisor({
    store,
    registry,
    dir: tmp(),
    trainerFactory: () => trainer,
    trainingDeps: {
      paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() },
      evalSeed: async () => EVAL_SEED,
      evaluateLoss: async ({ version }) => {
        const loss = version === "v001" ? 2.0 : 1.4;
        return { version, loss, datasetHash: "EVAL", ok: true, blockCount: 459, tokensSeen: 6000, evaluationSet: { datasetHash: "EVAL", blockCount: 459, tokensSeen: 6000 }, perDocument: Array.from({ length: 30 }, (_, i) => ({ articleId: `a${i}`, group: `g${i}`, tokens: 200, loss })) };
      },
      setActive: async (version) => ({ version }),
    },
  });
  await sup.init({ reconcile: false });

  const job = await sup.startTraining({ mode: "one-shot" });
  for (let i = 0; i < 200 && !trainStarted; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(trainStarted, "the trainer must be executing before we pause");

  await sup.pause(job.jobId);
  assert.equal(sup.getJob(job.jobId).status, JOB_STATUS.PAUSE_REQUESTED);

  release(); // finish the single run; the job must hold at PAUSED, not complete
  let paused = sup.getJob(job.jobId);
  for (let i = 0; i < 200 && paused.status !== JOB_STATUS.PAUSED; i++) {
    await new Promise((r) => setTimeout(r, 10));
    paused = sup.getJob(job.jobId);
  }
  assert.equal(paused.status, JOB_STATUS.PAUSED);
  assert.equal(paused.terminal, false);

  await sup.resume(job.jobId);
  const done = await waitTerminal(sup, job.jobId);
  assert.equal(done.status, JOB_STATUS.COMPLETED);
  assert.equal(done.result.decision, "promoted");

  await sup.close();
  await store.close();
  await registry.close();
});

test("supervisor: one-shot training runs the lifecycle and reports promotion", async () => {
  const store = await seededStore(3);
  const registry = await RegistryStore.open(tmp());
  let activated = null;
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
      recordsProcessed: 3,
      finalTrainLoss: 1.2,
      note: "python",
    }),
  };
  const sup = new JobSupervisor({
    store,
    registry,
    dir: tmp(),
    trainerFactory: () => trainer,
    trainingDeps: {
      paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() },
      evalSeed: async () => EVAL_SEED,
      evaluateLoss: async ({ version }) => {
        const loss = version === "v001" ? 2.0 : 1.4;
        return { version, loss, datasetHash: "EVAL", ok: true, blockCount: 459, tokensSeen: 6000, evaluationSet: { datasetHash: "EVAL", blockCount: 459, tokensSeen: 6000 }, perDocument: Array.from({ length: 30 }, (_, i) => ({ articleId: `a${i}`, group: `g${i}`, tokens: 200, loss })) };
      },
      setActive: async (version) => { activated = version; return { version }; },
    },
  });
  await sup.init({ reconcile: false });

  const job = await sup.startTraining({ mode: "one-shot" });
  const done = await waitTerminal(sup, job.jobId);
  assert.equal(done.status, JOB_STATUS.COMPLETED);
  assert.equal(done.result.decision, "promoted");
  assert.equal(done.result.promoted, true);
  assert.equal(activated, "v002");
  // One document is reserved as validation and is not consumed.
  assert.equal(store.getStats().uniqueConsumed, 2);

  await sup.close();
  await store.close();
  await registry.close();
});

test("supervisor: one-shot training refuses an undersized corpus before any run", async () => {
  const store = await seededStore(1);
  const registry = await RegistryStore.open(tmp());
  const trainer = {
    kind: "python",
    version: "test",
    resolveBaseline: async () => ({ version: "v001", path: "x/v001" }),
    resolveVersion: async (v) => ({ version: v, path: `x/${v}` }),
    preflight: async () => ({
      ok: false,
      code: "INSUFFICIENT_CORPUS",
      error: "corpus has 3 tokens, fewer than one 128-token block; lower --seq-len or supply more text",
    }),
    train: async () => {
      throw new Error("train must not be reached when the preflight refuses");
    },
  };
  const sup = new JobSupervisor({
    store,
    registry,
    dir: tmp(),
    trainerFactory: () => trainer,
    trainingDeps: { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } },
  });
  await sup.init({ reconcile: false });

  const job = await sup.startTraining({ mode: "one-shot", minEligible: 1 });
  const done = await waitTerminal(sup, job.jobId);
  assert.equal(done.status, JOB_STATUS.FAILED);
  assert.match(done.error, /partition would leave no training clusters|fewer than one 128-token block/);
  assert.equal(registry.listRuns().length, 0, "a pre-flighted corpus must never become a failed run");

  await sup.close();
  await store.close();
  await registry.close();
});

test("supervisor: continuous training waits for more corpus instead of crashing", async () => {
  const store = await seededStore(1);
  const registry = await RegistryStore.open(tmp());
  const trainer = {
    kind: "python",
    version: "test",
    resolveBaseline: async () => ({ version: "v001", path: "x/v001" }),
    resolveVersion: async (v) => ({ version: v, path: `x/${v}` }),
    preflight: async () => ({
      ok: false,
      code: "INSUFFICIENT_CORPUS",
      error: "corpus has 3 tokens, fewer than one 128-token block; lower --seq-len or supply more text",
    }),
    train: async () => {
      throw new Error("train must not be reached when the preflight refuses");
    },
  };
  const sup = new JobSupervisor({
    store,
    registry,
    dir: tmp(),
    trainerFactory: () => trainer,
    trainingDeps: { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } },
  });
  await sup.init({ reconcile: false });

  const job = await sup.startTraining({ mode: "continuous", minEligible: 1 });
  for (let i = 0; i < 200 && sup.getJob(job.jobId).phase !== "waiting-for-corpus"; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const waiting = sup.getJob(job.jobId);
  assert.equal(waiting.status, JOB_STATUS.WAITING);
  assert.equal(waiting.phase, "waiting-for-corpus");
  assert.match(waiting.note, /partition would leave no training clusters|fewer than one 128-token block/);
  assert.equal(registry.listRuns().length, 0);

  await sup.stop(job.jobId);
  await waitTerminal(sup, job.jobId);

  await sup.close();
  await store.close();
  await registry.close();
});

test("supervisor: continuous training waits when the dataset is empty instead of failing", async () => {
  // No trainable articles at all, and the eligibility gate set to 0 so the
  // supervisor's own pre-check cannot short-circuit: the empty snapshot must be
  // a WAIT condition for a continuous job, never a terminal failure. The
  // operator reported exactly this — a continuous job failed with "dataset empty
  // after snapshot guards" when there was simply nothing to train on yet.
  const store = await seededStore(0);
  const registry = await RegistryStore.open(tmp());
  const trainer = {
    kind: "python",
    version: "test",
    resolveBaseline: async () => ({ version: "v001", path: "x/v001" }),
    resolveVersion: async (v) => ({ version: v, path: `x/${v}` }),
    preflight: async () => ({ ok: true }),
    train: async () => {
      throw new Error("train must not be reached when the dataset is empty");
    },
  };
  const sup = new JobSupervisor({
    store,
    registry,
    dir: tmp(),
    trainerFactory: () => trainer,
    trainingDeps: { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } },
  });
  await sup.init({ reconcile: false });

  const job = await sup.startTraining({ mode: "continuous", minEligible: 0 });
  for (let i = 0; i < 200 && sup.getJob(job.jobId).phase !== "waiting-for-eligible"; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const waiting = sup.getJob(job.jobId);
  assert.equal(waiting.status, JOB_STATUS.WAITING);
  assert.equal(waiting.phase, "waiting-for-eligible");
  assert.match(waiting.note, /dataset empty after snapshot guards/);
  assert.equal(registry.listRuns().length, 0, "an empty dataset must never become a failed run");
  // The wait must not bake an empty snapshot artifact on every poll.
  assert.equal(registry.listSnapshots().length, 0, "no empty snapshot should be persisted while waiting");

  await sup.stop(job.jobId);
  await waitTerminal(sup, job.jobId);

  await sup.close();
  await store.close();
  await registry.close();
});

test("supervisor: one-shot training still fails clearly on an empty dataset", async () => {
  const store = await seededStore(0);
  const registry = await RegistryStore.open(tmp());
  const trainer = {
    kind: "python",
    version: "test",
    resolveBaseline: async () => ({ version: "v001", path: "x/v001" }),
    train: async () => {
      throw new Error("train must not be reached when the dataset is empty");
    },
  };
  const sup = new JobSupervisor({
    store,
    registry,
    dir: tmp(),
    trainerFactory: () => trainer,
    trainingDeps: { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } },
  });
  await sup.init({ reconcile: false });

  const job = await sup.startTraining({ mode: "one-shot", minEligible: 0 });
  const done = await waitTerminal(sup, job.jobId);
  assert.equal(done.status, JOB_STATUS.FAILED);
  assert.match(done.error, /dataset empty after snapshot guards/);
  assert.equal(registry.listRuns().length, 0);

  await sup.close();
  await store.close();
  await registry.close();
});

// ---------------------------------------------------------------- reconcile

test("reconcile: a run completed before the crash marks the job completed", async () => {
  const dir = tmp();
  const store = await seededStore(0);
  const registry = await RegistryStore.open(tmp());
  const js = await JobStore.open(dir);
  const job = await js.createJob({ kind: "training", mode: "one-shot" });
  await js.jobEvent(job.jobId, { status: JOB_STATUS.RUNNING, phase: "training" });
  await js.close();

  const run = await registry.createRun({ baseModel: "base-1", trainerKind: "python" });
  await registry.completeRun(run.runId, { status: "promoted", promotionStatus: "promoted" });

  const sup = new JobSupervisor({ store, registry, dir });
  await sup.init({ reconcile: true });
  const recovered = sup.getJob(job.jobId);
  assert.equal(recovered.status, JOB_STATUS.COMPLETED);
  assert.match(recovered.note, /already promoted/);

  await sup.close();
  await store.close();
  await registry.close();
});

test("reconcile: a stranded job with no finished run is interrupted, never resumed", async () => {
  const dir = tmp();
  const store = await seededStore(0);
  const registry = await RegistryStore.open(tmp());
  const js = await JobStore.open(dir);
  const job = await js.createJob({ kind: "learning", mode: "continuous" });
  await js.jobEvent(job.jobId, { status: JOB_STATUS.RUNNING, phase: "harvest" });
  await js.close();

  const sup = new JobSupervisor({ store, registry, dir });
  await sup.init({ reconcile: true });
  const recovered = sup.getJob(job.jobId);
  assert.equal(recovered.status, JOB_STATUS.INTERRUPTED);
  assert.equal(recovered.terminal, true);

  await sup.close();
  await store.close();
  await registry.close();
});

// --------------------------------------------------------------- fresh brain

test("fresh brain: registers an unpromoted candidate and never activates it", async () => {
  const store = await seededStore(0);
  const registry = await RegistryStore.open(tmp());
  const runPython = async (args) => {
    if (args[0] === "init") return { ok: true, version: "v005" };
    if (args[0] === "status") return { versions: [{ version: "v005", committed: true, artifactName: "model.pt" }] };
    throw new Error(`unexpected verb ${args[0]}`);
  };
  const sup = new JobSupervisor({ store, registry, dir: tmp(), runPython });
  await sup.init({ reconcile: false });

  const job = await sup.freshBrain({ confirm: true, seed: 7 });
  const done = await waitTerminal(sup, job.jobId);
  assert.equal(done.status, JOB_STATUS.COMPLETED);
  assert.equal(done.result.version, "v005");
  assert.equal(done.result.activated, false);
  assert.equal(registry.getActiveModel(), null);
  const model = registry.listModels().find((m) => m.meta?.pythonVersion === "v005");
  assert.ok(model, "fresh brain registered as a model");
  assert.equal(model.status, "candidate");

  await sup.close();
  await store.close();
  await registry.close();
});

test("fresh brain: refuses without explicit confirmation", async () => {
  const store = await seededStore(0);
  const registry = await RegistryStore.open(tmp());
  const sup = new JobSupervisor({ store, registry, dir: tmp(), runPython: async () => ({}) });
  await sup.init({ reconcile: false });
  await assert.rejects(sup.freshBrain({ confirm: false }), /explicit confirmation/);
  await sup.close();
  await store.close();
  await registry.close();
});

// ------------------------------------------------------------ teacher probe

test("teacher probe: fixture mode is ready without contacting the endpoint", async () => {
  const r = await probeTeacher({ fixture: true });
  assert.equal(r.ready, true);
  assert.equal(r.mode, "fixture");
});

test("teacher probe: reports the configured model, digest match and mismatch", async () => {
  const tagsBody = { models: [{ name: "ssfdre38/gemma4-turbo:e4b", digest: "abc" }] };
  const fetchImpl = async () => ({ ok: true, json: async () => tagsBody });

  const ok = await probeTeacher({ model: "ssfdre38/gemma4-turbo:e4b", expectedDigest: "abc", fixture: false, fetchImpl });
  assert.equal(ok.available, true);
  assert.equal(ok.ready, true);
  assert.equal(ok.matchesExpectedDigest, true);

  const mismatch = await probeTeacher({ model: "ssfdre38/gemma4-turbo:e4b", expectedDigest: "different", fixture: false, fetchImpl });
  assert.equal(mismatch.available, true);
  assert.equal(mismatch.ready, false);
  assert.equal(mismatch.matchesExpectedDigest, false);
  assert.match(mismatch.reason, /does not match pinned/);

  const missing = await probeTeacher({ model: "not-installed", fixture: false, fetchImpl });
  assert.equal(missing.available, false);
  assert.equal(missing.ready, false);
  assert.match(missing.reason, /not installed/);
});

test("teacher probe: an unreachable endpoint is reported, not substituted", async () => {
  const fetchImpl = async () => { throw new Error("ECONNREFUSED"); };
  const r = await probeTeacher({ model: "m", fixture: false, fetchImpl });
  assert.equal(r.ready, false);
  assert.equal(r.available, false);
  assert.match(r.reason, /unreachable/);
});