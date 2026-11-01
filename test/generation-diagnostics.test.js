import { test } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateGenerationDiagnostics,
  compareGenerationDiagnostics,
} from "../src/training/generation-diagnostics.js";

function payload({
  version = "v390",
  suiteHash = "suite-hash",
  tokenizerHash = "tok-hash",
  sampleOverrides = {},
  aggregateOverrides = {},
  decoded = " the same as the same as",
  degenerate = true,
} = {}) {
  const sample = {
    promptId: "gp-v2-01",
    category: "factual",
    prompt: "prompt",
    text: decoded,
    repetition: {
      outputLength: 8,
      uniqueTokenRatio: 0.25,
      maxRun: 1,
      earlyDegenerationPosition: 3,
      ngrams: {
        "2": { uniqueRatio: 0.25, duplicateOccurrenceFraction: 0.75 },
      },
    },
    distributionSummary: { meanEntropyNats: 2.0, meanTop1Prob: 0.4 },
    eos: { emitted: false, maxEosProb: 0.001, termination: "max_new_tokens" },
    classification: { applied: true, degenerate },
    ...sampleOverrides,
  };
  return {
    version,
    ok: true,
    artifactName: `artifact-${version}`,
    modelSha256: `model-${version}`,
    promptSuite: { hash: suiteHash, version: "generation-prompts-v2" },
    tokenizer: { sha256: tokenizerHash },
    decoding: {
      doSample: false,
      temperature: 0,
      topP: 0.95,
      seed: 0,
      maxNewTokens: 32,
      repetitionPenalty: 1.0,
      noRepeatNgramSize: 0,
      useCache: true,
    },
    aggregate: {
      promptCount: 1,
      meanUniqueTokenRatio: 0.25,
      meanUniqueBigramRatio: 0.25,
      meanRepeatedBigramFraction: 0.75,
      maxRun: 1,
      samplesWithPhraseCycle: 1,
      samplesWithEarlyDegeneration: 1,
      meanEntropyNats: 2.0,
      meanTop1Prob: 0.4,
      meanEosProb: 0.001,
      maxEosProb: 0.001,
      eosEmittedCount: 0,
      maxNewTokensStops: 1,
      classification: {
        applied: true,
        flaggedSampleIds: degenerate ? ["gp-v2-01"] : [],
        flaggedSampleCount: degenerate ? 1 : 0,
      },
      ...aggregateOverrides,
    },
    samples: [sample],
    limitations: ["suite limitation"],
  };
}

test("evaluateGenerationDiagnostics maps the python payload", async () => {
  const out = await evaluateGenerationDiagnostics({
    version: "v390",
    run: async () => payload(),
  });
  assert.equal(out.ok, true);
  assert.equal(out.version, "v390");
  assert.equal(out.modelSha256, "model-v390");
  assert.equal(out.promptSuite.hash, "suite-hash");
  assert.equal(out.aggregate.meanUniqueTokenRatio, 0.25);
  assert.equal(out.samples.length, 1);
  assert.deepEqual(out.limitations, ["suite limitation"]);
});

test("evaluateGenerationDiagnostics fails closed", async () => {
  const thrown = await evaluateGenerationDiagnostics({
    version: "v390",
    run: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(thrown.ok, false);
  assert.match(thrown.error, /boom/);

  const missing = await evaluateGenerationDiagnostics({ version: null });
  assert.equal(missing.ok, false);

  const noSamples = await evaluateGenerationDiagnostics({
    version: "v390",
    run: async () => ({ ok: true, samples: [] }),
  });
  assert.equal(noSamples.ok, false);
});

test("compareGenerationDiagnostics is comparable for matched inputs and reports deltas", () => {
  const parent = payload({ version: "v389", degenerate: true });
  const candidate = payload({
    version: "v390",
    decoded: " a different output",
    degenerate: false,
    aggregateOverrides: { meanUniqueTokenRatio: 0.5, meanEntropyNats: 3.0 },
  });
  const comparison = compareGenerationDiagnostics(parent, candidate);
  assert.equal(comparison.comparable, true);
  assert.deepEqual(comparison.reasons, []);
  const unique = comparison.deltas.find((entry) => entry.key === "meanUniqueTokenRatio");
  assert.equal(unique.parent, 0.25);
  assert.equal(unique.candidate, 0.5);
  assert.equal(unique.delta, 0.25);
  assert.equal(comparison.perPrompt[0].textChanged, true);
  assert.deepEqual(comparison.classification.newlyUnflagged, ["gp-v2-01"]);
  assert.deepEqual(comparison.classification.newlyFlagged, []);
  assert.equal(comparison.classification.flagCountDelta, -1);
});

test("compareGenerationDiagnostics refuses incomparable prompt suites, tokenizers and decoding", () => {
  const parent = payload({ version: "v389" });
  const suiteMismatch = compareGenerationDiagnostics(
    parent,
    payload({ version: "v390", suiteHash: "other-suite" }),
  );
  assert.equal(suiteMismatch.comparable, false);
  assert.match(suiteMismatch.reasons.join(";"), /prompt suites differ/);

  const tokenizerMismatch = compareGenerationDiagnostics(
    parent,
    payload({ version: "v390", tokenizerHash: "other-tokenizer" }),
  );
  assert.equal(tokenizerMismatch.comparable, false);
  assert.match(tokenizerMismatch.reasons.join(";"), /tokenizers differ/);

  const candidate = payload({ version: "v390" });
  candidate.decoding.temperature = 0.8;
  candidate.decoding.doSample = true;
  const decodingMismatch = compareGenerationDiagnostics(parent, candidate);
  assert.equal(decodingMismatch.comparable, false);
  assert.match(decodingMismatch.reasons.join(";"), /decoding settings differ/);
  assert.equal(decodingMismatch.decodingDifferences.length, 2);
});

test("compareGenerationDiagnostics handles missing or failed inputs", () => {
  const failed = compareGenerationDiagnostics(null, { ok: false, error: "missing" });
  assert.equal(failed.comparable, false);
  assert.match(failed.reasons.join(";"), /parent unavailable/);
  assert.match(failed.reasons.join(";"), /candidate unavailable/);
  assert.equal(failed.perPrompt.length, 0);
  assert.equal(failed.deltas.every((entry) => entry.delta === null), true);
});

test("comparison does not invent an acceptance decision", () => {
  const comparison = compareGenerationDiagnostics(payload(), payload({ version: "v391" }));
  assert.equal(Object.hasOwn(comparison, "decision"), false);
  assert.equal(Object.hasOwn(comparison, "promoted"), false);
  assert.match(comparison.limitations[0], /does not decide acceptance/);
});
