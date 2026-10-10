import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArticleStore } from "../src/storage/article-store.js";

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-store-")));

test("ingest dedupes by content hash and never double-registers", async () => {
  const store = await ArticleStore.open(tmp());
  const a = await store.ingestArticle({ text: "Some uniquely worded article body.", domain: "general" });
  const b = await store.ingestArticle({ text: "Some uniquely worded article body.", domain: "general" });
  assert.equal(b.deduped, true);
  assert.equal(b.articleId, a.articleId);
  assert.equal(store.getStats().totalArticles, 1);
  await store.close();
});

test("human review is final; a low-confidence teacher approve does not apply", async () => {
  const store = await ArticleStore.open(tmp());
  const a = await store.ingestArticle({ text: "A howto article with enough prose to keep.", domain: "howto" });
  await store.requestReview(a.articleId);

  const low = await store.recordReview({ articleId: a.articleId, verdict: "approve", score: 2, authority: "teacher" });
  assert.equal(low.applied, false);
  assert.equal(store.getArticle(a.articleId).status, "PENDING_REVIEW");

  await store.recordReview({ articleId: a.articleId, verdict: "reject", authority: "human" });
  assert.equal(store.getArticle(a.articleId).status, "REJECTED");

  const afterHuman = await store.recordReview({ articleId: a.articleId, verdict: "approve", score: 10, authority: "teacher" });
  assert.equal(afterHuman.applied, false);
  assert.equal(store.getArticle(a.articleId).status, "REJECTED");
  await store.close();
});

test("consumption is exactly-once; allowReuse records a re-appearance", async () => {
  const store = await ArticleStore.open(tmp());
  const a = await store.ingestArticle({ text: "An article destined for the consumption ledger.", domain: "general" });
  await store.recordReview({ articleId: a.articleId, verdict: "approve", authority: "human" });

  const first = await store.markConsumed([a.articleId], { runId: "run-1" });
  assert.equal(first.consumed.length, 1);

  const second = await store.markConsumed([a.articleId], { runId: "run-2" });
  assert.equal(second.consumed.length, 0);
  assert.equal(second.skipped[0].reason, "already-consumed");

  const reuse = await store.markConsumed([a.articleId], { runId: "run-3", allowReuse: true });
  assert.equal(reuse.consumed.length, 1);
  assert.equal(reuse.consumed[0].reused, true);

  const stats = store.getStats();
  assert.equal(stats.uniqueConsumed, 1);
  assert.equal(stats.totalAppearances, 2);
  await store.close();
});

test("source→curated provenance is persisted and survives reopen", async () => {
  const dir = tmp();
  const store = await ArticleStore.open(dir);
  const a = await store.ingestArticle({
    text: "Curated text the teacher produced from a fetched page.",
    domain: "history",
    source: "en.wikipedia.org",
    model: "teacher-model:v1",
    rawText: "ORIGINAL fetched page text, unmodified.",
    sourceUrl: "https://en.wikipedia.org/wiki/Steam_engine",
    fetchedContentHash: "f".repeat(64),
    fetchedAt: "2026-10-10T00:00:00.000Z",
  });
  assert.equal(a.sourceUrl, "https://en.wikipedia.org/wiki/Steam_engine");
  assert.equal(a.fetchedContentHash, "f".repeat(64));
  assert.equal(a.rawText, "ORIGINAL fetched page text, unmodified.");
  assert.equal(a.model, "teacher-model:v1");
  // The curated text has its own identity, different from the fetched original.
  assert.notEqual(a.contentHash, a.fetchedContentHash);
  await store.close();

  const reopened = await ArticleStore.open(dir);
  const r = reopened.getArticle(a.articleId);
  assert.equal(r.sourceUrl, "https://en.wikipedia.org/wiki/Steam_engine");
  assert.equal(r.fetchedContentHash, "f".repeat(64));
  assert.equal(r.rawText, "ORIGINAL fetched page text, unmodified.");
  await reopened.close();
});

test("articles ingested without provenance omit those fields (back-compat)", async () => {
  const store = await ArticleStore.open(tmp());
  const a = await store.ingestArticle({ text: "Plain article with no fetch provenance.", domain: "general" });
  assert.equal("sourceUrl" in a, false);
  assert.equal("fetchedContentHash" in a, false);
  await store.close();
});

test("purgeBuffer wipes transient articles but keeps the durable consumption ledger", async () => {
  const dir = tmp();
  const store = await ArticleStore.open(dir);
  const a = await store.ingestArticle({ text: "Durable consumption article with prose.", domain: "general" });
  await store.recordReview({ articleId: a.articleId, verdict: "approve", authority: "human" });
  await store.markConsumed([a.articleId], { runId: "run-1" });

  await store.purgeBuffer();
  assert.equal(store.getStats().totalArticles, 0);
  assert.equal(store.getStats().totalAppearances, 1);
  await store.close();

  const reopened = await ArticleStore.open(dir);
  assert.equal(reopened.getStats().totalArticles, 0);
  assert.equal(reopened.getStats().uniqueConsumed, 1);
  await reopened.close();
});
