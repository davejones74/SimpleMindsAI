import { runPython } from "../brain/python-cli.js";
import { config } from "../config.js";

/**
 * Generation diagnostics are a measurement plane, never a promotion gate.
 *
 * The Python `generate-diagnostics` verb uses the same generation call as the
 * production path plus `output_scores=True`, and reports raw token-id metrics
 * separately from an optional advisory classification. This module wraps that
 * verb and provides a pure parent/candidate comparison that never changes a
 * threshold or makes an acceptance decision.
 */

const AGGREGATE_METRIC_KEYS = [
  "meanOutputLength",
  "meanUniqueTokenRatio",
  "meanUniqueBigramRatio",
  "meanUniqueTrigramRatio",
  "meanRepeatedBigramFraction",
  "meanRepeatedTrigramFraction",
  "maxRun",
  "samplesWithPhraseCycle",
  "samplesWithEarlyDegeneration",
  "meanEarlyDegenerationPosition",
  "meanEntropyNats",
  "meanTop1Prob",
  "meanEosProb",
  "maxEosProb",
  "eosEmittedCount",
  "maxNewTokensStops",
];

const DECODING_KEYS = [
  "doSample",
  "temperature",
  "topP",
  "seed",
  "maxNewTokens",
  "repetitionPenalty",
  "noRepeatNgramSize",
  "useCache",
];

