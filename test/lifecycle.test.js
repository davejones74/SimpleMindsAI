import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RegistryStore } from "../src/storage/registry-store.js";
import { ArticleStore } from "../src/storage/article-store.js";
import { stubTrainer } from "../src/training/trainer-interface.js";
import { executeFullRun } from "../src/training/lifecycle.js";
import { config } from "../src/config.js";

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-")));

const EVAL_SEED = [
  { promptId: "q1", prompt: "Capital of France?", completion: "Paris is the capital of France." },
  { promptId: "q2", prompt: "What is 2+2?", completion: "Two plus two equals four." },
];

async function seededStore() {
  const store = await ArticleStore.open(tmp());
  for (let i = 0; i < 3; i++) {
    const a = await store.ingestArticle({ text: `Sample reasoning article number ${i} with enough prose.`, domain: "reasoning" });
    await store.recordReview({ articleId: a.articleId, verdict: "approve", authority: "human" });
  }
  return store;
}

// Always returns the exact reference completion => baseline and candidate tie.
const exactComplete = async (p) => ({ text: EVAL_SEED.find((i) => i.prompt === p)?.completion ?? "" });

// First evalSet.size calls exact (baseline), then wrong (candidate) => regression.
function regressingComplete() {
  let calls = 0;
  return async (p) => {
    calls++;
    return { text: calls <= EVAL_SEED.length ? (EVAL_SEED.find((i) => i.prompt === p)?.completion ?? "") : "not known exactly" };
  };
}

test("full run: baseline eval -> train -> candidate eval -> promoted, consumption committed", async () => {
  const options = { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } };
  const registry = await RegistryStore.open(tmp());
  const store = await seededStore();

  const out = await executeFullRun({
    registry,
    options,
    deps: { store, trainer: stubTrainer(), complete: exactComplete, evalSeed: async () => EVAL_SEED },
  });
  const run = out.run;

  assert.equal(run.status, "promoted");
  assert.equal(run.promotionStatus, "promoted");
  assert.ok(run.resultModelId);
  assert.equal(registry.getModel(run.resultModelId).status, "promoted");
  assert.equal(registry.getActiveModel().modelId, run.resultModelId);
  // exactly-once consumption happened AFTER training + eval succeeded
  assert.equal(store.getStats().uniqueConsumed, 3);
  assert.equal(store.getStats().trainable, 0);
  await store.close();
  await registry.close();
});

test("failed trainer leaves articles unconsumed (crash-safe boundary)", async () => {
  const registry = await RegistryStore.open(tmp());
  const store = await seededStore();
  const options = { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } };

  await assert.rejects(
    executeFullRun({
      registry,
      options,
      deps: {
        store,
        trainer: { kind: "stub", version: "x", async train() { throw new Error("kaboom"); } },
        complete: exactComplete,
        evalSeed: async () => EVAL_SEED,
      },
    }),
    /kaboom/,
  );

  const runs = registry.listRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "failed");
  assert.equal(store.getStats().uniqueConsumed, 0); // nothing consumed
  assert.equal(store.getStats().trainable, 3);
  await store.close();
  await registry.close();
});

test("regression candidate is rejected; run + model both record rejection", async () => {
  const registry = await RegistryStore.open(tmp());
  const store = await seededStore();
  const options = { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } };

  const out = await executeFullRun({
    registry,
    options,
    deps: { store, trainer: stubTrainer(), complete: regressingComplete(), evalSeed: async () => EVAL_SEED },
  });
  assert.equal(out.decision.decision, "rejected");
  assert.equal(out.run.status, "rejected");
  assert.equal(out.run.promotionStatus, "rejected");
  assert.equal(registry.getModel(out.run.resultModelId).status, "rejected");
  assert.equal(registry.getActiveModel(), null);
  assert.ok(out.run.evaluationDelta < 0);
  await store.close();
  await registry.close();
});

