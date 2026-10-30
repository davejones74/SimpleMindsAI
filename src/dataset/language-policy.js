import { assess } from "../domain/language.js";

/**
 * Explicit corpus language eligibility.
 *
 * The article store is never mutated. A document is merely eligible or not for
 * a corpus under the configured supported-language policy. The detection result,
 * confidence and reason are recorded so an exclusion can be audited.
 */
export const LANGUAGE_POLICY_VERSION = "english-first-v1";

export function normalizeSupportedLanguages(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim().toLowerCase()).filter(Boolean);
  return String(value ?? "en")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

export function evaluateCorpusLanguage(text, {
  htmlLang = null,
  sourceUrl = null,
  supportedLanguages = ["en"],
  minConfidence = 0.8,
  unknownPolicy = "reject",
} = {}) {
  const supported = normalizeSupportedLanguages(supportedLanguages);
  const { verdict, detection } = assess(text, { minConfidence, htmlLang, sourceUrl });
  const language = String(detection?.language ?? "und").toLowerCase();
  const confidence = Number(detection?.confidence ?? 0);

  let eligible;
  let reason;
  if (verdict === "unknown") {
    eligible = String(unknownPolicy).toLowerCase() === "allow";
    reason = eligible ? "unknown-allowed" : "unknown-rejected";
  } else if (supported.includes(language)) {
    eligible = true;
    reason = "supported-language";
  } else {
    eligible = false;
    reason = verdict === "non-english" ? "non-supported-language" : "detector-verdict";
  }

  return {
    policyVersion: LANGUAGE_POLICY_VERSION,
    eligible,
    language,
    confidence,
    verdict,
    reason,
    detectedReason: detection?.reason ?? null,
    htmlLang: htmlLang ?? null,
    sourceUrl: sourceUrl ?? null,
    supportedLanguages: supported,
    unknownPolicy,
    minConfidence,
  };
}
