import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildValidationBank,
  loadActiveValidationBank,
  assertValidationBankDisjoint,
} from "../src/dataset/validation-bank.js";

function tmp() {
  return mkdtempSync(path.join(tmpdir(), "sma-vbank-"));
}

function fakeStore(articles, tokens = 128) {
  const reserved = [];
  return {
    reserved,
    articlesPage({ after = null, limit = 100 } = {}) {
      const start = after ? articles.findIndex((a) => a.articleId === after) + 1 : 0;
      const items = articles.slice(start, start + limit);
      return { items, nextCursor: items.length ? items[items.length - 1].articleId : null };
    },
    async reserveValidation(ids, meta) {
      reserved.push({ ids, meta });
      return { reserved: ids, skipped: [] };
    },
    _tokens: tokens,
  };
}

const measure = async (rows, { seqLen = 128 } = {}) => ({
  documents: rows.map((row) => ({ itemId: row.itemId, tokens: 256 })),
  totalTokens: rows.length * 256,
  sequenceLength: seqLen,
});

test("builds a source-disjoint bank with 32 validation blocks and a durable manifest", async () => {
  const dir = tmp();
  const articles = Array.from({ length: 20 }, (_, i) => ({
    articleId: `art-${i}`,
    text: `English grammar and sentence structure lesson number ${i}. A clause contains a subject and a verb. Punctuation marks sentence boundaries. Clear prose depends on well formed sentences and coherent paragraphs, and a careful writer checks each clause for agreement. `.repeat(4),
    sourceUrl: `https://example.org/grammar/${i}`,
    sourceDomain: "example.org",
    fetchedContentHash: `source-${i}`,
    status: "REVIEWED",
    contentHash: `hash-${i}`,
  }));
  const store = fakeStore(articles);
  const out = await buildValidationBank({
    store, dir, tokenizerPath: "tokenizer.json", targetBlocks: 32, marginBlocks: 0,
    minSources: 3, maxCandidates: 100, measure,
  });
  assert.ok(out.manifest.selectedBlocks >= 32);
  assert.ok(out.manifest.sourceIds.length >= 3);
  assert.ok(store.reserved.length === 1);
  assert.ok(store.reserved[0].ids.includes(out.manifest.articleIds[0]));
  const loaded = loadActiveValidationBank({ dir });
  assert.equal(loaded.manifest.bankVersion, out.manifest.bankVersion);
  assert.equal(loaded.rows.length, out.rows.length);
  assert.equal(loaded.rows[0].corpusRole, "validation");
});

test("fails closed when the bank cannot reach 32 blocks", async () => {
  const dir = tmp();
  const store = fakeStore([{
    articleId: "art-1", text: "A short grammar note.", sourceUrl: "https://example.org/grammar/1",
    sourceDomain: "example.org", fetchedContentHash: "s1", status: "REVIEWED",
  }]);
  await assert.rejects(
    buildValidationBank({ store, dir, tokenizerPath: "tokenizer.json", targetBlocks: 32, marginBlocks: 0, minSources: 1, measure }),
    (err) => err.code === "INSUFFICIENT_VALIDATION_BANK",
  );
});

test("detects a corrupted bank content hash", async () => {
  const dir = tmp();
  const store = fakeStore([{
    articleId: "art-1", text: "English grammar and sentence structure. A clause contains a subject and a verb. Punctuation marks boundaries. Clear prose depends on complete sentences, coherent paragraphs, and careful punctuation. ".repeat(6),
    sourceUrl: "https://example.org/grammar/1", sourceDomain: "example.org", fetchedContentHash: "s1", status: "REVIEWED",
  }]);
  const out = await buildValidationBank({
    store, dir, tokenizerPath: "tokenizer.json", targetBlocks: 1, marginBlocks: 0, minSources: 1, measure,
  });
  const bankFile = path.join(dir, out.manifest.bankVersion, "bank.ndjson");
  writeFileSync(bankFile, readFileSync(bankFile, "utf8").replace("English grammar", "Corrupted text"));
  assert.throws(() => loadActiveValidationBank({ dir }), (err) => err.code === "INVALID_VALIDATION_BANK");
});

test("detects source and content overlap with training rows", () => {
  const bankRows = [{ articleId: "a", sourceId: "source-1", contentHash: "hash-1" }];
  assert.throws(
    () => assertValidationBankDisjoint({ bankRows, trainingRows: [{ articleId: "b", sourceId: "source-1" }] }),
    (err) => err.code === "VALIDATION_BANK_OVERLAP",
  );
  assert.throws(
    () => assertValidationBankDisjoint({ bankRows, trainingRows: [{ articleId: "b", contentHash: "hash-1" }] }),
    (err) => err.code === "VALIDATION_BANK_OVERLAP",
  );
  assert.equal(assertValidationBankDisjoint({ bankRows, trainingRows: [{ articleId: "c", sourceId: "source-2" }] }), true);
});
