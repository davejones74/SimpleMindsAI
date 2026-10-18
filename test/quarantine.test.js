import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ArticleStore } from "../src/storage/article-store.js";
import { STATUS, QUARANTINE_REASON } from "../src/domain/article.js";

/**
 * Phase 1 — reversible quarantine capability (BUILT here, APPLIED in Phase 4).
 *
 * Quarantine is deliberately separate from retirement: it is an out-of-band,
 * independently releasable holding state that records WHY (a closed reason
 * category), never deletes anything, and restores the prior status on release.
 * Nothing in the autonomous pipeline may call it yet — these tests only pin the
 * capability and its audit trail.
 */

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-quarantine-")));

test("quarantine is reversible, auditable, and keeps distinct reasons", async () => {
  const store = await ArticleStore.open(tmp());
  const a = await store.ingestArticle({ text: "A pending article of sufficient length.", domain: "general", reviewRequested: true });

  const q = await store.quarantineArticle(a.articleId, { reason: QUARANTINE_REASON.FOREIGN_PROSE, detail: "ar" });
  assert.equal(q.quarantined, true);
  const rec = store.getArticle(a.articleId);
  assert.equal(rec.status, STATUS.QUARANTINED);
  assert.equal(rec.quarantineReason, QUARANTINE_REASON.FOREIGN_PROSE);
  assert.equal(rec.quarantinePrevStatus, STATUS.PENDING_REVIEW);

  const report = store.quarantineReport();
  assert.equal(report.total, 1);
  assert.equal(report.byReason[QUARANTINE_REASON.FOREIGN_PROSE], 1);
  assert.equal(report.articles[0].previousStatus, STATUS.PENDING_REVIEW);

  const released = await store.releaseQuarantine(a.articleId, { reason: "reviewed by operator" });
  assert.equal(released.released, true);
  assert.equal(store.getArticle(a.articleId).status, STATUS.PENDING_REVIEW, "release restores the prior status");
  assert.equal(store.quarantineReport().total, 0);

  await store.close();
});

test("quarantine rejects an unknown reason and is idempotent", async () => {
  const store = await ArticleStore.open(tmp());
  const a = await store.ingestArticle({ text: "An article that may be quarantined twice.", domain: "general" });

  await assert.rejects(() => store.quarantineArticle(a.articleId, { reason: "not-a-reason" }), /invalid quarantine reason/);

  await store.quarantineArticle(a.articleId, { reason: QUARANTINE_REASON.CORRUPTED_TEXT });
  const n = store.events.filter((e) => e.articleId === a.articleId).length;
  const again = await store.quarantineArticle(a.articleId, { reason: QUARANTINE_REASON.CORRUPTED_TEXT });
  assert.equal(again.alreadyQuarantined, true);
  assert.equal(store.events.filter((e) => e.articleId === a.articleId).length, n, "re-quarantining appends no events");

  await store.close();
});

test("a quarantined article is excluded from review and from training", async () => {
  const store = await ArticleStore.open(tmp());
  const a = await store.ingestArticle({ text: "An otherwise-approved article about engines.", domain: "history" });
  await store.recordReview({ articleId: a.articleId, verdict: "approve", score: 9, authority: "teacher" });
  assert.equal(store.getStats().trainable, 1);

  await store.quarantineArticle(a.articleId, { reason: QUARANTINE_REASON.MACHINE_TRANSLATED, detail: "en<-de mt" });
  assert.equal(store.getStats().trainable, 0, "a quarantined article is not trainable");
  assert.equal(store.getStats().quarantined, 1);
  assert.equal(store.trainablePage({ limit: 10 }).items.length, 0, "a quarantined article is not in the trainable page");

  const selected = await store.selectForReview({ limit: 500 });
  assert.ok(!selected.includes(a.articleId), "selection must not pick a quarantined article");

  await store.close();
});

test("quarantine survives a restart and release restores the exact prior status", async () => {
  const dir = tmp();
  let store = await ArticleStore.open(dir);
  const a = await store.ingestArticle({ text: "A reviewed article about recursion.", domain: "science" });
  await store.recordReview({ articleId: a.articleId, verdict: "approve", score: 8, authority: "teacher" });
  await store.quarantineArticle(a.articleId, { reason: QUARANTINE_REASON.REVIEW_HOT_LOOP, detail: "20 uncertain" });
  await store.close();

  store = await ArticleStore.open(dir);
  const rec = store.getArticle(a.articleId);
  assert.equal(rec.status, STATUS.QUARANTINED);
  assert.equal(rec.quarantineReason, QUARANTINE_REASON.REVIEW_HOT_LOOP);
  assert.equal(rec.quarantinePrevStatus, STATUS.REVIEWED, "the pre-quarantine status is reconstructed from the log");

  await store.releaseQuarantine(a.articleId);
  assert.equal(store.getArticle(a.articleId).status, STATUS.REVIEWED, "release restores REVIEWED, not a default");

  await store.close();
});
