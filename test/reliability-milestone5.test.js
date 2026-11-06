import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ArticleStore } from "../src/storage/article-store.js";
import { RegistryStore } from "../src/storage/registry-store.js";
import { JobStore, JOB_STATUS } from "../src/jobs/job-store.js";
import { JobSupervisor } from "../src/jobs/supervisor.js";
import { executeFullRun } from "../src/training/lifecycle.js";
import { ensureAppendBoundary, readNdjsonFile } from "../src/storage/ndjson.js";
import { config } from "../src/config.js";

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-reliability-")));
const EVAL_SEED = [
  { promptId: "q1", prompt: "Capital of France?", completion: "Paris is the capital of France." },
  { promptId: "q2", prompt: "What is 2+2?", completion: "Two plus two equals four." },
];

async function seededStore(n = 3) {
  const store = await ArticleStore.open(tmp());
  for (let i = 0; i < n; i += 1) {
    const a = await store.ingestArticle({ text: `Reliability article ${i} with enough reasoning prose.`, domain: "reasoning" });
    await store.recordReview({ articleId: a.articleId, verdict: "approve", authority: "human" });
  }
  return store;
}

function withPaired(loss) {
  return {
    ok: true,
    loss,
    datasetHash: "EVALSET",
    blockCount: 459,
    tokensSeen: 6000,
    evaluationSet: { datasetHash: "EVALSET", blockCount: 459, tokensSeen: 6000 },
    perDocument: Array.from({ length: 30 }, (_, i) => ({ articleId: `a${i}`, group: `g${i}`, tokens: 200, loss })),
  };
}

function trainerWithPreflight(preflight) {
  return {
    kind: "python",
    version: "python-test",
    async resolveBaseline() {
      return { version: "v001", path: "store/v001" };
    },
    preflight,
    async train({ runId }) {
      return {
        checkpointPath: "store/v002",
        version: "v002",
        parentVersion: "v001",
        trainingRunId: "trid",
        nodeRunId: runId,
        datasetHash: "DATAHASH",
        recordsProcessed: 3,
        finalTrainLoss: 1.2,
      };
    },
  };
}

function lifecycleDeps({ store, preflight, measure }) {
  return {
    store,
    trainer: trainerWithPreflight(preflight),
    measureDocuments: measure,
    evalSeed: async () => EVAL_SEED,
    evaluateLoss: async ({ version }) => withPaired(version === "v001" ? 2.0 : 1.4),
    setActive: async (version) => ({ version }),
  };
}

test("NDJSON reader skips NUL/corrupt lines and continues with later records", async () => {
  const dir = tmp();
  const file = path.join(dir, "events.ndjson");
  writeFileSync(file, `${JSON.stringify({ n: 1 })}\n\u0000\u0000\u0000\n${JSON.stringify({ n: 2 })}\n{broken`);
  const { records, errors } = await readNdjsonFile(file);
  assert.deepEqual(records, [{ n: 1 }, { n: 2 }]);
  assert.equal(errors.length, 2);
  assert.equal(errors[0].reason, "invalid-json");

  const before = readFileSync(file);
  assert.equal(ensureAppendBoundary(file), true);
  const after = readFileSync(file);
  assert.deepEqual(after.subarray(0, before.length), before, "existing bytes must be preserved");
  assert.equal(after.at(-1), 0x0a);
  appendFileSync(file, `${JSON.stringify({ n: 3 })}\n`);
  assert.deepEqual((await readNdjsonFile(file)).records, [{ n: 1 }, { n: 2 }, { n: 3 }]);
});

test("JobStore tolerates a NUL tail and appends new records on a clean boundary", async () => {
  const dir = tmp();
  const first = { jobId: "job-1", kind: "learning", title: "Learning", mode: "continuous", params: {}, createdAt: new Date().toISOString() };
  const event = { jobId: "job-1", status: JOB_STATUS.RUNNING, at: new Date().toISOString() };
  writeFileSync(path.join(dir, "jobs.ndjson"), `${JSON.stringify(first)}\n`);
  writeFileSync(path.join(dir, "job-events.ndjson"), `${JSON.stringify(event)}\n\u0000\u0000torn`);

  const store = await JobStore.open(dir);
  assert.equal(store.getJob("job-1").status, JOB_STATUS.RUNNING);
  assert.ok(store.parseErrors.some((e) => e.file === "job-events.ndjson"));
  await store.jobEvent("job-1", { status: JOB_STATUS.WAITING, phase: "waiting" });
  assert.equal(store.getJob("job-1").status, JOB_STATUS.WAITING);
  await store.close();

  const again = await JobStore.open(dir);
  assert.equal(again.getJob("job-1").status, JOB_STATUS.WAITING);
  await again.close();
});