test("chain: second run trains FROM the promoted model as its baseline", async () => {
  const registry = await RegistryStore.open(tmp());
  const store = await seededStore();
  const opts = { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } };

  await executeFullRun({
    registry,
    options: opts,
    deps: { store, trainer: stubTrainer(), complete: exactComplete, evalSeed: async () => EVAL_SEED },
  });
  const first = registry.getActiveModel();
  assert.ok(first);

  for (let i = 0; i < 2; i++) {
    const a = await store.ingestArticle({ text: `Chain article number ${i} with additional reasoning prose.`, domain: "reasoning" });
    await store.recordReview({ articleId: a.articleId, verdict: "approve", authority: "human" });
  }

  const out2 = await executeFullRun({
    registry,
    options: { ...opts, paths: { ...opts.paths, evaluation: tmp() } },
    deps: { store, trainer: stubTrainer(), complete: exactComplete, evalSeed: async () => EVAL_SEED },
  });
  assert.equal(out2.run.baseModel, first.modelId); // promoted model = new baseline
  assert.equal(registry.getRun(out2.run.runId).status, "promoted");
  await store.close();
  await registry.close();
});

// ------------------------------------------------- deferral / retirement
//
// A rejected run must NOT consume its batch: the material is DEFERRED with a
// retry count so a later run can retry it alongside new articles, and is
// RETIRED only once the configured retry budget is exhausted. Every transition
// is an appended article-store event, so it survives a restart.

const rejectedRun = (registry, store) =>
  executeFullRun({
    registry,
    options: { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } },
    deps: { store, trainer: stubTrainer(), complete: regressingComplete(), evalSeed: async () => EVAL_SEED },
  });

test("rejected run defers its batch durably instead of consuming it", async () => {
  const registry = await RegistryStore.open(tmp());
  const store = await seededStore();

  const out = await rejectedRun(registry, store);
  assert.equal(out.decision.decision, "rejected");

  const stats = store.getStats();
  assert.equal(stats.uniqueConsumed, 0, "a rejection never consumes");
  assert.equal(stats.trainable, 3, "deferred material stays eligible");
  assert.equal(stats.retired, 0);

  for (const a of store.articlesPage({ limit: 50 }).items) {
    assert.equal(a.deferralRetries, 1);
    assert.equal(a.deferredRunId, out.run.runId);
    assert.match(a.deferredReason, /improvement|rejected/);
  }

  // Restart recovery: the counters come back from the event log, not memory.
  const dir = store.dir;
  await store.close();
  const reopened = await ArticleStore.open(dir);
  for (const a of reopened.articlesPage({ limit: 50 }).items) {
    assert.equal(a.deferralRetries, 1, "the retry count replays from the log");
    assert.equal(a.deferredRunId, out.run.runId);
    assert.equal(a.status, "REVIEWED");
  }
  assert.equal(reopened.getStats().trainable, 3);
  await reopened.close();
  await registry.close();
});

test("a second rejection exhausts the retry budget and retires the batch", async () => {
  const prev = config.jobs.training.maxRejectedRetries;
  config.jobs.training.maxRejectedRetries = 2;
  const registry = await RegistryStore.open(tmp());
  const store = await seededStore();
  try {
    await rejectedRun(registry, store);
    const second = await rejectedRun(registry, store);
    assert.equal(second.decision.decision, "rejected");

    const stats = store.getStats();
    assert.equal(stats.retired, 3, "retired material is its own visible category");
    assert.equal(stats.trainable, 0, "retired material is no longer eligible");
    assert.equal(stats.uniqueConsumed, 0);
    assert.equal(stats.totalArticles, 3, "retirement hides nothing from the ledger");

    for (const a of store.articlesPage({ limit: 50 }).items) {
      assert.equal(a.status, "RETIRED");
      assert.equal(a.deferralRetries, 2);
      assert.equal(a.deferredReason, "max-retries-exceeded");
      assert.equal(a.deferredRunId, null);
      assert.equal(a.trainable, false);
    }
    // Still addressable by status, and absent from the active queues.
    assert.equal(store.articlesPage({ limit: 50, status: "RETIRED" }).items.length, 3);
    assert.equal(store.reviewQueue({ limit: 50 }).items.length, 0);
    assert.equal(store.trainablePage({ limit: 50 }).items.length, 0);

    // A further run has nothing left to train on — reported, never fabricated.
    await assert.rejects(rejectedRun(registry, store), /dataset empty after snapshot guards/);

    const dir = store.dir;
    await store.close();
    const reopened = await ArticleStore.open(dir);
    assert.equal(reopened.getStats().retired, 3, "retirement replays from the log");
    assert.equal(reopened.getStats().trainable, 0);
    await reopened.close();
  } finally {
    config.jobs.training.maxRejectedRetries = prev;
    await registry.close();
  }
});

