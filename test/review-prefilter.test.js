import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { prefilterReview } from "../src/domain/review-prefilter.js";
import { reviewPendingArticles } from "../src/jobs/review-pass.js";
import { ArticleStore } from "../src/storage/article-store.js";
import { STATUS } from "../src/domain/article.js";

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-prefilter-")));
const cfg = (over = {}) => ({
  review: { cooldownMs: 0, maxAttempts: 3, maxTechnicalAttempts: 5, lockStaleMs: 600_000, ...over },
});
const approveAll = { scoreOffline: async () => ({ verdict: "approve", score: 9, rationale: "ok" }) };

test("prefilter rejects hard non-prose and below-floor text", () => {
  assert.equal(prefilterReview("", { mode: "enforce" }).decision, "reject");
  assert.equal(prefilterReview("A title only", { mode: "enforce" }).decision, "reject");
  assert.equal(prefilterReview("A short sentence about engines.", { mode: "enforce" }).decision, "reject");
  const long = "The steam engine converted thermal energy into mechanical work because pressure acted on a piston inside a cylinder. ".repeat(4);
  assert.equal(prefilterReview(long, { mode: "enforce" }).decision, "proceed");
});

test("shadow prefilter does not change the review outcome", async () => {
  const store = await ArticleStore.open(tmp());
  const a = await store.ingestArticle({ text: "A title only", domain: "general", reviewRequested: true });
  let calls = 0;
  const scorer = { scoreOffline: async () => { calls += 1; return { verdict: "approve", score: 9, rationale: "ok" }; } };
  const out = await reviewPendingArticles(store, scorer, {
    config: cfg({ prefilterMode: "shadow", gateContent: false }),
    select: false,
  });
  assert.equal(calls, 1, "shadow mode still sends the article to the critic");
  assert.equal(store.getArticle(a.articleId).status, STATUS.REVIEWED);
  assert.equal(out.prefilterShadow, 1);
  await store.close();
});

test("enforce prefilter rejects before the critic and records an auditable reason", async () => {
  const store = await ArticleStore.open(tmp());
  const a = await store.ingestArticle({ text: "A title only", domain: "general", reviewRequested: true });
  let calls = 0;
  const scorer = { scoreOffline: async () => { calls += 1; return { verdict: "approve", score: 9, rationale: "ok" }; } };
  const out = await reviewPendingArticles(store, scorer, {
    config: cfg({ prefilterMode: "enforce", prefilterMinChars: 200, prefilterMinWords: 20 }),
    select: false,
  });
  assert.equal(calls, 0, "enforced prefilter must not call the teacher");
  assert.equal(out.prefilterRejected, 1);
  assert.equal(store.getArticle(a.articleId).status, STATUS.REJECTED);
  const [review] = store.reviewsFor(a.articleId);
  assert.equal(review.gate, "prefilter");
  assert.equal(review.authority, "automation");
  await store.close();
});

test("enforce prefilter leaves healthy long prose trainable", async () => {
  const store = await ArticleStore.open(tmp());
  const text = "The steam engine converted thermal energy into mechanical work because pressure acted on a piston inside a cylinder, and the motion was then transferred to a wheel through a rod. ".repeat(3);
  const a = await store.ingestArticle({ text, domain: "general", reviewRequested: true });
  const out = await reviewPendingArticles(store, approveAll, {
    config: cfg({ prefilterMode: "enforce" }),
    select: false,
  });
  assert.equal(out.prefilterRejected, 0);
  assert.equal(store.getArticle(a.articleId).status, STATUS.REVIEWED);
  await store.close();
});
