import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OllamaClient } from "../src/services/ollama-client.js";
import { ReviewScorer, RewardScorer, heuristicPenalty } from "../src/reward/reward-scorer.js";
import { ArticleStore } from "../src/storage/article-store.js";

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-")));

test("heuristicPenalty guardrail catches degenerate repetition", () => {
  assert.equal(heuristicPenalty(""), 0);
  const degen = "yes yes yes yes yes".repeat(3);
  const healthy = "The steam engine was developed in Britain during the eighteenth century.";
  assert.ok(heuristicPenalty(healthy) > heuristicPenalty(degen));
});

test("scoreOffline: deterministic guardrail + critic/rubric provenance (fixture critic)", async () => {
  const scorer = new ReviewScorer({ ollama: new OllamaClient({ fixture: true }) });
  const r = await scorer.scoreOffline({
    text: "The steam engine was developed in Britain during the eighteenth century. Thomas Newcomen built the first practical engine in 1712.",
    domain: "history",
  });
  assert.ok(r.score >= 0 && r.score <= 10);
  assert.ok(Number.isFinite(r.rawScore));
  assert.equal(typeof r.guardrailResult.passed, "boolean");
  assert.equal(r.criticVersion, "critic-v1");
  assert.equal(r.rubricVersion, "rubric-v1");
  assert.equal(r.criticModel, "deepseek-r1:latest");
  assert.match(r.rationale, /heuristicPenalty=/);
  assert.ok(["approve", "reject", "uncertain"].includes(r.verdict));
  assert.equal(RewardScorer, ReviewScorer); // backward-compatible alias
});

test("recordReview persists provenance and applies a confident teacher verdict", async () => {
  const store = await ArticleStore.open(tmp());
  const a = await store.ingestArticle({ text: "A howto article worth training on with enough prose.", domain: "howto" });
  const res = await store.recordReview({
    articleId: a.articleId,
    verdict: "approve",
    score: 8.5,
    authority: "teacher",
    reviewerModel: "deepseek-r1:latest",
    reviewerVersion: "critic-v1",
    rubricVersion: "rubric-v1",
    guardrailResult: { passed: true, heuristicPenalty: 0.92 },
  });
  const [saved] = store.reviewsFor(a.articleId);
  assert.equal(saved.score, 8.5);
  assert.equal(saved.reviewerVersion, "critic-v1");
  assert.equal(saved.rubricVersion, "rubric-v1");
  assert.deepEqual(saved.guardrailResult, { passed: true, heuristicPenalty: 0.92 });
  assert.equal(res.applied, true);
  assert.equal(store.getArticle(a.articleId).status, "REVIEWED");
  await store.close();
});
