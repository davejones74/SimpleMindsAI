import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContentClusters, jaccardSimilarity } from "../src/dataset/dedup.js";
import { buildPartition, InsufficientValidationError } from "../src/dataset/partition.js";

const long = (prefix, n = 30) =>
  Array.from({ length: n }, (_, i) => `${prefix} sentence ${i} contains stable explanatory words about a topic`).join(" ");

const row = (id, text, sourceId, extra = {}) => ({
  articleId: id,
  text,
  contentHash: undefined,
  sourceId,
  publisherId: extra.publisherId ?? `publisher-${sourceId}`,
  estimatedTokens: extra.estimatedTokens ?? Math.max(1, Math.ceil(text.length / 4)),
  ...extra,
});

test("dedup clusters exact, normalised, near-duplicate and same-source rows", () => {
  const base = long("alpha");
  const items = [
    row("a1", base, "src-a"),
    row("a2", base.toUpperCase(), "src-a"),
    row("a3", `${base} with one small additional trailing clause`, "src-a"),
    row("b1", long("beta"), "src-b"),
    row("c1", long("gamma"), "src-c"),
    row("d1", long("delta"), "src-d"),
  ];
  const clusters = buildContentClusters(items, { threshold: 0.6 });
  const by = clusters.clusterByArticle;
  assert.equal(by.get("a1"), by.get("a2"));
  assert.equal(by.get("a1"), by.get("a3"));
  assert.notEqual(by.get("b1"), by.get("a1"));
  assert.notEqual(by.get("c1"), by.get("b1"));
  assert.notEqual(by.get("d1"), by.get("c1"));
});

test("same publisher alone does not cluster unrelated articles; same source does", () => {
  const items = [
    row("a1", long("one"), "source-one", { publisherId: "same.example" }),
    row("a2", long("two"), "source-two", { publisherId: "same.example" }),
    row("b1", long("three"), "source-three"),
    row("b2", long("four"), "source-three"),
  ];
  const clusters = buildContentClusters(items);
  assert.notEqual(clusters.clusterByArticle.get("a1"), clusters.clusterByArticle.get("a2"));
  assert.equal(clusters.clusterByArticle.get("b1"), clusters.clusterByArticle.get("b2"));
});

test("short documents are not called near-duplicates by Jaccard", () => {
  assert.equal(jaccardSimilarity("short text", "short text", 5), 0);
  assert.ok(jaccardSimilarity(long("same"), `${long("same")} extra`, 5) > 0.6);
});

test("partition keeps whole clusters and source families on one side", () => {
  const rows = [
    row("a1", long("a"), "src-a"),
    row("a2", `${long("a")} extra`, "src-a"),
    row("b1", long("b"), "src-b"),
    row("c1", long("c"), "src-c"),
    row("d1", long("d"), "src-d"),
  ];
  const partition = buildPartition({
    rows,
    splitSeed: 7,
    validationFraction: 0.25,
    minValidationTokens: 1,
    minValidationClusters: 1,
  });
  const byCluster = new Map();
  for (const assignment of partition.assignments) {
    const seen = byCluster.get(assignment.clusterId);
    if (seen) assert.equal(seen, assignment.partition, "a cluster crossed the partition");
    byCluster.set(assignment.clusterId, assignment.partition);
  }
  const a1 = partition.assignmentByArticle.get("a1");
  const a2 = partition.assignmentByArticle.get("a2");
  assert.equal(a1.partition, a2.partition);
  assert.ok(partition.validationArticleIds.length > 0);
  assert.ok(partition.trainArticleIds.length > 0);
});

test("partition is deterministic under row reordering", () => {
  const rows = [
    row("a1", long("a"), "src-a"),
    row("b1", long("b"), "src-b"),
    row("c1", long("c"), "src-c"),
    row("d1", long("d"), "src-d"),
  ];
  const options = { splitSeed: 3, validationFraction: 0.25, minValidationTokens: 1, minValidationClusters: 1 };
  const first = buildPartition({ rows, ...options });
  const second = buildPartition({ rows: [...rows].reverse(), ...options });
  assert.equal(first.splitHash, second.splitHash);
  assert.deepEqual(first.validationArticleIds, second.validationArticleIds);
});

test("insufficient validation fails explicitly instead of falling back", () => {
  const rows = [row("a1", long("a"), "src-a"), row("b1", long("b"), "src-b")];
  assert.throws(
    () => buildPartition({
      rows,
      splitSeed: 1,
      validationFraction: 0.25,
      minValidationTokens: 1,
      minValidationClusters: 5,
    }),
    (err) => err.code === "INSUFFICIENT_VALIDATION" && err instanceof InsufficientValidationError,
  );
});

test("historical exposure is distinguished from prospective holdout", () => {
  const rows = [
    row("a1", long("a"), "src-a"),
    row("b1", long("b"), "src-b"),
    row("c1", long("c"), "src-c"),
    row("d1", long("d"), "src-d"),
  ];
  const allHistorical = buildPartition({
    rows,
    splitSeed: 2,
    validationFraction: 0.25,
    minValidationTokens: 1,
    minValidationClusters: 1,
    historicalArticleIds: new Set(rows.map((r) => r.articleId)),
  });
  assert.equal(allHistorical.exposure.validationExposureMode, "historical-only");
  assert.equal(allHistorical.exposure.validationHistoricalArticles, allHistorical.validationArticleIds.length);

  assert.throws(
    () => buildPartition({
      rows,
      splitSeed: 2,
      validationFraction: 0.25,
      minValidationTokens: 1,
      minValidationClusters: 1,
      historicalArticleIds: new Set(rows.map((r) => r.articleId)),
      requireProspective: true,
    }),
    (err) => err.code === "INSUFFICIENT_VALIDATION",
  );

  const mixed = buildPartition({
    rows,
    splitSeed: 2,
    validationFraction: 0.25,
    minValidationTokens: 1,
    minValidationClusters: 1,
    historicalArticleIds: new Set(["a1", "b1", "c1"]),
  });
  assert.ok(["prospective-only", "mixed", "historical-only"].includes(mixed.exposure.validationExposureMode));
  assert.ok(mixed.exposure.prospectiveClusters >= 1);
});
