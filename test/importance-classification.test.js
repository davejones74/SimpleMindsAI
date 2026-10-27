import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArticleStore } from "../src/storage/article-store.js";
import { isReplayPool, isTrainable } from "../src/domain/article.js";

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-imp-")));

async function ingest(store, i = 0) {
  return store.ingestArticle({
    text: `Article ${i} about the industrial revolution and steam power, with substantive prose.`,
    domain: "history",
  });
}

// The critic/teacher result is applied to canonical importance automatically.
// Approval (verdict) is deliberately irrelevant to the classification itself.
async function reviewWith(store, articleId, suggestedImportance, { verdict = "approve", score = 8, authority = "teacher" } = {}) {
  return store.recordReview({ articleId, verdict, score, authority, suggestedImportance });
}

test("Important, Critical and Normal suggestions are applied automatically to unclassified articles", async () => {
  for (const imp of ["Important", "Critical", "Normal"]) {
    const store = await ArticleStore.open(tmp());
    const a = await ingest(store);
    await reviewWith(store, a.articleId, imp);
    const art = store.getArticle(a.articleId);
    assert.equal(art.importance, imp, "canonical importance is the structured suggestion");
    assert.equal(art.importanceSource, "teacher", "source is teacher-assigned, not default/operator");
    assert.equal(art.importanceDecidedBy, "teacher", "decision authority is recorded");
    assert.ok(art.importanceReviewId, "the originating review is linked");
    assert.equal(art.suggestedImportance, imp, "the suggestion is preserved as evidence");
    const rev = store.reviewsFor(a.articleId).at(-1);
    assert.equal(rev.suggestedImportance, imp, "review record keeps the suggestion");
    assert.equal(rev.importanceApplied, true);
    assert.equal(rev.resultingImportance, imp);
    await store.close();
  }
});

test("null or invalid suggestions never invent a classification", async () => {
  const store = await ArticleStore.open(tmp());
  const a = await ingest(store);
  await reviewWith(store, a.articleId, null);
  let art = store.getArticle(a.articleId);
  assert.equal(art.importance, "Normal");
  assert.equal(art.importanceSource, "default");
  assert.equal(art.importanceDecidedBy, null);

  await reviewWith(store, a.articleId, "URGENT");
  art = store.getArticle(a.articleId);
  assert.equal(art.importance, "Normal", "an invalid enum is ignored, not coerced");
  assert.equal(art.importanceSource, "default");
  assert.equal(art.suggestedImportance, null, "invalid value is not stored as evidence");
  await store.close();
});

test("an automated classification survives event replay on reopen", async () => {
  const store = await ArticleStore.open(tmp());
  const a = await ingest(store);
  await reviewWith(store, a.articleId, "Critical");
  const dir = store.dir;
  await store.close();

  const reopened = await ArticleStore.open(dir);
  const art = reopened.getArticle(a.articleId);
  assert.equal(art.importance, "Critical");
  assert.equal(art.importanceSource, "teacher");
  assert.equal(art.importanceDecidedBy, "teacher");
  assert.ok(art.importanceReviewId);
  assert.equal(art.suggestedImportance, "Critical");
  await reopened.close();
});

test("operator-set importance is never overwritten by automated classification", async () => {
  // Operator sets importance BEFORE any review.
  const store = await ArticleStore.open(tmp());
  const a = await ingest(store);
  await store.setImportance(a.articleId, "Important");
  await reviewWith(store, a.articleId, "Critical");
  let art = store.getArticle(a.articleId);
  assert.equal(art.importance, "Important", "operator value wins");
  assert.equal(art.importanceSource, "operator");

  // Operator overrides an existing automated classification.
  const b = await ingest(store, 1);
  await reviewWith(store, b.articleId, "Important");
  await store.setImportance(b.articleId, "Critical");
  await reviewWith(store, b.articleId, "Normal");
  art = store.getArticle(b.articleId);
  assert.equal(art.importance, "Critical", "later automation cannot overwrite the operator");
  assert.equal(art.importanceSource, "operator");
  await store.close();
});

test("subsequent reviews do not change decision authority or overwrite the initial classification", async () => {
  const store = await ArticleStore.open(tmp());
  const a = await ingest(store);
  await reviewWith(store, a.articleId, "Important");

  // A later teacher review with a different suggestion must not reclassify.
  await reviewWith(store, a.articleId, "Critical");
  let art = store.getArticle(a.articleId);
  assert.equal(art.importance, "Important", "initial automated classification is stable");
  assert.equal(art.importanceSource, "teacher");
  assert.equal(art.importanceDecidedBy, "teacher");

  // A later HUMAN review must not silently promote the automation classification
  // to a human decision (only an explicit operator override does that).
  await reviewWith(store, a.articleId, "Critical", { authority: "human" });
  art = store.getArticle(a.articleId);
  assert.equal(art.importance, "Important");
  assert.equal(art.importanceSource, "teacher", "authority is not silently flipped to human");
  assert.equal(art.importanceDecidedBy, "teacher");
  await store.close();
});

test("dashboard counts reflect canonical importance and expose classification source", async () => {
  const store = await ArticleStore.open(tmp());
  const a = await ingest(store, 0);
  const b = await ingest(store, 1);
  const c = await ingest(store, 2);
  await reviewWith(store, a.articleId, "Important");
  await reviewWith(store, b.articleId, "Critical");
  await reviewWith(store, c.articleId, "Normal");
  // An operator-owned article whose suggestion was NOT applied.
  const d = await ingest(store, 3);
  await store.setImportance(d.articleId, "Normal");

  const st = store.getStats();
  assert.equal(st.byImportance.Important, 1);
  assert.equal(st.byImportance.Critical, 1);
  assert.equal(st.byImportance.Normal, 2, "canonical Normal includes the operator-owned article");
  assert.equal(st.byImportanceSource.teacher, 3);
  assert.equal(st.byImportanceSource.operator, 1);
  assert.equal(st.byImportanceSource.default, 0);
  await store.close();
});

test("classification does not change trainability, review attempts or replay eligibility", async () => {
  const store = await ArticleStore.open(tmp());
  const a = await ingest(store);
  await reviewWith(store, a.articleId, "Critical");

  let art = store.getArticle(a.articleId);
  assert.equal(art.status, "REVIEWED");
  assert.equal(isTrainable(art), true, "importance does not affect trainability");
  assert.equal(isReplayPool(art), false, "importance does not affect replay-pool eligibility");

  const before = store.reviewAttempts(a.articleId, {});
  await store.setImportance(a.articleId, "Normal");
  const after = store.reviewAttempts(a.articleId, {});
  assert.equal(after.inconclusiveAttempts, before.inconclusiveAttempts, "importance does not affect retry counts");
  assert.equal(after.conclusiveAttempts, before.conclusiveAttempts);

  art = store.getArticle(a.articleId);
  assert.equal(isTrainable(art), true, "still trainable after an importance change");
  await store.close();
});

test("classification is independent of approval: a rejected article can be classified but is not trainable", async () => {
  const store = await ArticleStore.open(tmp());
  const a = await ingest(store);
  // Teacher rejects (score 0 => REJECT) but still supplies a structured importance.
  await reviewWith(store, a.articleId, "Important", { verdict: "reject", score: 0 });
  const art = store.getArticle(a.articleId);
  assert.equal(art.importance, "Important", "classification uses importance, not the verdict");
  assert.equal(art.status, "REJECTED");
  assert.equal(isTrainable(art), false, "a rejected article is not trainable regardless of importance");
  await store.close();
});
