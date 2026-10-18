import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArticleStore } from "../src/storage/article-store.js";
import { STATUS, STATUSES } from "../src/domain/article.js";
import { reviewPendingArticles } from "../src/jobs/review-pass.js";

/**
 * Phase 1 — bounded review at the source.
 *
 * The production defect (D5) was that the perpetual CLI ran its OWN inline
 * scoring loop that ignored cooldowns and attempt caps: a single article was
 * re-scored 20+ times, always `uncertain`, and never left PENDING_REVIEW. These
 * tests pin the guarantees the shared pass must provide everywhere:
 *   - a retired article is unreachable by ordinary scheduling,
 *   - counters are rebuilt from durable history, so they survive a restart,
 *   - a critic that throws is recorded as a TECHNICAL failure and bounded out,
 *   - the projected status is exactly what the event log says it is,
 *   - the API's status enum can represent every status the ledger can project.
 */

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-lifecycle-")));
const cfg = (over = {}) => ({
  review: { cooldownMs: 0, maxAttempts: 3, maxTechnicalAttempts: 5, lockStaleMs: 600_000, ...over },
});

const uncertainScorer = { scoreOffline: async () => ({ verdict: "uncertain", score: 0, rationale: "meh" }) };
const approveScorer = { scoreOffline: async () => ({ verdict: "approve", score: 9, rationale: "useful" }) };

async function pending(store, text) {
  const a = await store.ingestArticle({ text, domain: "reasoning", reviewRequested: true });
  return a.articleId;
}

test("retired article is NOT reachable by ordinary scheduling and is not re-scored", async () => {
  const store = await ArticleStore.open(tmp());
  const id = await pending(store, "A borderline article the teacher cannot decide on.");

  await reviewPendingArticles(store, uncertainScorer, { config: cfg({ maxAttempts: 1 }), select: false });
  assert.equal(store.getArticle(id).status, STATUS.RETIRED);

  // Ordinary scheduling must never resurrect it: selection only promotes
  // INGESTED articles and the review queue only lists PENDING_REVIEW.
  const selected = await store.selectForReview({ limit: 500 });
  assert.deepEqual(selected, [], "selection must not pick up a retired article");
  assert.equal(store.reviewQueue({ limit: 100 }).items.length, 0, "a retired article is not in the review queue");

  // A fresh pass over the whole backlog must not touch it again.
  const again = await reviewPendingArticles(store, uncertainScorer, { config: cfg({ maxAttempts: 1 }), select: false });
  assert.equal(again.reviewed, 0);
  assert.equal(again.retired, 0, "an already-retired article is never retired (or scored) twice");

  assert.equal(store.getStats().trainable, 0, "a retired article is not trainable");

  await store.close();
});

test("cooldown + attempt counters are rebuilt from durable history across a restart", async () => {
  const dir = tmp();
  let store = await ArticleStore.open(dir);
  const id = await pending(store, "An article whose counters must survive a restart.");

  await store.recordReview({ articleId: id, verdict: "uncertain", authority: "teacher", score: 0 });
  await store.recordReview({
    articleId: id,
    verdict: "uncertain",
    authority: "teacher",
    criticScoreMissing: true,
    criticError: "critic unavailable: timeout",
  });

  const before = store.reviewAttempts(id, { cooldownMs: 1_000_000, maxAttempts: 3, maxTechnicalAttempts: 5 });
  assert.equal(before.inconclusiveAttempts, 1);
  assert.equal(before.technicalAttempts, 1);
  assert.equal(before.inCooldown, true);
  await store.close();

  // Reopen the SAME directory: no in-memory-only state may be lost.
  store = await ArticleStore.open(dir);
  const after = store.reviewAttempts(id, { cooldownMs: 1_000_000, maxAttempts: 3, maxTechnicalAttempts: 5 });
  assert.equal(after.inconclusiveAttempts, 1, "inconclusive attempts survive a restart");
  assert.equal(after.technicalAttempts, 1, "technical attempts survive a restart");
  assert.equal(after.inCooldown, true, "the cooldown survives a restart");

  await store.close();
});

test("a critic that throws is recorded as a technical failure and bounded out (no infinite loop)", async () => {
  const store = await ArticleStore.open(tmp());
  const id = await pending(store, "An article whose critic keeps exploding.");

  const throwing = { scoreOffline: async () => { throw new Error("socket hang up"); } };

  const first = await reviewPendingArticles(store, throwing, { config: cfg({ maxTechnicalAttempts: 2 }), select: false });
  assert.equal(store.getArticle(id).status, STATUS.PENDING_REVIEW, "one fault is not enough to retire");
  assert.equal(store.reviewAttempts(id, { maxTechnicalAttempts: 2 }).technicalAttempts, 1);
  assert.equal(first.failed, 1);

  await reviewPendingArticles(store, throwing, { config: cfg({ maxTechnicalAttempts: 2 }), select: false });
  assert.equal(store.getArticle(id).status, STATUS.RETIRED, "the bounded technical allowance retires instead of looping forever");

  await store.close();
});

test("projected status matches the event log, and every applied review is a logged transition", async () => {
  const dir = tmp();
  let store = await ArticleStore.open(dir);

  const approved = await store.ingestArticle({ text: "An approved article about engines.", domain: "history" });
  await store.recordReview({ articleId: approved.articleId, verdict: "approve", score: 9, authority: "teacher" });

  const rejected = await store.ingestArticle({ text: "A rejected article about nothing.", domain: "general" });
  await store.recordReview({ articleId: rejected.articleId, verdict: "reject", score: 1, authority: "teacher" });

  const retired = await pending(store, "A retired article the teacher cannot decide.");
  await store.retireArticle(retired, { reason: "test", attempts: 3 });

  const quarantined = await store.ingestArticle({ text: "A quarantined article about steam.", domain: "history" });
  await store.quarantineArticle(quarantined.articleId, { reason: "foreign-prose", detail: "ar" });
  await store.releaseQuarantine(quarantined.articleId);

  const assertConsistent = (s, label) => {
    // (a) status == the `to` of the article's last status event (creation
    // fallback), i.e. the projection IS the event log.
    for (const a of s.articles.values()) {
      const statusEvents = s.events.filter((e) => e.articleId === a.articleId && e.type === "status");
      const projected = statusEvents.length ? statusEvents[statusEvents.length - 1].to : a.status;
      assert.equal(a.status, projected, `${label}: status must equal the event projection for ${a.articleId}`);
    }
    // (b) every applied review has a matching status event within 2s.
    for (const reviewList of s.reviews.values()) {
      for (const r of reviewList) {
        if (r.applied !== true) continue;
        const ts = s.events.filter((e) => e.articleId === r.articleId && e.type === "status").map((e) => Date.parse(e.at));
        assert.ok(
          ts.some((t) => Math.abs(t - Date.parse(r.at)) < 2000),
          `${label}: an applied review must have a logged status transition (${r.articleId})`,
        );
      }
    }
  };

  assertConsistent(store, "live");
  await store.close();
  store = await ArticleStore.open(dir);
  assertConsistent(store, "after restart");

  await store.close();
});

test("the GraphQL ArticleStatus enum can represent every domain status (no drift)", () => {
  const schema = readFileSync(path.join(process.cwd(), "src/graphql/schema.graphql"), "utf8");
  const block = schema.slice(schema.indexOf("enum ArticleStatus"), schema.indexOf("enum ArticleStatus") + 400);
  for (const s of STATUSES) {
    assert.ok(block.includes(s), `ArticleStatus enum must include ${s}`);
  }
});
