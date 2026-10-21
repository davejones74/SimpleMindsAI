import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArticleStore } from "../src/storage/article-store.js";
import { RegistryStore } from "../src/storage/registry-store.js";
import { JobSupervisor } from "../src/jobs/supervisor.js";
import { JOB_STATUS } from "../src/jobs/job-store.js";
import { QUARANTINE_REASON } from "../src/domain/article.js";

/**
 * Slice 6 — recovery-driven progress. Training material is only reviewed,
 * unconsumed, non-retired articles; the corpus is never replayed. The system must
 * report honestly when there is no eligible unconsumed material, and distinguish
 * a dry pipeline from one that can still recover material (review/quarantine).
 */

const tmp = () => mkdtempSync(path.join(tmpdir(), "sma-recovery-"));

// The supervisor's gates use unref()'d timers; keep the loop alive so node:test
// does not cancel a subtest that is waiting on a boundary.
let keepAlive;
before(() => { keepAlive = setInterval(() => {}, 1000); });
after(() => { clearInterval(keepAlive); });

async function waitFor(sup, jobId, predicate, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    const job = sup.getJob(jobId);
    if (job && predicate(job)) return job;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`condition not met for ${jobId} (last phase=${job?.phase}, status=${job?.status})`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("getStats reports no-eligible-unconsumed, the recoverable pipeline, and quarantine recovery", async () => {
  const store = await ArticleStore.open(tmp());

  let s = store.getStats();
  assert.equal(s.trainable, 0);
  assert.equal(s.noEligibleUnconsumed, true);
  assert.equal(s.recoverable, 0);

  // Ingested (pipeline) + reviewed/unconsumed (trainable) + quarantined.
  await store.ingestArticle({ text: "An ingested article awaiting review with reasoning.", domain: "reasoning" });
  const trainable = await store.ingestArticle({ text: "A reviewed, unconsumed article with reasoning.", domain: "reasoning" });
  await store.recordReview({ articleId: trainable.articleId, verdict: "approve", authority: "human" });
  const held = await store.ingestArticle({ text: "A quarantined article with reasoning prose here.", domain: "reasoning" });
  await store.quarantineArticle(held.articleId, { reason: QUARANTINE_REASON.CORRUPTED_TEXT });

  s = store.getStats();
  assert.equal(s.trainable, 1);
  assert.equal(s.noEligibleUnconsumed, false);
  assert.equal(s.ingested, 1);
  assert.equal(s.quarantined, 1);
  assert.equal(s.recoverable, 2, "ingested + quarantined can still become trainable");

  // Releasing quarantine is recovery: the article returns to the pipeline.
  await store.releaseQuarantine(held.articleId);
  s = store.getStats();
  assert.equal(s.quarantineReleased, 1);
  assert.equal(s.quarantined, 0);
  // The released article returns to the EARLIER of its pre-quarantine states
  // (INGESTED or, if the deterministic sampler had selected it, PENDING_REVIEW).
  // Either way it is back in the recoverable pipeline.
  assert.equal(s.ingested + s.pendingReview, 2);
  assert.equal(s.recoverable, 2);

  await store.close();
});

test("continuous training reports the honest dry-pipeline reason", async () => {
  const store = await ArticleStore.open(tmp());
  const registry = await RegistryStore.open(tmp());
  const sup = new JobSupervisor({ store, registry, dir: tmp() });
  await sup.init({ reconcile: false });

  const job = await sup.startTraining({ mode: "continuous", minEligible: 1 });
  const waiting = await waitFor(sup, job.jobId, (j) => j.phase === "waiting-for-eligible");
  assert.equal(waiting.status, JOB_STATUS.WAITING);
  assert.equal(waiting.meta.waitingReason, "no-eligible-unconsumed-material");
  assert.match(waiting.note, /no eligible unconsumed material/i);

  await sup.stop(job.jobId);
  await waitFor(sup, job.jobId, (j) => j.terminal);
  await sup.close();
  await store.close();
  await registry.close();
});

test("continuous training reports recovery-pending when material can still become eligible", async () => {
  const store = await ArticleStore.open(tmp());
  await store.ingestArticle({ text: "Ingested, not yet reviewed, with sufficient reasoning.", domain: "reasoning" });
  const registry = await RegistryStore.open(tmp());
  const sup = new JobSupervisor({ store, registry, dir: tmp() });
  await sup.init({ reconcile: false });

  const job = await sup.startTraining({ mode: "continuous", minEligible: 1 });
  const waiting = await waitFor(sup, job.jobId, (j) => j.phase === "waiting-for-eligible");
  assert.equal(waiting.meta.waitingReason, "recovery-pending");
  assert.match(waiting.note, /recoverable/i);
  assert.equal(waiting.meta.recovery.ingested, 1);

  await sup.stop(job.jobId);
  await waitFor(sup, job.jobId, (j) => j.terminal);
  await sup.close();
  await store.close();
  await registry.close();
});

test("one-shot training names the no-eligible-unconsumed condition explicitly", async () => {
  const store = await ArticleStore.open(tmp());
  const registry = await RegistryStore.open(tmp());
  const sup = new JobSupervisor({ store, registry, dir: tmp() });
  await sup.init({ reconcile: false });

  const job = await sup.startTraining({ mode: "one-shot", minEligible: 1 });
  const done = await waitFor(sup, job.jobId, (j) => j.terminal);
  assert.equal(done.status, JOB_STATUS.FAILED);
  assert.match(done.error, /no eligible unconsumed material/i);

  await sup.close();
  await store.close();
  await registry.close();
});
