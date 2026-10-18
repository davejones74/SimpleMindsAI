import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArticleStore } from "../src/storage/article-store.js";
import { STATUS } from "../src/domain/article.js";
import { reviewPendingArticles } from "../src/jobs/review-pass.js";

/**
 * P3 — the WHOLE review outcome, not just the prompt.
 *
 * The operator's requirement: verify both the decision AND the resulting
 * persisted article status. The store is opened with the ingest language filter
 * DISABLED so that foreign / corrupted text can be forced into the ledger
 * (simulating a curator or HTTP bypass); the review pass is then run with the
 * gate ON and a critic that approves EVERYTHING. If the gates work, the
 * unsuitable material is still not trainable.
 */

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-review-quality-")));

const LF_ON = { enabled: true, shadow: false, minConfidence: 0.8, unknownPolicy: "reject" };
const cfg = (over = {}) => ({
  languageFilter: LF_ON,
  review: { cooldownMs: 0, maxAttempts: 3, maxTechnicalAttempts: 5, lockStaleMs: 600_000, ...over },
});

// A critic that would approve anything — the gates must not rely on it.
const approveAll = { scoreOffline: async () => ({ verdict: "approve", score: 9.9, rationale: "looks great" }) };

async function pending(store, text, extra = {}) {
  const a = await store.ingestArticle({ text, domain: "general", reviewRequested: true, ...extra });
  return a.articleId;
}

async function openStore() {
  // Ingest filter OFF: this is the BYPASS we are defending against.
  return ArticleStore.open(tmp(), { languageFilter: { enabled: false } });
}

test("review gate rejects foreign-language text the critic would have approved", async () => {
  const store = await openStore();
  const id = await pending(
    store,
    "Le moteur à vapeur transformait l'énergie thermique en énergie mécanique, et il le faisait " +
      "parce que la pression était appliquée sur un piston à l'intérieur d'un cylindre. Quand la " +
      "valve s'ouvrait, la vapeur qui avait été chauffée dans la chaudière poussait le piston, et " +
      "le mouvement était ensuite transmis à une roue par une bielle.",
  );

  await reviewPendingArticles(store, approveAll, { config: cfg(), select: false });

  assert.equal(store.getArticle(id).status, STATUS.REJECTED, "foreign text must not become trainable");
  const [review] = store.reviewsFor(id);
  assert.equal(review.verdict, "reject");
  assert.equal(review.gate, "language");
  assert.ok(store.getStats().trainable === 0);
  await store.close();
});

test("review gate rejects mojibake the critic would have approved", async () => {
  const store = await openStore();
  const id = await pending(
    store,
    ("The cafÃ© served crÃ¨me brÃ»lÃ©e and the naÃ¯ve rÃ©sumÃ© was \uFFFD \uFFFD truncated. ").repeat(5),
  );

  await reviewPendingArticles(store, approveAll, { config: cfg(), select: false });

  assert.equal(store.getArticle(id).status, STATUS.REJECTED);
  assert.equal(store.reviewsFor(id)[0].gate, "quality");
  await store.close();
});

test("review gate rejects degenerate English junk the critic would have approved", async () => {
  const store = await openStore();
  const id = await pending(store, "The steam engine was developed in Britain during the eighteenth century. ".repeat(20));

  await reviewPendingArticles(store, approveAll, { config: cfg(), select: false });

  assert.equal(store.getArticle(id).status, STATUS.REJECTED);
  assert.equal(store.reviewsFor(id)[0].gate, "quality");
  await store.close();
});

test("a valid, healthy English article is still approved and trainable", async () => {
  const store = await openStore();
  const id = await pending(
    store,
    "The steam engine converted thermal energy into mechanical work because pressure acted on a " +
      "piston inside a cylinder, and the motion was then transferred to a wheel through a rod.",
  );

  await reviewPendingArticles(store, approveAll, { config: cfg(), select: false });

  assert.equal(store.getArticle(id).status, STATUS.REVIEWED, "healthy prose must remain approvable");
  assert.equal(store.getStats().trainable, 1);
  await store.close();
});

test("an English translation from a foreign source URL is approved (provenance is not a rejection rule)", async () => {
  const store = await openStore();
  const id = await pending(
    store,
    "The steam engine converted thermal energy into mechanical work because pressure acted on a " +
      "piston inside a cylinder, and the motion was then transferred to a wheel through a rod.",
    { sourceUrl: "https://fr.wikipedia.org/wiki/Machine_%C3%A0_vapeur", htmlLang: "fr" },
  );

  await reviewPendingArticles(store, approveAll, { config: cfg(), select: false });

  assert.equal(store.getArticle(id).status, STATUS.REVIEWED);
  await store.close();
});

test("a critic timeout leaves the article pending and records a TECHNICAL review (gates do not mask it)", async () => {
  const store = await openStore();
  const id = await pending(
    store,
    "A perfectly ordinary English paragraph about engines and pressure and pistons and wheels.",
  );
  const throwing = { scoreOffline: async () => { throw new Error("socket hang up"); } };

  await reviewPendingArticles(store, throwing, { config: cfg(), select: false });

  assert.equal(store.getArticle(id).status, STATUS.PENDING_REVIEW, "a fault is not a verdict");
  const [review] = store.reviewsFor(id);
  assert.equal(review.criticScoreMissing, true);
  assert.equal(store.reviewAttempts(id, { maxTechnicalAttempts: 5 }).technicalAttempts, 1);
  await store.close();
});

test("gates can be disabled entirely (reversible)", async () => {
  const store = await openStore();
  const id = await pending(store, "Le moteur à vapeur transformait l'énergie thermique en énergie mécanique.");

  await reviewPendingArticles(store, approveAll, { config: cfg({ gatesEnabled: false }), select: false });

  assert.equal(store.getArticle(id).status, STATUS.REVIEWED, "with gates off, behaviour is the prior behaviour");
  await store.close();
});