test("re-driving the same rejected run does not inflate the retry count", async () => {
  const store = await seededStore();
  const ids = store.articlesPage({ limit: 50 }).items.map((a) => a.articleId);

  const first = await store.deferArticles(ids, { runId: "run-1", reason: "rejected", maxRetries: 2 });
  assert.equal(first.deferred.length, 3);
  const again = await store.deferArticles(ids, { runId: "run-1", reason: "rejected", maxRetries: 2 });
  assert.equal(again.deferred.length, 0, "the same run is idempotent");
  assert.equal(again.skipped.length, 3);
  for (const a of store.articlesPage({ limit: 50 }).items) assert.equal(a.deferralRetries, 1);

  // A DIFFERENT run is a genuine second attempt, and exhausts the budget.
  const next = await store.deferArticles(ids, { runId: "run-2", reason: "rejected", maxRetries: 2 });
  assert.equal(next.retired.length, 3);
  // A retired article is never deferred again.
  const after = await store.deferArticles(ids, { runId: "run-3", reason: "rejected", maxRetries: 2 });
  assert.deepEqual(after.deferred, []);
  assert.deepEqual(after.retired, []);
  await store.close();
});

test("a promoted run clears the deferral state of the batch it consumed", async () => {
  const registry = await RegistryStore.open(tmp());
  const store = await seededStore();

  await rejectedRun(registry, store);
  for (const a of store.articlesPage({ limit: 50 }).items) assert.equal(a.deferralRetries, 1);

  const promoted = await executeFullRun({
    registry,
    options: { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } },
    deps: { store, trainer: stubTrainer(), complete: exactComplete, evalSeed: async () => EVAL_SEED },
  });
  assert.equal(promoted.decision.decision, "promoted");
  assert.equal(store.getStats().uniqueConsumed, 3);

  const dir = store.dir;
  await store.close();
  const reopened = await ArticleStore.open(dir);
  for (const a of reopened.articlesPage({ limit: 50 }).items) {
    assert.equal(a.deferralRetries, 0, "the clearing is durable, not in-memory");
    assert.equal(a.deferredRunId, null);
    assert.equal(a.deferredReason, null);
  }
  await reopened.close();
  await registry.close();
});

test("an undersized frozen eval set warns on the run record without gating promotion", async () => {
  const prev = config.evalMinDocuments;
  config.evalMinDocuments = 5; // EVAL_SEED holds 2
  const registry = await RegistryStore.open(tmp());
  const store = await seededStore();
  try {
    const out = await executeFullRun({
      registry,
      options: { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } },
      deps: { store, trainer: stubTrainer(), complete: exactComplete, evalSeed: async () => EVAL_SEED },
    });
    // Advisory ONLY: the loss/score gate still decided, and it promoted.
    assert.equal(out.decision.decision, "promoted");
    assert.equal(out.run.status, "promoted");
    assert.equal(out.run.evaluationSetSize, 2);
    assert.equal(out.run.evaluationWarnings.length, 1);
    assert.equal(out.run.evaluationWarnings[0].code, "eval-set-undersized");
    assert.equal(out.run.evaluationWarnings[0].severity, "advisory");
    assert.equal(out.run.evaluationWarnings[0].minDocuments, 5);
  } finally {
    config.evalMinDocuments = prev;
    await store.close();
    await registry.close();
  }
});