test("stale-run recovery skips a live RUN.lock owner and recoverable promotion manifests", async () => {
  const dir = tmp();
  const manifests = tmp();
  const r = await RegistryStore.open(dir);
  const live = await r.createRun({ datasetId: "d" });
  const protectedRun = await r.createRun({ datasetId: "d" });
  const stale = await r.createRun({ datasetId: "d" });

  await r.acquireRunLock(60_000, { runId: live.runId });
  assert.deepEqual(await r.recoverStaleRuns(1, { manifestDir: manifests }), []);
  assert.equal(r.getRun(live.runId).status, "created");
  r.releaseRunLock();

  writeFileSync(
    path.join(manifests, `${protectedRun.runId}-manifest.json`),
    JSON.stringify({ runId: protectedRun.runId, decision: "promoted", consumed: false, settled: false }),
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  const recovered = await r.recoverStaleRuns(1, { manifestDir: manifests });
  assert.deepEqual(recovered.sort(), [live.runId, stale.runId].sort());
  assert.equal(r.getRun(stale.runId).status, "failed");
  assert.equal(r.getRun(live.runId).status, "failed");
  assert.equal(r.getRun(protectedRun.runId).status, "created");
  await r.close();
});

test("supervisor close leaves in-flight durable state non-terminal, without a STOPPED event", async () => {
  const store = await ArticleStore.open(tmp());
  const registry = await RegistryStore.open(tmp());
  const jobDir = tmp();
  const sup = new JobSupervisor({
    store,
    registry,
    dir: jobDir,
    learningDeps: {
      collectDocuments: async () => ({ documents: [], failures: [] }),
    },
  });
  await sup.init({ reconcile: false });
  const job = await sup.startLearning({ mode: "continuous", targetArticles: 5 });
  await new Promise((resolve) => setTimeout(resolve, 25));

  await sup.close({ graceMs: 100, abortGraceMs: 100 });
  await registry.close();
  await store.close();

  const reopened = await JobStore.open(jobDir);
  const saved = reopened.getJob(job.jobId);
  assert.ok(saved, "the job remains durable");
  assert.equal(saved.terminal, false);
  assert.notEqual(saved.status, JOB_STATUS.STOPPED);
  assert.equal(
    (reopened.events.get(job.jobId) ?? []).some((e) => e.status === JOB_STATUS.STOPPED),
    false,
    "shutdown must not masquerade as an operator stop",
  );
  await reopened.close();
});

test("tokenizer-aware validation expansion occurs before the run is created", async () => {
  const previousStore = config.pythonStore;
  const previousReplay = config.trainReplayPercent;
  const storeDir = tmp();
  try {
    const versionDir = path.join(storeDir, "v001");
    mkdirSync(versionDir, { recursive: true });
    writeFileSync(path.join(versionDir, "tokenizer.json"), "{}\n");
    writeFileSync(path.join(storeDir, "working.json"), JSON.stringify({ version: "v001" }));

    config.pythonStore = storeDir;
    config.trainReplayPercent = 0;

    const registry = await RegistryStore.open(tmp());
    const store = await seededStore();
    let measureCalls = 0;
    const measure = async (rows) => {
      measureCalls += 1;
      if (measureCalls === 1) {
        return { documentCount: rows.length, totalTokens: 16, blocksIfConcatenated: 1, documents: [] };
      }
      return { documentCount: rows.length, totalTokens: 4096, blocksIfConcatenated: 32, documents: [] };
    };

    const out = await executeFullRun({
      registry,
      options: { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } },
      deps: lifecycleDeps({
        store,
        measure,
        preflight: async () => ({
          ok: true,
          blockCount: 132,
          trainBlockCount: 100,
          validationBlockCount: 32,
          validationShortfall: 0,
          trainTokensSeen: 12000,
          validationTokensSeen: 4096,
          freshTokensSeen: 12000,
          replayTokensSeen: 0,
        }),
      }),
    });

    assert.ok(measureCalls >= 2, "a short holdout must be measured again after expansion");
    assert.equal(out.run.corpusAccounting.validationBlockCount, 32);
    await store.close();
    await registry.close();
  } finally {
    config.pythonStore = previousStore;
    config.trainReplayPercent = previousReplay;
  }
});

test("authoritative preflight refuses a 31/32 validation holdout before createRun", async () => {
  const registry = await RegistryStore.open(tmp());
  const store = await seededStore();
  let trained = false;
  const deps = lifecycleDeps({
    store,
    preflight: async () => ({
      ok: true,
      blockCount: 131,
      trainBlockCount: 100,
      validationBlockCount: 31,
      validationShortfall: 1,
      trainTokensSeen: 12000,
      validationTokensSeen: 3968,
      freshTokensSeen: 12000,
      replayTokensSeen: 0,
    }),
  });
  deps.trainer.train = async () => {
    trained = true;
    throw new Error("must not train an under-validated run");
  };

  await assert.rejects(
    executeFullRun({
      registry,
      options: { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } },
      deps,
    }),
    (err) => err.code === "INSUFFICIENT_VALIDATION" && err.validationBlockCount === 31 && err.validationShortfall === 1,
  );
  assert.equal(trained, false);
  assert.equal(registry.listRuns().length, 0);
  await store.close();
  await registry.close();
});
