import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCurriculum, fallbackCurriculum } from "../src/curriculum/validation.js";

test("valid article plan passes the deterministic gate", () => {
  const out = validateCurriculum({
    assessment: "healthy",
    priorities: ["more reasoning"],
    curriculum: [
      { category: "reasoning", targetExamples: 10, minimumImportance: "Important" },
      { category: "coding", targetExamples: 5, minimumImportance: "Normal" },
    ],
  }, { allowedCategories: ["reasoning", "coding"], maxTotalExamples: 100 });
  assert.equal(out.ok, true);
  assert.equal(out.curriculum.length, 2);
  assert.equal(out.errors.length, 0);
  assert.equal(out.curriculum[0].category, "reasoning");
  assert.equal(out.curriculum[0].minimumImportance, "Important");
});

test("invalid plan is rejected: bad category / over cap / duplicate; bad importance clamped", () => {
  const out = validateCurriculum({
    curriculum: [
      { category: "politics", targetExamples: 5 },               // not allowed
      { category: "reasoning", targetExamples: 9000 },           // over ceiling
      { category: "coding", targetExamples: 5, minimumImportance: "Bogus" }, // clamped to Normal
      { category: "coding", targetExamples: 5 },                 // duplicate
    ],
  }, { allowedCategories: ["reasoning", "coding"], maxTotalExamples: 50 });
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => /politics/.test(e)));
  assert.ok(out.errors.some((e) => /exceeds ceiling/.test(e)));
  assert.ok(out.errors.some((e) => /duplicate/.test(e)));
  const coding = out.curriculum.find((c) => c.category === "coding");
  assert.equal(coding.minimumImportance, "Normal");
  assert.ok(out.curriculum.every((c) => c.targetExamples <= 50)); // each entry clamped
  assert.ok(out.errors.some((e) => /total requested/.test(e))); // overflow reported
});

test("missing curriculum degrades to rejected-with-errors, fallback is deterministic", () => {
  const out = validateCurriculum({ assessment: "junk" }, {});
  assert.equal(out.ok, false);
  assert.equal(out.curriculum.length, 0);

  // Deterministic fallback never invents domains the stats don't have.
  const fb = fallbackCurriculum(
    { byDomain: [{ domain: "reasoning", count: 12 }, { domain: "junk", count: 99 }] },
    { allowedCategories: ["reasoning", "coding"], maxTotalExamples: 10 },
  );
  assert.equal(fb.curriculum.length, 1); // junk filtered out
  assert.equal(fb.curriculum[0].category, "reasoning");
  assert.ok(fb.curriculum[0].targetExamples <= 10);
});
