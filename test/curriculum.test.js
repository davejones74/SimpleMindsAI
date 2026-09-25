import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCurriculum, fallbackCurriculum } from "../src/curriculum/validation.js";

test("valid LLM plan passes the deterministic gate", () => {
  const out = validateCurriculum({
    assessment: "healthy",
    priorities: ["score more"],
    maxSyntheticShare: 0.1,
    curriculum: [
      { category: "reasoning", targetExamples: 10, minimumReward: 6 },
      { category: "coding", targetExamples: 5, minimumReward: 5.5 },
    ],
  }, { allowedCategories: ["reasoning", "coding"], maxSyntheticShare: 0.2, maxTotalExamples: 100 });
  assert.equal(out.ok, true);
  assert.equal(out.curriculum.length, 2);
  assert.equal(out.maxSyntheticShare, 0.1);
  assert.equal(out.errors.length, 0);
});

test("invalid plan is rejected: bad category / over cap / bad reward", () => {
  const out = validateCurriculum({
    maxSyntheticShare: 0.9, // way over ceiling
    curriculum: [
      { category: "politics", targetExamples: 9000, minimumReward: -3 }, // not allowed + over ceiling + bad reward
      { category: "coding", targetExamples: 5, minimumReward: 12 },      // reward out of 0..10
      { category: "coding", targetExamples: 5, minimumReward: 5 },      // duplicate
    ],
  }, { allowedCategories: ["reasoning", "coding"], maxSyntheticShare: 0.2, maxTotalExamples: 50 });
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => /politics/.test(e)));
  assert.ok(out.errors.some((e) => /ceiling/.test(e)));
  assert.ok(out.errors.some((e) => /0..10/.test(e)));
  assert.ok(out.errors.some((e) => /duplicate/.test(e)));
  // clamps applied: share capped, total capped, reward clamped
  assert.equal(out.maxSyntheticShare, 0.2);
  assert.equal(out.curriculum.reduce((a, c) => a + c.targetExamples, 0) <= 50, true);
});

test("missing curriculum degrades to rejected-with-errors, fallback is deterministic", () => {
  const out = validateCurriculum({ assessment: "junk" }, {});
  assert.equal(out.ok, false);
  assert.equal(out.curriculum.length, 0);

  // Deterministic fallback never uses the LLM numbers.
  const fb = fallbackCurriculum(
    { byDomain: [{ domain: "reasoning", count: 12 }, { domain: "junk", count: 99 }] },
    { allowedCategories: ["reasoning", "coding"], maxTotalExamples: 10 }
  );
  assert.equal(fb.maxSyntheticShare, 0);
  assert.equal(fb.curriculum.length, 1); // junk filtered out
  assert.equal(fb.curriculum[0].category, "reasoning");
  assert.equal(fb.curriculum[0].targetExamples <= 10, true);
});