import { test } from "node:test";
import assert from "node:assert/strict";

import { createMissionProfile, scoreFocusText, gateFocusCandidate } from "../src/discovery/mission-profile.js";

const MISSION =
  "To continually refine its understanding of language by acquiring and preserving complete, well-formed English prose that demonstrates clear grammar, syntax, punctuation, sentence boundaries, and paragraph structure, while remaining objective and aligned with user intent.";

test("mission profile derives language-mechanics terms and prompt guidance", () => {
  const p = createMissionProfile({
    missionTexts: [MISSION],
    focus: { mode: "weighted", languageShare: 0.8, broadShare: 0.2, minScore: 0.08 },
  });
  assert.ok(p.terms.includes("grammar"));
  assert.ok(p.terms.includes("sentence"));
  assert.ok(p.phrases.includes("sentence structure"));
  assert.match(p.prompt, /language mechanics|grammar|syntax|sentence/i);
});

test("language URL/path scores above the focus threshold; unrelated politics is broad", () => {
  const p = createMissionProfile({
    missionTexts: [MISSION],
    focus: { mode: "weighted", languageShare: 0.8, broadShare: 0.2, minScore: 0.08 },
  });
  assert.ok(scoreFocusText("https://example.org/grammar/sentence-structure", p) >= p.minScore);
  assert.ok(scoreFocusText("https://example.org/politics/election", p) < p.minScore);
});

test("weighted gate enforces the 80/20 broad quota on the candidate stream", () => {
  const p = createMissionProfile({
    missionTexts: [MISSION],
    focus: { mode: "weighted", languageShare: 0.8, broadShare: 0.2, minScore: 0.08 },
  });
  const counts = { focus: 8, broad: 2, rejected: 0 };
  const broad = gateFocusCandidate(p, { url: "https://example.org/politics/election", counts });
  assert.equal(broad.allow, false);
  assert.equal(counts.rejected, 1);
  const focused = gateFocusCandidate(p, { url: "https://example.org/grammar/sentence-structure", counts });
  assert.equal(focused.allow, true);
  assert.equal(focused.kind, "focus");
});

test("a stream with no focus matches is not allowed to become all broad", () => {
  const p = createMissionProfile({
    missionTexts: [MISSION],
    focus: { mode: "weighted", languageShare: 0.8, broadShare: 0.2, minScore: 0.08 },
  });
  const counts = { focus: 0, broad: 0, rejected: 0 };
  assert.equal(gateFocusCandidate(p, { url: "https://example.org/sports/football", counts }).allow, true);
  assert.equal(gateFocusCandidate(p, { url: "https://example.org/finance/stocks", counts }).allow, false);
});

test("generic terms alone no longer qualify commercial/product URLs", () => {
  const p = createMissionProfile({
    missionTexts: [MISSION],
    focus: { mode: "enforce", languageShare: 0.8, broadShare: 0.2, minScore: 0.08 },
  });
  const rejected = [
    "https://elevenlabs.io/text-to-speech/hindi",
    "https://www.coursera.org/articles/natural-language-processing-salary",
    "https://robots.net/gadget-usage/lost-and-found-locating-your-misplaced-stylus-pen/",
    "https://www.business.com/categories/crm-software/crm-market-usage-study/",
    "https://www.infoworld.com/article/2335255/what-is-object-oriented-programming-the-everyday-programming-style.html",
  ];
  for (const url of rejected) {
    const d = gateFocusCandidate(p, { url });
    assert.equal(d.allow, false, url);
    assert.equal(d.kind, "rejected", url);
    assert.ok(d.audit.negativeSignals.length > 0 || d.audit.strongSignals === 0, url);
  }
});

test("genuine grammar and linguistics pages still qualify, with audit signals", () => {
  const p = createMissionProfile({
    missionTexts: [MISSION],
    focus: { mode: "enforce", languageShare: 0.8, broadShare: 0.2, minScore: 0.08 },
  });
  for (const url of [
    "https://en.wikipedia.org/wiki/English_grammar",
    "https://en.wikipedia.org/wiki/Sentence_clause_structure",
    "https://writingcenter.unc.edu/tips-and-tools/sentence-structure/",
    "https://www.linguisticsociety.org/resource/grammar",
    "https://plato.stanford.edu/entries/linguistics/",
  ]) {
    const d = gateFocusCandidate(p, { url });
    assert.equal(d.allow, true, url);
    assert.equal(d.kind, "focus", url);
    assert.ok(d.audit.strongSignals > 0, url);
    assert.ok(d.audit.policyVersion, url);
  }
});

test("shadow mode records the new and legacy decision without rejecting", () => {
  const p = createMissionProfile({
    missionTexts: [MISSION],
    focus: { mode: "shadow", languageShare: 0.8, broadShare: 0.2, minScore: 0.08 },
  });
  const d = gateFocusCandidate(p, { url: "https://elevenlabs.io/text-to-speech/hindi" });
  assert.equal(d.allow, true);
  assert.equal(d.shadow, true);
  assert.equal(d.audit.legacyFocus, true);
  assert.equal(d.audit.shadow, true);
});

test("technical documentation and commercial retail prose do not qualify as language mechanics", () => {
  const p = createMissionProfile({
    missionTexts: [MISSION],
    focus: { mode: "enforce", languageShare: 0.8, broadShare: 0.2, minScore: 0.08 },
  });
  const sbert = gateFocusCandidate(p, {
    url: "https://sbert.net/examples/sentence_transformer/applications/clustering/README.html",
    text: "Sentence Transformers train sentence embeddings with PyTorch on a dataset for semantic search.",
  });
  const grammar = gateFocusCandidate(p, {
    url: "https://en.wikipedia.org/wiki/English_grammar",
    text: "English grammar describes the structure of clauses, sentences, punctuation, and clear paragraphs.",
  });
  assert.equal(sbert.allow, false);
  assert.equal(grammar.allow, true);
  assert.equal(grammar.kind, "focus");
});

test("training eligibility rejects technical docs but accepts grammar prose", async () => {
  const { isTrainingFocusEligible } = await import("../src/dataset/snapshot.js");
  assert.equal(isTrainingFocusEligible({ sourceUrl: "https://sbert.net/docs/sentence_transformer/", text: "Sentence Transformer embeddings on a PyTorch dataset." }), false);
  assert.equal(isTrainingFocusEligible({ sourceUrl: "https://en.wikipedia.org/wiki/English_grammar", text: "English grammar and sentence structure with punctuation and clear paragraphs." }), true);
});
