import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  mergeAdjacentUnits,
  planCuration,
  segmentSourceText,
} from "../src/services/curator-segmentation.js";
import { runLearningCycle } from "../src/jobs/learning.js";
import { ArticleStore } from "../src/storage/article-store.js";

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-segment-")));
const paragraph = (name, i) => `Paragraph ${name}-${i}. ` + Array.from({ length: 20 }, (_, j) => `Clause ${name}-${i}-${j} contains a complete English sentence about the topic.`).join(" ");

test("legacy curation still truncates to one 14k slice", () => {
  const raw = "A complete sentence. ".repeat(3000);
  const plan = planCuration(raw, { strategy: "legacy", legacyMaxChars: 14_000 });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].chars, 14_000);
  assert.equal(plan[0].truncated, true);
});

test("segmented curation covers the full source in bounded sentence-aligned chunks", () => {
  const raw = Array.from({ length: 8 }, (_, i) => paragraph("full", i)).join("\n\n");
  const chunks = segmentSourceText(raw, { maxChars: 4_000, minChars: 800, targetChars: 2_000 });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.chars <= 4_000, `chunk ${chunk.index} too large: ${chunk.chars}`);
  const visible = chunks.reduce((sum, c) => sum + c.chars, 0);
  assert.ok(visible / raw.length > 0.98, "segmentation must not silently drop source text");
});

test("adjacent short units merge only within one domain", () => {
  const merged = mergeAdjacentUnits([
    { text: "short one", domain: "science" },
    { text: "short two", domain: "science" },
    { text: "short three", domain: "history" },
  ], { minChars: 800, maxChars: 6_000 });
  assert.equal(merged.length, 2);
  assert.equal(merged[0].domain, "science");
  assert.match(merged[0].text, /short two/);
  assert.equal(merged[1].domain, "history");
});

test("learning cycle curates every chunk of a long source", async () => {
  const store = await ArticleStore.open(tmp());
  const longText = Array.from({ length: 12 }, (_, i) => paragraph("source", i)).join("\n\n");
  let calls = 0;
  const ollama = {
    model: "teacher-x",
    clean: async (chunk) => {
      calls += 1;
      return [{ text: chunk, domain: "science" }];
    },
  };
  const scorer = { scoreOffline: async () => ({ verdict: "approve", score: 9, rationale: "useful" }) };
  const collectDocuments = async () => ({
    mode: "fixture",
    capability: "fixture-harvest",
    documents: [{ text: longText, domain: "science", source: "fixture", url: "https://science.nasa.gov/example" }],
    failures: [],
  });
  const out = await runLearningCycle({ store, ollama, scorer, collectDocuments, maxRawDocs: 0 });
  assert.ok(calls > 1, `expected multiple curation chunks, got ${calls}`);
  assert.equal(out.ingested, calls);
  assert.equal(store.getStats().totalArticles, calls);
  await store.close();
});
