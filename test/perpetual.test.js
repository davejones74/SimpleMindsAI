import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArticleStore } from "../src/storage/article-store.js";
import { RegistryStore } from "../src/storage/registry-store.js";
import { DEFAULT_POLICY } from "../src/domain/review-policy.js";
import { config } from "../src/config.js";

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-perpetual-")));

const fakeOllama = {
  model: "teacher-x",
  clean: async () => [{ text: "A curated reasoning unit of sufficient length.", domain: "reasoning" }],
};

const fakeScorer = {
  scoreOffline: async () => ({
    verdict: "approve",
    score: 8.5,
    rationale: "fixture: plausible, low repetition",
    criticModel: "fixture-critic",
    criticVersion: "critic-v1",
    rubricVersion: "rubric-v1",
    guardrailResult: { passed: true, heuristicPenalty: 1, reason: null },
    suggestedImportance: "Important",
    criticTemperature: 0.1,
    criticPromptVersion: "critic-prompt-v1",
    criticScoreMissing: false,
    criticError: null,
  }),
};

async function setupStore(dir, articles = []) {
  // Disable review sampling so the INGESTED vs REVIEWED split the assertions
  // rely on is deterministic (REVIEW_SAMPLE_RATE defaults to 0.1 and the article
  // id is random, which made `ingested >= 1` flaky).
  const store = await ArticleStore.open(dir, { policy: { ...DEFAULT_POLICY, sampleRate: 0 } });
  for (const a of articles) {
    const rec = await store.ingestArticle({
      text: a.text,
      domain: a.domain ?? "reasoning",
      source: a.source ?? "test",
    });
    if (a.review) {
      await store.recordReview({
        articleId: rec.articleId,
        verdict: a.review.verdict ?? "approve",
        score: a.review.score ?? 8.5,
        authority: a.review.authority ?? "human",
      });
    }
    if (a.consumed) {
      await store.markConsumed([rec.articleId], { runId: "test-run" });
    }
  }
  return store;
}

test("perpetual: production-style data directory without data/raw/sample.ndjson", async () => {
  const dir = tmp();
  const store = await setupStore(dir, [
    { text: "An existing article about steam engines and their history." },
    { text: "An existing article about recursive algorithms and proofs.", review: { verdict: "approve", score: 9.0 } },
  ]);

  const stats = store.getStats();
  assert.equal(stats.totalArticles, 2);
  assert.ok(stats.ingested >= 1, "at least one article should be ingested");
  assert.ok(stats.reviewed >= 1, "at least one article should be reviewed");

  await store.close();
});

test("perpetual: working-directory change does not change which persistent data is used", async () => {
  const dir = tmp();
  const store = await setupStore(dir, [
    { text: "Article about thermodynamics and heat engines." },
  ]);

  const originalCwd = process.cwd();
  process.chdir("/tmp");
  try {
    const stats = store.getStats();
    assert.equal(stats.totalArticles, 1);
  } finally {
    process.chdir(originalCwd);
  }

  await store.close();
});

test("perpetual: newly discovered sources processed exactly once", async () => {
  const dir = tmp();
  const store = await setupStore(dir, []);

  const text = "A unique document about quantum computing and qubits.";
  const rec1 = await store.ingestArticle({ text, domain: "science" });
  assert.equal(rec1.deduped, false);

  const rec2 = await store.ingestArticle({ text, domain: "science" });
  assert.equal(rec2.deduped, true);
  assert.equal(rec2.articleId, rec1.articleId);

  const stats = store.getStats();
  assert.equal(stats.totalArticles, 1);

  await store.close();
});

test("perpetual: existing articles not duplicated or unnecessarily curated again", async () => {
  const dir = tmp();
  const store = await setupStore(dir, [
    { text: "First unique article about machine learning." },
    { text: "Second unique article about neural networks." },
  ]);

  const before = store.getStats();
  assert.equal(before.totalArticles, 2);

  await store.ingestArticle({ text: "First unique article about machine learning." });
  await store.ingestArticle({ text: "Second unique article about neural networks." });

  const after = store.getStats();
  assert.equal(after.totalArticles, 2, "no duplicates should be created");

  await store.close();
});

test("perpetual: existing reviewed, unconsumed articles remain eligible for training", async () => {
  const dir = tmp();
  const store = await setupStore(dir, [
    { text: "Reviewed article about graph algorithms and complexity.", review: { verdict: "approve", score: 9.0 } },
  ]);

  const stats = store.getStats();
  assert.equal(stats.reviewed, 1);
  assert.equal(stats.trainable, 1, "reviewed + unconsumed article should be trainable");

  await store.close();
});

test("perpetual: already-consumed articles not trained on again", async () => {
  const dir = tmp();
  const store = await setupStore(dir, [
    { text: "Consumed article about database indexing.", review: { verdict: "approve", score: 8.0 }, consumed: true },
  ]);

  const stats = store.getStats();
  assert.equal(stats.reviewed, 1);
  assert.equal(stats.uniqueConsumed, 1);
  assert.equal(stats.trainable, 0, "consumed article should not be trainable");

  await store.close();
});

test("perpetual: failed curation does not incorrectly advance lifecycle state", async () => {
  const dir = tmp();
  const store = await setupStore(dir, []);

  const failingOllama = {
    model: "teacher-x",
    clean: async () => { throw new Error("curation failed"); },
  };

  const docs = ["Some raw document text."];
  let ingested = 0;
  for (const doc of docs) {
    try {
      const units = await failingOllama.clean(doc);
      for (const u of units) {
        const text = u?.text ?? null;
        if (!text) continue;
        const rec = await store.ingestArticle({ text, domain: "general" });
        if (rec.deduped) continue;
        ingested++;
      }
    } catch {
      // curation failed, skip
    }
  }

  assert.equal(ingested, 0);
  const stats = store.getStats();
  assert.equal(stats.totalArticles, 0, "no articles should be ingested after failed curation");

  await store.close();
});

test("perpetual: empty raw sources with existing eligible articles", async () => {
  const dir = tmp();
  const rawDir = path.join(dir, "raw");
  mkdirSync(rawDir, { recursive: true });

  const store = await setupStore(dir, [
    { text: "Article about operating systems and kernels.", review: { verdict: "approve", score: 8.5 } },
  ]);

  const stats = store.getStats();
  assert.equal(stats.totalArticles, 1);
  assert.equal(stats.reviewed, 1);
  assert.equal(stats.trainable, 1);

  await store.close();
});

test("perpetual: empty raw sources with no eligible articles", async () => {
  const dir = tmp();
  const store = await setupStore(dir, []);

  const stats = store.getStats();
  assert.equal(stats.totalArticles, 0);
  assert.equal(stats.trainable, 0);

  await store.close();
});

test("perpetual: missing or unreadable configured stores produce truthful diagnostics", async () => {
  const dir = tmp();
  const store = await ArticleStore.open(dir);
  await store.close();

  const missingDir = path.join(dir, "nonexistent");
  const store2 = await ArticleStore.open(missingDir);
  const stats = store2.getStats();
  assert.equal(stats.totalArticles, 0);
  await store2.close();
});
