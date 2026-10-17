import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArticleStore } from "../src/storage/article-store.js";
import { STATUS } from "../src/domain/article.js";
import { reviewPendingArticles } from "../src/jobs/review-pass.js";
import { acquireReviewLock } from "../src/jobs/review-lock.js";

/**
 * Bounded autonomous review. The production defect was a 331-article
 * PENDING_REVIEW backlog that was re-scored on every cycle forever: uncertain
 * verdicts never changed status, so nothing ever left the queue. These tests pin
 * the fix — cooldowns, attempt caps, an auditable RETIRE, human override, and
 * per-article isolation — plus the cross-process review lock.
 */

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-review-")));

const uncertainScorer = { scoreOffline: async () => ({ verdict: "uncertain", score: 0, rationale: "meh" }) };
const approveScorer = { scoreOffline: async () => ({ verdict: "approve", score: 9, rationale: "useful" }) };

async function pending(store, text) {
  const a = await store.ingestArticle({ text, domain: "reasoning", reviewRequested: true });
  return a.articleId;
}

const cfg = (over = {}) => ({
  review: { cooldownMs: 0, maxAttempts: 3, maxTechnicalAttempts: 5, lockStaleMs: 600_000, ...over },
});

test("reviewAttempts: counts inconclusive verdicts and enforces cooldown + cap", async () => {
  const store = await ArticleStore.open(tmp());
  const id = await pending(store, "A reasoning article of sufficient length.");

  let s = store.reviewAttempts(id, { cooldownMs: 1000, maxAttempts: 2, maxTechnicalAttempts: 2 });
  assert.equal(s.pending, true);
  assert.equal(s.inconclusiveAttempts, 0);
  assert.equal(s.eligible, true);

  await store.recordReview({ articleId: id, verdict: "uncertain", authority: "teacher", score: 0 });

  s = store.reviewAttempts(id, { cooldownMs: 100_000, maxAttempts: 2, maxTechnicalAttempts: 2 });
  assert.equal(s.inconclusiveAttempts, 1);
  assert.equal(s.inCooldown, true);
  assert.equal(s.eligible, false, "a cooldown must block an immediate re-attempt");

  // No cooldown: eligible again, until the cap is reached.
  await store.recordReview({ articleId: id, verdict: "uncertain", authority: "teacher", score: 0 });
  s = store.reviewAttempts(id, { cooldownMs: 0, maxAttempts: 2, maxTechnicalAttempts: 2 });
  assert.equal(s.inconclusiveAttempts, 2);
  assert.equal(s.capReached, true);
  assert.equal(s.eligible, false, "the cap must make the article ineligible");

  await store.close();
});

test("reviewAttempts: technical critic failures do NOT consume the inconclusive allowance", async () => {
  const store = await ArticleStore.open(tmp());
  const id = await pending(store, "An article whose critic keeps timing out here.");

  for (let i = 0; i < 2; i++) {
    await store.recordReview({
      articleId: id,
      verdict: "uncertain",
      authority: "teacher",
      criticScoreMissing: true,
      criticError: "critic unavailable: timeout",
    });
  }

  let s = store.reviewAttempts(id, { cooldownMs: 0, maxAttempts: 2, maxTechnicalAttempts: 5 });
  assert.equal(s.technicalAttempts, 2);
  assert.equal(s.inconclusiveAttempts, 0, "a technical failure is not a judgement");
  assert.equal(s.capReached, false);
  assert.equal(s.eligible, true, "the article must remain reviewable after transient critic faults");

  s = store.reviewAttempts(id, { cooldownMs: 0, maxAttempts: 2, maxTechnicalAttempts: 2 });
  assert.equal(s.technicalCapReached, true);
  assert.equal(s.eligible, false, "technical retries are bounded too");

  await store.close();
});

test("retireArticle: auditable, terminal and idempotent", async () => {
  const store = await ArticleStore.open(tmp());
  const id = await pending(store, "An article that should be retired after review.");

  const r = await store.retireArticle(id, { reason: "test retire", attempts: 3 });
  assert.equal(r.retired, true);
  assert.equal(store.getArticle(id).status, STATUS.RETIRED);

  const events = store.events.filter((e) => e.articleId === id);
  assert.ok(events.some((e) => e.type === "review-retired" && e.attempts === 3), "an explicit marker records the attempt count");
  assert.ok(events.some((e) => e.type === "status" && e.to === STATUS.RETIRED), "the status transition is logged");

  const again = await store.retireArticle(id, {});
  assert.equal(again.alreadyRetired, true);
  assert.equal(store.events.filter((e) => e.articleId === id).length, events.length, "retiring twice must not append more events");

  await store.close();
});

