import { runPython } from "../brain/python-cli.js";
import { config } from "../config.js";

/**
 * Generation-quality regression check.
 *
 * This is a MEASUREMENT, never a promotion gate. It loads a committed version
 * and scores deterministic repetition indicators over a fixed held-out prompt
 * set, so a lineage that drifts into degenerate output ("The 6 is a 6") is
 * visible in the ledger rather than discovered in chat. The promotion decision
 * remains the frozen-eval causal-LM loss alone.
 */

/**
 * Score generation quality for a committed version.
 * @returns {Promise<{version, ok, aggregate, samples, error?}>}
 */
export async function evaluateGenerationQuality({
  version,
  store = config.pythonStore ?? undefined,
  bin = config.pythonBin ?? undefined,
  device = config.studentDevice,
  maxNewTokens = 32,
  timeoutMs = config.promoteEvalTimeoutMs,
  run = runPython,
} = {}) {
  if (!version) return { version, ok: false, error: "no version to measure" };
  try {
    const out = await run(
      ["generate-quality", "--version", version, "--max-new-tokens", String(maxNewTokens), "--device", device],
      { store, bin, timeoutMs },
    );
    return {
      version,
      ok: Boolean(out?.ok && out?.aggregate),
      aggregate: out?.aggregate ?? null,
      samples: Array.isArray(out?.samples) ? out.samples : [],
      promptCount: out?.promptCount ?? 0,
      promptBankVersion: out?.promptBankVersion ?? null,
      promptIds: Array.isArray(out?.promptIds) ? out.promptIds : [],
      decoding: out?.decoding ?? null,
      modelFingerprint: out?.modelFingerprint ?? out?.artifactName ?? null,
      error: out?.ok ? null : "generate-quality failed",
    };
  } catch (err) {
    return { version, ok: false, aggregate: null, samples: [], error: err.message };
  }
}

/**
 * Regression check over a lineage of generation-quality records.
 *
 * Pure and deterministic. A record with `meanRep1` below `rep1Floor` (too few
 * unique tokens) or `maxRun` above `maxRunCeiling` (a long single-token repeat)
 * is flagged degenerate — the observable signature of "The 6 is a 6".
 *
 * @param {Array} records  [{version, aggregate}, ...], oldest first
 * @param {{rep1Floor?:number, maxRunCeiling?:number}} thresholds
 * @returns {{ok, degenerate, records, thresholds}}
 */
export function generationQualityRegression(records = [], { rep1Floor = 0.5, maxRunCeiling = 8 } = {}) {
  const recs = (records ?? []).filter((r) => r?.aggregate);
  const degenerate = recs
    .filter((r) => {
      const rep1 = Number(r.aggregate.meanRep1);
      const maxRun = Number(r.aggregate.maxRun);
      const badRep = Number.isFinite(rep1) && rep1 < rep1Floor;
      const badRun = Number.isFinite(maxRun) && maxRun > maxRunCeiling;
      return badRep || badRun;
    })
    .map((r) => ({ version: r.version, meanRep1: r.aggregate.meanRep1, maxRun: r.aggregate.maxRun }));
  return {
    ok: degenerate.length === 0,
    degenerate,
    measured: recs.length,
    thresholds: { rep1Floor, maxRunCeiling },
  };
}
