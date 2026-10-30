import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCorpusDiversity, applyDiversityCaps } from "../src/dataset/diversity.js";
import { evaluateCorpusLanguage } from "../src/dataset/language-policy.js";

const row = (id, sourceId, tokens, extra = {}) => ({
  articleId: id,
  text: "x ".repeat(tokens),
  sourceId,
  publisherId: extra.publisherId ?? sourceId,
  estimatedTokens: tokens,
  qualityTier: extra.qualityTier ?? "full-text",
  language: extra.language ?? "en",
  ...extra,
});

test("diversity reports source/publisher concentration and quality tiers", () => {
  const rows = [
    row("a1", "source-a", 80),
    row("a2", "source-a", 20),
    row("b1", "source-b", 50),
    row("c1", "source-c", 50, { qualityTier: "fallback", language: "fr" }),
  ];
  const diversity = computeCorpusDiversity(rows);
  assert.equal(diversity.totalRows, 4);
  assert.equal(diversity.totalTokensEstimated, 200);
  assert.equal(diversity.distinctSources, 3);
  assert.equal(diversity.top1SourceShare, 0.5);
  assert.ok(diversity.sourceHerfindahl > 0);
  assert.equal(diversity.qualityTiers.find((t) => t.key === "fallback").tokens, 50);
  assert.equal(diversity.languages.find((l) => l.key === "fr").tokens, 50);
});

test("fallback and source caps are deterministic deferral, not deletion", () => {
  const rows = [
    row("a1", "source-a", 90),
    row("b1", "source-b", 10),
    row("f1", "source-f", 10, { qualityTier: "fallback" }),
  ];
  const fallback = applyDiversityCaps(rows, { maxFallbackTokenShare: 0.01 });
  assert.equal(fallback.kept.some((r) => r.articleId === "f1"), false);
  assert.equal(fallback.removedByReason["fallback-cap"], 1);

  const source = applyDiversityCaps(rows, { maxSourceTokenShare: 0.5 });
  assert.equal(source.kept.some((r) => r.articleId === "a1"), false);
  assert.equal(source.removedByReason["source-cap"], 1);
});

test("language eligibility is explicit for English, non-English and unknown", () => {
  const english = evaluateCorpusLanguage(
    "The steam engine is a heat engine that performs mechanical work using steam as its working fluid. "
      + "The steam engine uses the force produced by steam pressure to push a piston back and forth inside a cylinder. "
      + "This pushing force can be transformed by a connecting rod and crank into rotational force for work.",
    { htmlLang: "en", supportedLanguages: ["en"], unknownPolicy: "reject" },
  );
  assert.equal(english.eligible, true);
  assert.equal(english.language, "en");

  const french = evaluateCorpusLanguage(
    "Le moteur à vapeur convertit la chaleur en travail mécanique dans un cycle thermodynamique.",
    { htmlLang: "fr", supportedLanguages: ["en"], unknownPolicy: "reject" },
  );
  assert.equal(french.eligible, false);
  assert.equal(french.reason, "non-supported-language");

  const unknown = evaluateCorpusLanguage("x y z", { supportedLanguages: ["en"], unknownPolicy: "reject" });
  assert.equal(unknown.eligible, false);
  const allowed = evaluateCorpusLanguage("x y z", { supportedLanguages: ["en"], unknownPolicy: "allow" });
  assert.equal(allowed.eligible, true);
});
