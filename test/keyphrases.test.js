import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCorpusKeyphrases, deriveCorpusQueries, combineQueries } from "../src/discovery/keyphrases.js";
import { resolveSearchQueries } from "../src/discovery/mission-queries.js";

/**
 * P4 keyphrase generator — deterministic corpus→query derivation. Keyphrases are
 * multi-word phrases that recur across DISTINCT reviewed articles, ranked by
 * document frequency. Advisory only; empty corpus ⇒ no queries.
 */

const CORPUS = [
  "The steam engine converted heat into mechanical work. James Watt improved the steam engine with a separate condenser.",
  "The steam engine powered the industrial revolution, and the steam engine was far more efficient than earlier engines.",
  "Quantum computing uses qubits to solve problems. The steam engine was eventually replaced by steam turbines.",
];

test("extractCorpusKeyphrases surfaces recurring phrases, not single-document ones", () => {
  const kp = extractCorpusKeyphrases(CORPUS, { minFreq: 2 });
  assert.ok(kp.includes("steam engine"), `"steam engine" appears in all 3 docs, got ${JSON.stringify(kp)}`);
  assert.ok(!kp.includes("industrial revolution"), "a phrase in a single document must be below minFreq");
  assert.ok(!kp.includes("separate condenser"), "a phrase in a single document must be below minFreq");
});

test("extractCorpusKeyphrases is deterministic, bounded, and empty-safe", () => {
  assert.deepEqual(extractCorpusKeyphrases(CORPUS, { max: 4 }), extractCorpusKeyphrases(CORPUS, { max: 4 }));
  assert.ok(extractCorpusKeyphrases(CORPUS, { max: 3, minFreq: 1 }).length <= 3, "respects max");
  assert.deepEqual(extractCorpusKeyphrases([], {}), []);
  assert.deepEqual(extractCorpusKeyphrases(undefined, {}), []);
  assert.deepEqual(extractCorpusKeyphrases(["", "   "], {}), []);
});

test("deriveCorpusQueries returns keyphrases as query strings", () => {
  const q = deriveCorpusQueries(CORPUS, { minFreq: 2 });
  assert.deepEqual(q, extractCorpusKeyphrases(CORPUS, { minFreq: 2 }));
  assert.ok(q.includes("steam engine"));
});

test("combineQueries deduplicates and preserves order", () => {
  assert.deepEqual(combineQueries(["a", "b"], ["b", "c"], undefined, []), ["a", "b", "c"]);
});

test("resolveSearchQueries appends corpus keyphrases only when enabled", () => {
  const base = { configured: ["alpha"], missionTexts: "human language", corpusTexts: CORPUS };

  const off = resolveSearchQueries({ ...base, corpusQueriesEnabled: false });
  assert.equal(off.includes("steam engine"), false, "flag off ⇒ no corpus queries");
  assert.equal(off[0], "alpha");

  const on = resolveSearchQueries({ ...base, enabled: true, corpusQueriesEnabled: true, corpusQueryMax: 3, corpusQueryMinFreq: 2 });
  assert.equal(on[0], "alpha", "configured first");
  assert.ok(on.includes("steam engine"), "corpus keyphrase appended when enabled");
  assert.ok(on.some((q) => q.startsWith("human language")), "mission queries still present");
  assert.equal(new Set(on).size, on.length, "no duplicates");
});
