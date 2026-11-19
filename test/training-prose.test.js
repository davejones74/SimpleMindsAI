import { test } from "node:test";
import assert from "node:assert/strict";
import { assessTrainingProse, isTrainingProseEligible } from "../src/domain/training-prose.js";

const prose = "This is a complete English sentence about the subject. It contains a subject and a predicate, and it ends with clear punctuation. A second sentence develops the paragraph with a coherent idea. A third sentence brings the paragraph to a close. ".repeat(6);

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

test("coherent long-form encyclopedia prose is not rejected for citation line breaks", () => {
  const article = [
    "The cell is the basic structural and functional unit of all forms of life or organisms.",
    "The term comes from the Latin word cellula meaning 'small room'.[1]",
    "A biological cell basically consists of a semipermeable cell membrane enclosing cytoplasm that contains genetic material.[2]",
    "Most cells are only visible under a microscope. Except for highly differentiated cells, all cells share a common architecture.",
    "The study of cells is called cell biology, cellular biology, or cytology.",
    "Cells were discovered by Robert Hooke in 1665, who named them for their resemblance to cells inhabited by Christian monks.",
    "Cell theory, first developed in 1839 by Matthias Jakob Schleiden and Theodor Schwann, states that all organisms are composed of one or more cells.",
  ].join("\n");
  const out = assessTrainingProse({ url: "https://en.wikipedia.org/wiki/Cell_(biology)", text: article });
  assert.equal(out.eligible, true, JSON.stringify(out.reasons));
});

test("technical vocabulary in a coherent science article is accepted", () => {
  const article = "CUDA is a proprietary parallel computing platform and application programming interface developed by Nvidia. It allows software to use graphics processing units for accelerated general-purpose processing, significantly broadening their utility in artificial intelligence and scientific computing. CUDA was created to let developers write programs that run on GPUs without requiring graphics-specific APIs. The platform provides a programming model, libraries, and tooling for parallel applications. ".repeat(4);
  const out = assessTrainingProse({ url: "https://en.wikipedia.org/wiki/CUDA", text: article });
  assert.equal(out.eligible, true, JSON.stringify(out.reasons));
});

test("prose mentioning a class or import is not mistaken for source code", () => {
  const article = "The working class became a major political force during the industrial period. Historians import economic evidence into their accounts of social change. A class of reforms followed the report, and each class of workers experienced the transition differently. ".repeat(6);
  const out = assessTrainingProse({ url: "https://en.wikipedia.org/wiki/Working_class", text: article });
  assert.equal(out.eligible, true, JSON.stringify(out.reasons));
});

test("short but complete substantive articles still meet the prose floor", () => {
  const article = "The International Organization for Standardization is an international organization that was founded in 1947. It is headquartered in Geneva, Switzerland, and develops voluntary standards for many industries. Its members are national standards bodies from countries around the world. The organization publishes standards covering technology, manufacturing, safety, and management. ".repeat(4);
  const out = assessTrainingProse({ url: "https://en.wikipedia.org/wiki/International_Organization_for_Standardization", text: article });
  assert.equal(out.eligible, true, JSON.stringify(out.reasons));
});
