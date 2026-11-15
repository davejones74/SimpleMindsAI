import { test } from "node:test";
import assert from "node:assert/strict";
import { assessTrainingProse, isTrainingProseEligible } from "../src/domain/training-prose.js";

const prose = "This is a complete English sentence about the subject. It contains a subject and a predicate, and it ends with clear punctuation. A second sentence develops the paragraph with a coherent idea. A third sentence brings the paragraph to a close. ".repeat(4);

test("technical documentation and code-heavy pages are excluded", () => {
  const sbert = assessTrainingProse({
    url: "https://sbert.net/examples/sentence_transformer/applications/clustering/README.html",
    text: `${prose} import torch. def train(): return model.`,
  });
  assert.equal(sbert.eligible, false);
  assert.ok(sbert.reasons.includes("technical-page"));
});

test("commercial retail pages are excluded", () => {
  const out = assessTrainingProse({
    url: "https://www.businessinsider.com/style/quince-clothing-review",
    text: `${prose} Buy the best leggings, pants, dresses and shoes. Shop now with a discount coupon. Price and sale.`,
  });
  assert.equal(out.eligible, false);
  assert.ok(out.reasons.includes("retail-commercial"));
});

test("well-formed general English prose is accepted even when not about grammar", () => {
  assert.equal(isTrainingProseEligible({
    sourceUrl: "https://www.wired.com/story/hacker-lexicon-credential-dumping/",
    text: prose,
  }), true);
  assert.equal(isTrainingProseEligible({
    sourceUrl: "https://en.wikipedia.org/wiki/English_grammar",
    text: `${prose} English grammar describes clauses, sentences and punctuation.`,
  }), true);
});