test("review pass: retires an article after maxAttempts inconclusive verdicts", async () => {
  const store = await ArticleStore.open(tmp());
  const id = await pending(store, "A borderline article the teacher cannot decide on.");

  await reviewPendingArticles(store, uncertainScorer, { config: cfg({ maxAttempts: 2 }), select: false });
  assert.equal(store.getArticle(id).status, STATUS.PENDING_REVIEW, "one inconclusive verdict is not enough");
  assert.equal(store.reviewAttempts(id, { maxAttempts: 2 }).inconclusiveAttempts, 1);

  await reviewPendingArticles(store, uncertainScorer, { config: cfg({ maxAttempts: 2 }), select: false });
  assert.equal(store.getArticle(id).status, STATUS.RETIRED, "the cap retires the article instead of re-scoring forever");

  await store.close();
});

test("review pass: cooldown defers a just-reviewed article and reports it as cooling", async () => {
  const store = await ArticleStore.open(tmp());
  await pending(store, "A marginal article that should not hot-loop the critic.");

  const first = await reviewPendingArticles(store, uncertainScorer, { config: cfg({ cooldownMs: 100_000, maxAttempts: 5 }), select: false });
  assert.equal(first.reviewed, 1);

  const second = await reviewPendingArticles(store, uncertainScorer, { config: cfg({ cooldownMs: 100_000, maxAttempts: 5 }), select: false });
  assert.equal(second.reviewed, 0);
  assert.equal(second.skippedCooldown, 1, "a cooling article is reported separately from an empty queue");
  assert.equal(second.waiting, true, "a cooldown-only pass is a temporary wait, not a stall");

  await store.close();
});

test("review pass: a human override reopens a retired article and bypasses the cooldown", async () => {
  const store = await ArticleStore.open(tmp());
  const id = await pending(store, "An article the operator wants re-reviewed by hand.");

  await reviewPendingArticles(store, uncertainScorer, { config: cfg({ maxAttempts: 1 }), select: false });
  assert.equal(store.getArticle(id).status, STATUS.RETIRED);

  await store.requestReview(id, { reason: "operator override" });
  assert.equal(store.getArticle(id).status, STATUS.PENDING_REVIEW, "an explicit human request reopens a retired article");

  const s = store.reviewAttempts(id, { cooldownMs: 100_000, maxAttempts: 1, maxTechnicalAttempts: 1 });
  assert.equal(s.overridePending, true);
  assert.equal(s.eligible, true, "the override bypasses cooldown and resets the attempt baseline");

  await store.close();
});

test("review pass: one article's failure is isolated and never aborts the pass", async () => {
  const store = await ArticleStore.open(tmp());
  await pending(store, "GOOD article that the critic can judge fine.");
  await pending(store, "BAD article that makes the critic throw an error.");

  const scorer = {
    scoreOffline: async ({ text }) => {
      if (String(text).includes("BAD")) throw new Error("critic exploded");
      return { verdict: "approve", score: 9 };
    },
  };
  const result = await reviewPendingArticles(store, scorer, { config: cfg(), select: false });
  assert.equal(result.failed, 1);
  assert.equal(result.reviewed, 1);
  assert.equal(store.getStats().reviewed, 1, "the healthy article still reached REVIEWED");

  await store.close();
});

test("review pass: paginates through the whole backlog (more than one page)", async () => {
  const store = await ArticleStore.open(tmp());
  for (let i = 0; i < 5; i++) await pending(store, `Distinct drained article number ${i} with reasoning prose.`);

  const result = await reviewPendingArticles(store, approveScorer, { config: cfg(), select: false, pageSize: 2 });
  assert.equal(result.reviewed, 5, "every pending article must be seen, not just the first page");
  assert.equal(store.getStats().reviewed, 5);

  await store.close();
});

test("review pass: yields cleanly when another worker holds REVIEW.lock", async () => {
  const dir = tmp();
  const store = await ArticleStore.open(dir);
  await pending(store, "An article that another worker is already reviewing.");

  const lock = acquireReviewLock(dir, { staleMs: 600_000 });
  assert.ok(lock, "the test must hold the lock");
  try {
    const result = await reviewPendingArticles(store, approveScorer, { config: cfg(), select: false });
    assert.equal(result.locked, true);
    assert.equal(result.reviewed, 0);
  } finally {
    lock.release();
  }

  await store.close();
});
