import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { ArticleStore } from "../src/storage/article-store.js";
import { STATUS, isReplayPool } from "../src/domain/article.js";
import { collectRowsFromArticles } from "../src/dataset/snapshot.js";

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-replay-")));
const longText = (name) => `Article ${name}. ` + Array.from({ length: 30 }, (_, i) => `Sentence ${name}-${i} describes a distinct English topic with a complete clause.`).join(" ");

test("isReplayPool: retirement is independent of replay eligibility", () => {
  const base = { articleId: "a", text: "Some valid English text.", status: STATUS.RETIRED };
  assert.equal(isReplayPool(base), false, "legacy retired without an explicit event is not replayable");
  assert.equal(isReplayPool({ ...base, replayEligible: true }), true, "explicit replay eligibility survives retirement");
  assert.equal(isReplayPool({ ...base, replayEligible: false }), false);
  assert.equal(isReplayPool({ ...base, replayEligible: true, status: STATUS.REJECTED }), false, "explicit rejection wins");
  assert.equal(isReplayPool({ ...base, replayEligible: true, quarantined: true }), false, "quarantine wins");
  assert.equal(isReplayPool({ ...base, replayEligible: true, excludedReason: "licence" }), false, "explicit exclusion wins");
  assert.equal(isReplayPool({ ...base, replayEligible: true, text: "" }), false, "missing text is not replayable");
});

test("retiring and consuming an article does not remove explicit replay eligibility", async () => {
  const store = await ArticleStore.open(tmp());
  const article = await store.ingestArticle({ text: longText("retire"), sourceUrl: "https://www.gutenberg.org/files/1/1.txt" });
  await store.recordReview({ articleId: article.articleId, verdict: "approve", authority: "human" });
  await store.markConsumed([article.articleId], { runId: "run-1" });
  await store.retireArticle(article.articleId, { reason: "review exhausted; not a quality verdict" });
  assert.equal(store.getArticle(article.articleId).status, STATUS.RETIRED);
  assert.equal(isReplayPool(store.getArticle(article.articleId)), false, "legacy retirement excludes replay until explicitly migrated");

  await store.setReplayEligibility(article.articleId, { eligible: true, reason: "migration: valid accepted text" });
  assert.equal(isReplayPool(store.getArticle(article.articleId)), true);
  assert.equal(store.getStats().retiredReplayEligible, 1);
  assert.equal(store.getStats().consumedAndRetired, 1);

  const page = store.replayPoolPage({ limit: 10 });
  assert.deepEqual(page.items.map((a) => a.articleId), [article.articleId]);
  await store.close();
});

test("replay selection uses the independent eligibility property", async () => {
  const store = await ArticleStore.open(tmp());
  const old = await store.ingestArticle({ text: longText("old"), sourceUrl: "https://www.gutenberg.org/files/2/2.txt" });
  const fresh = await store.ingestArticle({ text: longText("fresh"), sourceUrl: "https://www.gutenberg.org/files/3/3.txt" });
  for (const a of [old, fresh]) await store.recordReview({ articleId: a.articleId, verdict: "approve", authority: "human" });
  await store.markConsumed([old.articleId], { runId: "run-old" });
  await store.retireArticle(old.articleId, { reason: "review exhausted" });
  await store.setReplayEligibility(old.articleId, { eligible: true, reason: "migration: valid accepted text" });

  const collected = collectRowsFromArticles(store, {
    limit: 10,
    includeConsumed: false,
    replayPercent: 100,
    validationBlocks: 0,
    corpusMode: "fragment",
  });
  assert.ok(collected.freshArticleIds.includes(fresh.articleId));
  assert.ok(collected.replayArticleIds.includes(old.articleId), "retired-but-explicitly-eligible article is replayable");
  await store.close();
});

test("migration dry-run/apply is idempotent and restores only safe accepted retired records", async () => {
  const dir = tmp();
  const store = await ArticleStore.open(dir);
  const good = await store.ingestArticle({ text: longText("good"), sourceUrl: "https://www.gutenberg.org/files/10/10.txt" });
  const rejected = await store.ingestArticle({ text: longText("rejected"), sourceUrl: "https://www.gutenberg.org/files/11/11.txt" });
  const uncertain = await store.ingestArticle({ text: longText("uncertain"), sourceUrl: "https://en.wikipedia.org/wiki/Example" });
  await store.recordReview({ articleId: good.articleId, verdict: "approve", authority: "human" });
  await store.recordReview({ articleId: rejected.articleId, verdict: "reject", authority: "human" });
  await store.recordReview({ articleId: uncertain.articleId, verdict: "approve", authority: "human" });
  await store.markConsumed([good.articleId, rejected.articleId, uncertain.articleId], { runId: "run-1" });
  await store.retireArticle(good.articleId, { reason: "legacy retirement" });
  await store.retireArticle(rejected.articleId, { reason: "legacy retirement" });
  await store.retireArticle(uncertain.articleId, { reason: "legacy retirement" });
  await store.close();

  const reportFile = path.join(dir, "dry-run.json");
  execFileSync(process.execPath, ["scripts/knowledge-pilot/classify-replay.mjs", "--store", dir, "--out", reportFile], { cwd: process.cwd(), encoding: "utf8" });
  const report = JSON.parse(await readFile(reportFile, "utf8"));
  assert.equal(report.mode, "dry-run");
  assert.equal(report.eligibleCount, 1, "only the safe-domain approved record is eligible");
  assert.equal(report.unresolvedCount, 1, "uncertain licence is unresolved, not restored");
  assert.equal(report.ineligibleCount, 1, "explicit rejection remains ineligible");
  assert.equal(report.restoredInApply, 0);

  const secondFile = path.join(dir, "dry-run-2.json");
  execFileSync(process.execPath, ["scripts/knowledge-pilot/classify-replay.mjs", "--store", dir, "--out", secondFile], { cwd: process.cwd(), encoding: "utf8" });
  const second = JSON.parse(await readFile(secondFile, "utf8"));
  assert.deepEqual(second.counts, report.counts, "dry-run is deterministic/idempotent");

  execFileSync(process.execPath, ["scripts/knowledge-pilot/classify-replay.mjs", "--store", dir, "--apply", "--confirm", "--out", path.join(dir, "apply.json")], { cwd: process.cwd(), encoding: "utf8" });
  const applied = JSON.parse(await readFile(path.join(dir, "apply.json"), "utf8"));
  assert.equal(applied.restoredInApply, 1);
  execFileSync(process.execPath, ["scripts/knowledge-pilot/classify-replay.mjs", "--store", dir, "--apply", "--confirm", "--out", path.join(dir, "apply-2.json")], { cwd: process.cwd(), encoding: "utf8" });
  const applied2 = JSON.parse(await readFile(path.join(dir, "apply-2.json"), "utf8"));
  assert.equal(applied2.restoredInApply, 0, "second apply is a no-op");

  const reopened = await ArticleStore.open(dir);
  assert.equal(isReplayPool(reopened.getArticle(good.articleId)), true);
  assert.equal(isReplayPool(reopened.getArticle(rejected.articleId)), false);
  assert.equal(isReplayPool(reopened.getArticle(uncertain.articleId)), false);
  await reopened.close();
});

test("migration refuses apply against a production path", () => {
  assert.throws(
    () => execFileSync(process.execPath, ["scripts/knowledge-pilot/classify-replay.mjs", "--store", "/var/lib/simpleminds/data/articles", "--apply", "--confirm"], { cwd: process.cwd(), encoding: "utf8", stdio: "pipe" }),
    /production path/i,
  );
});
