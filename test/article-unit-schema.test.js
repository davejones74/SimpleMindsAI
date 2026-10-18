import { test } from "node:test";
import assert from "node:assert/strict";
import { OllamaClient } from "../src/services/ollama-client.js";
import { ReviewScorer, CRITIC_PROMPT } from "../src/reward/reward-scorer.js";

/**
 * P3 — the article-unit schema (defect D11) and the critic language guard (D6).
 *
 * The training unit is a single continuous prose ARTICLE, never a
 * {prompt, completion} pair. The curator's original contract asked the model for
 * pairs; it now asks for article units, and normalises the legacy pair shape to
 * the same `{ text, domain }` schema so nothing downstream has to care.
 */

test("curator clean() emits ARTICLE UNITS ({text, domain}), not prompt/completion pairs", async () => {
  const client = new OllamaClient({ fixture: true });
  const units = await client.clean("A paragraph about steam engines and pressure and pistons and wheels.");
  assert.ok(Array.isArray(units) && units.length >= 1, JSON.stringify(units));
  for (const u of units) {
    assert.equal(typeof u.text, "string");
    assert.ok(u.text.length > 0);
    assert.equal(u.prompt, undefined, "the legacy pair shape must not leak through");
    assert.equal(u.completion, undefined);
  }
});

test("curator clean() still accepts (and normalises) a legacy {prompt, completion} response", async () => {
  const client = new OllamaClient({ fixture: true });
  client.chat = async () => ({ text: JSON.stringify([{ prompt: "Q?", completion: "A.", domain: "history" }]) });
  const units = await client.clean("raw");
  assert.equal(units.length, 1);
  assert.equal(units[0].text, "Q?\n\nA.");
  assert.equal(units[0].domain, "history");
});

test("the exported critic prompt carries explicit language/corruption hard rules (D6)", () => {
  // Fixture-critic markers must survive so ollama-client still recognises it.
  assert.match(CRITIC_PROMPT, /harsh but fair teacher/i);
  assert.match(CRITIC_PROMPT, /suggestedImportance/);
  assert.match(CRITIC_PROMPT, /reviewing a single ARTICLE/i);
  // The new safeguards.
  assert.match(CRITIC_PROMPT, /NOT fluent English/i);
  assert.match(CRITIC_PROMPT, /mojibake|encoding-corrupted/i);
  assert.match(CRITIC_PROMPT, /ENGLISH TRANSLATION/i);
});

test("ReviewScorer still parses the critic shape and keeps its provenance stamps", async () => {
  const scorer = new ReviewScorer({ ollama: new OllamaClient({ fixture: true }) });
  const r = await scorer.scoreOffline({ text: "The steam engine was developed in Britain.", domain: "history" });
  assert.equal(r.criticScoreMissing, false);
  assert.ok(Number.isFinite(r.rawScore));
});
