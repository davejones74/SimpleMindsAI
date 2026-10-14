import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RegistryStore } from "../src/storage/registry-store.js";
import { ArticleStore } from "../src/storage/article-store.js";
import { buildSnapshot, collectRowsFromArticles, snapshotRowReader, rowForArticle } from "../src/dataset/snapshot.js";
import { loadEvaluationSet, makeEvalGuard, pairHash, evalText } from "../src/dataset/evaluation-set.js";

const tmpDir = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-ds-")));

const articleRow = (i, origin = "curated") => ({
  articleId: `art_${i}`,
  contentHash: `hash_${i}`,
  text: `Article ${i} body text long enough to be meaningful.`,
  domain: "general",
  importance: "Normal",
  origin,
  createdAt: new Date().toISOString(),
});

test("rowForArticle carries source→curated provenance only when recorded", () => {
  const plain = rowForArticle(articleRow(1));
  assert.equal("sourceUrl" in plain, false);
  assert.equal("fetchedContentHash" in plain, false);
  assert.equal("teacherModel" in plain, false);

  const withProv = rowForArticle({
    ...articleRow(2),
    sourceUrl: "https://example.org/article",
    fetchedContentHash: "a".repeat(64),
    model: "teacher:v9",
  });
  assert.equal(withProv.sourceUrl, "https://example.org/article");
  assert.equal(withProv.fetchedContentHash, "a".repeat(64));
  assert.equal(withProv.teacherModel, "teacher:v9");
  // The trained text keeps its own hash, independent of the fetched original.
  assert.equal(withProv.text, articleRow(2).text);
  assert.equal(withProv.contentHash, "hash_2");
});

test("snapshot is immutable, hash-sealed, provenance-carrying", async () => {
  const reg = await RegistryStore.open(tmpDir());
  const snapDir = tmpDir();
  const rows = [articleRow(1), articleRow(2), articleRow(3, "synthetic")];

  const a = await buildSnapshot({ registry: reg, rowsRaw: rows, source: "store", dir: snapDir });
  assert.equal(a.manifest.recordCount, 3);
  assert.equal(a.manifest.syntheticCount, 1);
  assert.equal(a.manifest.source, "store");
  assert.equal(a.manifest.datasetVersion, a.hash.slice(0, 12));
  assert.ok(existsSync(a.file));
  assert.deepEqual((await snapshotRowReader.read(a.file)).map((r) => r.articleId), ["art_1", "art_2", "art_3"]);

  // A different rows set => NEW datasetId/version/file; old file untouched.
  const b = await buildSnapshot({ registry: reg, rowsRaw: [articleRow(1), articleRow(2)], dir: snapDir });
  assert.notEqual(a.manifest.datasetId, b.manifest.datasetId);
  assert.notEqual(a.manifest.datasetVersion, b.manifest.datasetVersion);
  assert.equal(reg.listSnapshots().length, 2);
  await reg.close();
});

test("synthetic share is reported, never used to silently drop rows", async () => {
  const reg = await RegistryStore.open(tmpDir());
  const rows = [
    articleRow(1, "synthetic"),
    articleRow(2, "synthetic"),
    articleRow(3, "synthetic"),
    articleRow(4, "curated"),
  ];
  const snap = await buildSnapshot({ registry: reg, rowsRaw: rows, dir: tmpDir() });
  assert.equal(snap.manifest.recordCount, 4); // nothing dropped
  assert.equal(snap.manifest.syntheticCount, 3);
  assert.equal(snap.manifest.syntheticShare, 0.75);
  await reg.close();
});

test("collectRowsFromArticles returns only REVIEWED, unconsumed articles", async () => {
  const store = await ArticleStore.open(tmpDir());
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const a = await store.ingestArticle({ text: `Trainable article number ${i} about reasoning.`, domain: "reasoning" });
    await store.recordReview({ articleId: a.articleId, verdict: "approve", authority: "human" });
    ids.push(a.articleId);
  }
  const pending = await store.ingestArticle({ text: "An article still awaiting review.", domain: "reasoning" });
  await store.requestReview(pending.articleId);

  const { rows } = collectRowsFromArticles(store, { limit: 10 });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.articleId).sort(), [...ids].sort());
  await store.close();
});

test("evaluation leak guard: content-hash excludes eval rows from a snapshot", async () => {
  const evalDir = tmpDir();
  const evalSet = await loadEvaluationSet({
    dir: evalDir,
    seed: () => [{ text: "SEEDED EVAL ARTICLE TEXT", domain: "general" }],
  });
  assert.equal(evalSet.size, 1);

  // The file is frozen: re-loading never consults the seed again.
  const reloaded = await loadEvaluationSet({ dir: evalDir, seed: () => [{ text: "OTHER ARTICLE" }] });
  assert.equal(reloaded.items.length, 1);

  const guard = makeEvalGuard(evalSet);
  const { kept, excluded } = guard.filter([{ text: "SEEDED EVAL ARTICLE TEXT" }, { text: "keep me please" }]);
  assert.equal(excluded.length, 1);
  assert.equal(kept.length, 1);
  assert.equal(guard.contains({ text: "SEEDED EVAL ARTICLE TEXT" }), true);
  assert.equal(pairHash("prompt one", "completion one").length, 32);
  assert.equal(evalText({ prompt: "a", completion: "b" }), "a\n\nb");
});

test("evaluation set: the minimum-documents floor is advisory and off by default", async () => {
  const seed = () => [{ text: "ONE EVAL DOCUMENT", domain: "general" }];

  // Default (0): the set loads, its size is recorded, nothing is warned about.
  const quiet = await loadEvaluationSet({ dir: tmpDir(), seed });
  assert.equal(quiet.size, 1);
  assert.equal(quiet.minDocuments, 0);
  assert.deepEqual(quiet.warnings, []);

  // Configured floor: the shortfall is surfaced, and the set is STILL loaded
  // and usable — the floor never fails closed.
  const warned = await loadEvaluationSet({ dir: tmpDir(), seed, minDocuments: 3 });
  assert.equal(warned.size, 1);
  assert.equal(warned.items.length, 1);
  assert.equal(warned.hashes.size, 1);
  assert.equal(warned.warnings.length, 1);
  assert.equal(warned.warnings[0].code, "eval-set-undersized");
  assert.equal(warned.warnings[0].severity, "advisory");
  assert.equal(warned.warnings[0].size, 1);
  assert.equal(warned.warnings[0].minDocuments, 3);
  assert.match(warned.warnings[0].message, /below the advisory minimum/);

  // A set that meets the floor warns about nothing.
  const ok = await loadEvaluationSet({ dir: tmpDir(), seed, minDocuments: 1 });
  assert.deepEqual(ok.warnings, []);
});