export async function evaluateGenerationDiagnostics({
  version,
  store = config.pythonStore ?? undefined,
  bin = config.pythonBin ?? undefined,
  device = config.studentDevice,
  maxNewTokens = 32,
  promptSuite = "generation-prompts-v2",
  positions = null,
  classify = false,
  timeoutMs = config.promoteEvalTimeoutMs,
  run = runPython,
} = {}) {
  if (!version) {
    return { version, ok: false, error: "no version to measure" };
  }
  const args = [
    "generate-diagnostics",
    "--version",
    version,
    "--prompt-suite",
    promptSuite,
    "--max-new-tokens",
    String(maxNewTokens),
    "--device",
    device,
  ];
  if (classify) args.push("--classify");
  if (Array.isArray(positions) && positions.length) {
    args.push("--positions", ...positions.map((value) => String(value)));
  }
  try {
    const out = await run(args, { store, bin, timeoutMs });
    return {
      version,
      ok: Boolean(out?.ok && Array.isArray(out?.samples) && out.samples.length > 0),
      artifactName: out?.artifactName ?? null,
      modelFingerprint: out?.modelFingerprint ?? out?.artifactName ?? null,
      modelSha256: out?.modelSha256 ?? null,
      checkpoint: out?.checkpoint ?? null,
      modelConfig: out?.modelConfig ?? null,
      tokenizer: out?.tokenizer ?? null,
      generationImplementation: out?.generationImplementation ?? null,
      promptSuite: out?.promptSuite ?? null,
      decoding: out?.decoding ?? null,
      promptCount: out?.promptCount ?? 0,
      aggregate: out?.aggregate ?? null,
      samples: Array.isArray(out?.samples) ? out.samples : [],
      limitations: Array.isArray(out?.limitations) ? out.limitations : [],
      error: out?.ok ? null : "generate-diagnostics failed",
    };
  } catch (err) {
    return {
      version,
      ok: false,
      artifactName: null,
      modelFingerprint: null,
      modelSha256: null,
      checkpoint: null,
      modelConfig: null,
      tokenizer: null,
      generationImplementation: null,
      promptSuite: null,
      decoding: null,
      promptCount: 0,
      aggregate: null,
      samples: [],
      limitations: [],
      error: err.message,
    };
  }
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function metricDelta(parent, candidate, key) {
  const p = finiteNumber(parent?.[key]);
  const c = finiteNumber(candidate?.[key]);
  return { key, parent: p, candidate: c, delta: p == null || c == null ? null : c - p };
}

function decodingDifferences(parent, candidate) {
  const differences = [];
  for (const key of DECODING_KEYS) {
    const p = parent?.decoding?.[key] ?? null;
    const c = candidate?.decoding?.[key] ?? null;
    if (p !== c) differences.push({ key, parent: p, candidate: c });
  }
  return differences;
}

function sampleMap(result) {
  return new Map((result?.samples ?? []).map((sample) => [String(sample.promptId), sample]));
}

/**
 * Compare two diagnostic payloads. The result exposes comparability reasons and
 * numeric deltas; it deliberately does not classify a winner.
 */
export function compareGenerationDiagnostics(parent, candidate, { metricKeys = AGGREGATE_METRIC_KEYS } = {}) {
  const reasons = [];
  if (!parent?.ok) reasons.push(`parent unavailable: ${parent?.error ?? "not evaluated"}`);
  if (!candidate?.ok) reasons.push(`candidate unavailable: ${candidate?.error ?? "not evaluated"}`);

  const parentSuite = parent?.promptSuite?.hash ?? null;
  const candidateSuite = candidate?.promptSuite?.hash ?? null;
  if (parentSuite == null || candidateSuite == null || parentSuite !== candidateSuite) {
    reasons.push("prompt suites differ or are missing");
  }

  const parentTokenizer = parent?.tokenizer?.sha256 ?? null;
  const candidateTokenizer = candidate?.tokenizer?.sha256 ?? null;
  if (parentTokenizer == null || candidateTokenizer == null || parentTokenizer !== candidateTokenizer) {
    reasons.push("tokenizers differ or are missing");
  }

  const decoding = decodingDifferences(parent, candidate);
  if (decoding.length) reasons.push("decoding settings differ");

  const comparable = reasons.length === 0;
  const deltas = metricKeys.map((key) => metricDelta(parent?.aggregate, candidate?.aggregate, key));

  const parentSamples = sampleMap(parent);
  const candidateSamples = sampleMap(candidate);
  const promptIds = [...new Set([...parentSamples.keys(), ...candidateSamples.keys()])].sort();
  const perPrompt = promptIds.map((promptId) => {
    const p = parentSamples.get(promptId) ?? null;
    const c = candidateSamples.get(promptId) ?? null;
    return {
      promptId,
      category: p?.category ?? c?.category ?? null,
      prompt: p?.prompt ?? c?.prompt ?? null,
      parentText: p?.text ?? null,
      candidateText: c?.text ?? null,
      textChanged: p?.text !== c?.text,
      parentMetrics: p
        ? {
            outputLength: p.repetition?.outputLength ?? null,
            uniqueTokenRatio: p.repetition?.uniqueTokenRatio ?? null,
            uniqueBigramRatio: p.repetition?.ngrams?.["2"]?.uniqueRatio ?? null,
            repeatedBigramFraction: p.repetition?.ngrams?.["2"]?.duplicateOccurrenceFraction ?? null,
            maxRun: p.repetition?.maxRun ?? null,
            earlyDegenerationPosition: p.repetition?.earlyDegenerationPosition ?? null,
            meanEntropyNats: p.distributionSummary?.meanEntropyNats ?? null,
            meanTop1Prob: p.distributionSummary?.meanTop1Prob ?? null,
            eosProbMax: p.eos?.maxEosProb ?? null,
            eosEmitted: Boolean(p.eos?.emitted),
            degenerate: Boolean(p.classification?.degenerate),
          }
        : null,
      candidateMetrics: c
        ? {
            outputLength: c.repetition?.outputLength ?? null,
            uniqueTokenRatio: c.repetition?.uniqueTokenRatio ?? null,
            uniqueBigramRatio: c.repetition?.ngrams?.["2"]?.uniqueRatio ?? null,
            repeatedBigramFraction: c.repetition?.ngrams?.["2"]?.duplicateOccurrenceFraction ?? null,
            maxRun: c.repetition?.maxRun ?? null,
            earlyDegenerationPosition: c.repetition?.earlyDegenerationPosition ?? null,
            meanEntropyNats: c.distributionSummary?.meanEntropyNats ?? null,
            meanTop1Prob: c.distributionSummary?.meanTop1Prob ?? null,
            eosProbMax: c.eos?.maxEosProb ?? null,
            eosEmitted: Boolean(c.eos?.emitted),
            degenerate: Boolean(c.classification?.degenerate),
          }
        : null,
    };
  });

  const parentFlagged = new Set(
    (parent?.samples ?? [])
      .filter((sample) => sample.classification?.degenerate)
      .map((sample) => String(sample.promptId)),
  );
  const candidateFlagged = new Set(
    (candidate?.samples ?? [])
      .filter((sample) => sample.classification?.degenerate)
      .map((sample) => String(sample.promptId)),
  );
  const newlyFlagged = [...candidateFlagged].filter((id) => !parentFlagged.has(id)).sort();
  const newlyUnflagged = [...parentFlagged].filter((id) => !candidateFlagged.has(id)).sort();

  return {
    comparable,
    reasons,
    parent: {
      version: parent?.version ?? null,
      artifactName: parent?.artifactName ?? null,
      modelSha256: parent?.modelSha256 ?? null,
      promptSuiteHash: parentSuite,
      tokenizerSha256: parentTokenizer,
    },
    candidate: {
      version: candidate?.version ?? null,
      artifactName: candidate?.artifactName ?? null,
      modelSha256: candidate?.modelSha256 ?? null,
      promptSuiteHash: candidateSuite,
      tokenizerSha256: candidateTokenizer,
    },
    decodingDifferences: decoding,
    deltas,
    perPrompt,
    classification: {
      parentApplied: Boolean(parent?.aggregate?.classification?.applied),
      candidateApplied: Boolean(candidate?.aggregate?.classification?.applied),
      parentFlaggedSampleIds: [...parentFlagged].sort(),
      candidateFlaggedSampleIds: [...candidateFlagged].sort(),
      newlyFlagged,
      newlyUnflagged,
      flagCountDelta: candidateFlagged.size - parentFlagged.size,
    },
    limitations: [
      "Comparison reports measurements and deltas; it does not decide acceptance.",
      "A fixed prompt suite is a diagnostic, not a general language-capability claim.",
      "Only compare checkpoints with the same prompt-suite hash, tokenizer and decoding settings.",
      ...(Array.isArray(candidate?.limitations) ? candidate.limitations : []),
    ],
  };
}
