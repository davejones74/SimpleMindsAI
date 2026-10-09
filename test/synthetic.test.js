import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArticleStore } from "../src/storage/article-store.js";
import { maybeCaptureSynthetic } from "../src/chat/synthetic-feedback.js";

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-")));

test("disabled => never captures", async () => {
  const store = await ArticleStore.open(tmp());
  const res = await maybeCaptureSynthetic({
    promptText: "hi", replyText: "hello there", model: "m", store,
    enabled: false, scoreFn: async () => ({ score: 9.9 }),
  });
  assert.equal(res.captured, false);
  assert.match(res.reason, /disabled/);
  assert.equal(store.getStats().totalArticles, 0);
  await store.close();
});

test("high-confidence reply is captured as origin=synthetic with provenance", async () => {
  const store = await ArticleStore.open(tmp());
  const res = await maybeCaptureSynthetic({
    promptText: "What is the capital of France?",
    replyText: "Paris is the capital of France and a major European city.",
    model: "deepseek-r1:latest",
    store,
    enabled: true,
    minScore: 8,
    scoreFn: async () => ({ score: 9.2, rationale: "accurate", penalty: 0.9 }),
  });
  assert.equal(res.captured, true);
  assert.equal(res.origin, "synthetic");

  const { items } = store.articlesPage({ limit: 10 });
  assert.equal(items.length, 1);
  assert.equal(items[0].origin, "synthetic");
  assert.equal(items[0].model, "deepseek-r1:latest");
  const reviews = store.reviewsFor(items[0].articleId);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].score, 9.2);
  await store.close();
});

test("low score or critic failure => not captured", async () => {
  const store = await ArticleStore.open(tmp());
  const low = await maybeCaptureSynthetic({
    promptText: "x", replyText: "y", model: "m", store, enabled: true,
    scoreFn: async () => ({ score: 3.1 }),
  });
  assert.equal(low.captured, false);

  const err = await maybeCaptureSynthetic({
    promptText: "x", replyText: "y", model: "m", store, enabled: true,
    scoreFn: async () => { throw new Error("critic down"); },
  });
  assert.equal(err.captured, false);
  assert.match(err.reason, /critic unavailable/);
  assert.equal(store.getStats().totalArticles, 0);
  await store.close();
});
