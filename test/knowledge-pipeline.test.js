import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildKnowledgePipeline, getRunMembership, getArticleTrainingHistory } from "../src/admin/knowledge-pipeline.js";

const prose = "This is a complete sentence about a coherent subject. It contains a clear subject and predicate, and it ends with punctuation. The paragraph develops one idea before moving to the next. A second short paragraph completes the prose sample with enough words to satisfy the substantive-text rule. ".repeat(3);

function fakeStore(articles) {
  const statuses = { INGESTED: 0, PENDING_REVIEW: 0, REVIEWED: 0, REJECTED: 0, RETIRED: 0, UNRESOLVED: 0, QUARANTINED: 0 };
  for (const a of articles) statuses[a.status] = (statuses[a.status] ?? 0) + 1;
  return {
    articles,
    getStats: () => ({ totalArticles: articles.length, byStatus: statuses, trainable: articles.filter((a) => a.status === "REVIEWED").length, replayEligible: 0, deferredFresh: 0, uniqueConsumed: 0, pendingReview: statuses.PENDING_REVIEW }),
    articlesPage({ after = null, limit = 100 } = {}) {
      const start = after ? articles.findIndex((a) => a.articleId === after) + 1 : 0;
      const items = articles.slice(start, start + limit);
      return { items, nextCursor: items.length ? items.at(-1).articleId : null };
    },
    listContributions: () => [{ runId: "run-1", decision: "rejected", version: "v2", parentVersion: "v1", freshArticleIds: ["a1"], replayArticleIds: ["a2"], at: "2026-01-01T00:00:00Z" }],
  };
}

const config = {
  snapshotLimit: 100,
  trainReplayPercent: 0,
  trainCorpusMode: "fragment",
  trainValBlocks: 32,
  validationBank: { enabled: false },
  trainMinFreshTokens: 100,
  trainMaxSourceTokenShare: 0,
  trainMaxPublisherTokenShare: 0,
  curatorMaxUnitsPerSource: 2,
  trainRequireMissionFocus: false,
  trainRequireProseQuality: true,
  trainSeqLen: 128,
  paths: { validationBanks: ".none" },
  pythonStore: null,
};

test("pipeline readiness uses the same selector path and reports authoritative queues", async () => {
  const articles = [
    { articleId: "a1", text: prose, status: "REVIEWED", sourceUrl: "https://example.org/a1", sourceDomain: "example.org", fetchedContentHash: "s1", contentHash: "h1", consumedAt: null },
    { articleId: "a2", text: prose, status: "REVIEWED", sourceUrl: "https://example.org/a2", sourceDomain: "example.org", fetchedContentHash: "s2", contentHash: "h2", consumedAt: null },
    { articleId: "a3", text: "short", status: "PENDING_REVIEW", sourceUrl: "https://example.org/a3", sourceDomain: "example.org" },
  ];
  const store = fakeStore(articles);
  const out = await buildKnowledgePipeline({
    store,
    registry: { listRuns: () => [] },
    config,
    tokenizerPath: "fake-tokenizer",
    measure: async (rows) => ({ documents: rows.map((r) => ({ itemId: r.itemId, tokens: 80 })), totalTokens: rows.length * 80 }),
    pythonStorePath: "/tmp/none",
  });
  assert.equal(out.queues.collected, 3);
  assert.equal(out.queues.awaitingReview, 1);
  assert.equal(out.queues.freshTrainable, 2);
  assert.equal(out.readiness.freshArticles, 2);
  assert.equal(out.readiness.freshTokens, 160);
  assert.equal(out.readiness.ready, true);
  assert.equal(out.readiness.limitingCondition, "ready");
  assert.equal(out.integrity.ok, true);
});

test("run membership and article history retain rejected-run provenance", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sma-pipeline-"));
  const file = path.join(dir, "run-1.jsonl");
  writeFileSync(file, `${JSON.stringify({ articleId: "a1", corpusRole: "train", sourceUrl: "https://example.org/a1", sourceId: "s1" })}\n${JSON.stringify({ articleId: "a2", corpusRole: "replay" })}\n`);
  const store = fakeStore([]);
  const registry = { listRuns: () => [{ runId: "run-1", status: "rejected", datasetFile: file, baseModelVersion: "v1" }] };
  const membership = getRunMembership({ store, registry, runId: "run-1" });
  assert.equal(membership.rows.length, 2);
  assert.equal(membership.counts.fresh, 1);
  assert.equal(membership.counts.replay, 1);
  assert.equal(membership.source, "training-contribution");
  const history = getArticleTrainingHistory({ store, articleId: "a1" });
  assert.equal(history.appearances[0].runId, "run-1");
  assert.equal(history.appearances[0].decision, "rejected");
});