test("the advisory floor is off by default, so a small eval set warns about nothing", async () => {
  const registry = await RegistryStore.open(tmp());
  const store = await seededStore();
  const out = await executeFullRun({
    registry,
    options: { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } },
    deps: { store, trainer: stubTrainer(), complete: exactComplete, evalSeed: async () => EVAL_SEED },
  });
  assert.equal(config.evalMinDocuments, 0);
  assert.deepEqual(out.run.evaluationWarnings, []);
  await store.close();
  await registry.close();
});

// ---------------------------------------------------------------------------
// Corpus backfill (SNAPSHOT_INCLUDE_CONSUMED): retained rows are trained on but
// are never treated as fresh input.
// ---------------------------------------------------------------------------

test("a rejected run defers only fresh rows when the snapshot backfills consumed ones", async () => {
  const registry = await RegistryStore.open(tmp());
  const store = await ArticleStore.open(tmp());
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const a = await store.ingestArticle({ text: `Retained corpus article number ${i} with enough prose to review.`, domain: "reasoning" });
    await store.recordReview({ articleId: a.articleId, verdict: "approve", authority: "human" });
    ids.push(a.articleId);
  }
  const retained = ids.slice(0, 3);
  const freshId = ids[3];
  await store.markConsumed(retained, { runId: "run_old" });

  const prevInclude = config.snapshotIncludeConsumed;
  config.snapshotIncludeConsumed = true;
  try {
    const out = await executeFullRun({
      registry,
      options: { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } },
      deps: { store, trainer: stubTrainer(), complete: regressingComplete(), evalSeed: async () => EVAL_SEED },
    });

    assert.equal(out.decision.decision, "rejected");
    // The fresh article absorbed the deferral...
    assert.ok((store.getArticle(freshId).deferralRetries ?? 0) >= 1, "fresh row must be deferred");
    // ...the retained, already-consumed articles must be untouched.
    for (const id of retained) {
      const a = store.getArticle(id);
      assert.equal(a.deferralRetries ?? 0, 0, `retained ${id} must not be re-deferred`);
      assert.equal(a.consumedRef, "run_old", `retained ${id} consumption must be unchanged`);
      assert.equal(a.status, "REVIEWED", `retained ${id} must not be retired`);
    }
  } finally {
    config.snapshotIncludeConsumed = prevInclude;
    await store.close();
    await registry.close();
  }
});

test("an incremental run is refused when backfill yields no fresh material", async () => {
  const registry = await RegistryStore.open(tmp());
  const store = await ArticleStore.open(tmp());
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const a = await store.ingestArticle({ text: `Only-retained corpus article number ${i} with enough prose.`, domain: "reasoning" });
    await store.recordReview({ articleId: a.articleId, verdict: "approve", authority: "human" });
    ids.push(a.articleId);
  }
  // Consume everything so only retained rows remain.
  await store.markConsumed(ids, { runId: "run_old" });

  const prevInclude = config.snapshotIncludeConsumed;
  config.snapshotIncludeConsumed = true;
  try {
    await assert.rejects(
      executeFullRun({
        registry,
        options: { paths: { snapshots: tmp(), models: tmp(), plans: tmp(), evaluation: tmp() } },
        deps: { store, trainer: stubTrainer(), complete: exactComplete, evalSeed: async () => EVAL_SEED },
      }),
      (err) => err.code === "NO_ELIGIBLE_MATERIAL",
    );
  } finally {
    config.snapshotIncludeConsumed = prevInclude;
    await store.close();
    await registry.close();
  }
});
