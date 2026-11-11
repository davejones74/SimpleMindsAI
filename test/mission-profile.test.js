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
