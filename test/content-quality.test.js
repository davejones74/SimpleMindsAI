import { test } from "node:test";
import assert from "node:assert/strict";

import { assessContentQuality, isContentEligible } from "../src/domain/content-quality.js";

test("commercial TTS and product pages are excluded with reasons", () => {
  const cases = [
    ["https://elevenlabs.io/text-to-speech/hindi", "", "Introducing Eleven v4. Text to Speech. Sign up today. Pricing plans."],
    ["https://www.business.com/categories/crm-software/crm-market-usage-study/", "Best CRM", "Buy now. Add to cart. Request a demo."],
    ["https://robots.net/gadget-usage/lost-and-found-locating-your-misplaced-stylus-pen/", "Gadget usage", "Buy now. Add to cart. Best stylus."],
  ];
  for (const [url, title, text] of cases) {
    const out = assessContentQuality({ url, title, text });
    assert.equal(out.decision, "exclude", url);
    assert.ok(out.reasons.length > 0, url);
    assert.equal(isContentEligible({ url, title, text }), false, url);
  }
});

test("genuine grammatical prose is allowed even when it mentions language/style", () => {
  const text = [
    "English grammar is the set of structural rules of the English language.",
    "This includes the structure of words, phrases, clauses, sentences, and whole texts.",
    "Writers use punctuation to mark sentence boundaries and to make meaning clear.",
    "A complete sentence normally contains a subject and a predicate.",
  ].join(" ");
  const out = assessContentQuality({
    url: "https://en.wikipedia.org/wiki/English_grammar",
    title: "English grammar",
    text,
  });
  assert.equal(out.decision, "allow");
  assert.ok(out.score < 0.55);
});

test("URL-only thin commercial snippets are excluded but short legitimate notes are not", () => {
  assert.equal(assessContentQuality({ url: "https://example.org/pricing/plans", title: "Pricing", text: "Buy now" }).decision, "exclude");
  assert.equal(assessContentQuality({ url: "https://example.org/grammar/notes", title: "Grammar notes", text: "A clause contains a subject and a verb." }).decision, "allow");
});


test("lone surrogates are excluded as invalid Unicode rather than reaching the tokenizer", () => {
  const out = assessContentQuality({
    url: "https://example.org/grammar/unicode",
    title: "Grammar",
    text: `A legitimate grammar paragraph. ${String.fromCharCode(0xdf16)} This must not reach training.`,
  });
  assert.equal(out.decision, "exclude");
  assert.deepEqual(out.reasons, ["invalid-unicode"]);
});


test("retail host paths, marketing use-case pages and technical hosts are excluded", () => {
  for (const url of [
    "https://www.businessinsider.com/guides/style/best-cashmere-sweater",
    "https://www.atscale.com/use-cases/universal-semantic-layer/",
    "https://www.geeksforgeeks.org/nlp/nlp-how-tokenizing-text-sentence-words-works/",
  ]) {
    const out = assessContentQuality({ url, text: "A complete sentence with a subject and predicate. Another sentence follows for context. Prices and products are discussed." });
    assert.equal(out.decision, "exclude", url);
    assert.ok(out.reasons.length > 0, url);
  }
});

test("licence and legal pages are non-substantive even when captured by the Wayback Machine", () => {
  const text = "This licence grants permission to share and adapt the material under the stated terms. Attribution is required. ".repeat(20);
  for (const url of [
    "https://creativecommons.org/licenses/by/4.0/",
    "https://web.archive.org/web/20171016050101/https://creativecommons.org/licenses/by/4.0/",
    "https://example.org/privacy-policy",
    "https://example.org/terms-of-use",
  ]) {
    const out = assessContentQuality({ url, text });
    assert.equal(out.decision, "exclude", url);
    assert.ok(out.reasons.includes("legal-admin-page"), url);
  }
  assert.equal(assessContentQuality({ url: "https://en.wikipedia.org/wiki/Cell_(biology)", text }).decision, "allow");
});
