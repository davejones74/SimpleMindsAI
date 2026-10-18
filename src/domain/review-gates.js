/**
 * Review-time quality gates — deterministic, dependency-free.
 *
 * These run in the review lifecycle BEFORE the LLM critic, because the critic is
 * language-blind: it can score a French article or encoding-corrupted text as
 * "useful" on content alone. The gates separate the three concerns the operator
 * asked for, and only two of them can reject:
 *
 *   - LANGUAGE (a decision, may reject): judged on the ACTUAL training text via
 *     the shared detector, with `<html lang>` / multilingual-host declarations as
 *     supplementary evidence. A valid English TRANSLATION is judged on its
 *     English text and passes — provenance alone is never a rejection rule.
 *   - QUALITY (a decision, may reject): encoding corruption (mojibake) and
 *     degenerate repetition that survived cleaning.
 *   - MISSION: NOT here — relevance is advisory only and must never reject an
 *     otherwise valid article. It belongs to selection, not to this gate.
 *
 * Every gate is reversible through configuration: disabling the language filter,
 * the quality gate, or the whole gate set restores prior behaviour exactly.
 */

import { assess, detectLanguage } from "./language.js";

export const GATE = Object.freeze({ LANGUAGE: "language", QUALITY: "quality" });

// Heuristic starting values — NOT calibrated guarantees.
const DEFAULT_MIN_BIGRAM_RATIO = 0.15; // unique-bigram ratio below => degenerate
const DEFAULT_MAX_MOJIBAKE_RATIO = 0.02; // corruption-char density above => mojibake
const MIN_WORDS_FOR_REPETITION = 30; // too-short text has no trustworthy ratio

// Corruption indicators: replacement characters, stray C0 controls (excluding
// tab/newline/carriage-return), and the tell-tale double-encoded UTF-8 lead
// sequences ("Ã©", "Â ", "â€™"). Legitimate accented Latin text (é, à, û as their
// own code points) is NOT matched — only the mojibake digraphs are.
const MOJIBAKE_RE =
  /[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]|\u00C2[\u0080-\u00BF]|\u00C3[\u0080-\u00BF]|\u00E2\u0080[\u0098-\u009D]/g;

/** Fraction of characters that are encoding-corruption indicators, in [0,1]. */
export function mojibakeRatio(text) {
  const s = String(text ?? "");
  if (!s.length) return 0;
  const hits = (s.match(MOJIBAKE_RE) ?? []).length;
  return hits / s.length;
}

/**
 * Unique-bigram ratio over word tokens: 1.0 = fully diverse, →0 = degenerate
 * repetition. This is the SHARED repetition primitive (the reward scorer's
 * `heuristicPenalty` is an alias of it) so the gate and the guardrail can never
 * disagree about what "repetitive" means.
 */
export function repetitionPenalty(text) {
  const words = String(text ?? "").toLowerCase().match(/[a-z0-9']+/g) ?? [];
  if (words.length < 3) return 0;
  const bigrams = new Set();
  for (let i = 0; i < words.length - 1; i++) bigrams.add(words[i] + " " + words[i + 1]);
  return bigrams.size / Math.max(1, words.length - 1);
}

export const heuristicPenalty = repetitionPenalty;

function wordCount(text) {
  return (String(text ?? "").match(/[a-z0-9']+/gi) ?? []).length;
}

/**
 * Pre-screen a text before the critic. Pure and deterministic: the same input
 * always yields the same decision, so a gate rejection is auditable and
 * reproducible.
 *
 * @param {string} text - the ACTUAL training text (never the raw source)
 * @param {object} [options]
 * @param {string|null} [options.sourceUrl] - provenance, used only as declared-language evidence
 * @param {string|null} [options.htmlLang]
 * @param {object|null} [options.languageFilter] - {enabled, shadow, minConfidence, unknownPolicy}
 * @param {object|null} [options.quality] - {enabled, minBigramRatio, maxMojibakeRatio}
 * @returns {{decision: "proceed"|"reject", gate: string|null, reason: string|null,
 *   detection?: object, metrics?: object}}
 */
export function preScreen(text, { sourceUrl = null, htmlLang = null, languageFilter = null, quality = null } = {}) {
  const body = String(text ?? "");

  if (languageFilter?.enabled && !languageFilter.shadow) {
    const decision = assess(body, {
      minConfidence: Number.isFinite(languageFilter.minConfidence) ? languageFilter.minConfidence : 0.8,
      htmlLang,
      sourceUrl,
    });
    // Text-first guard, and the reason this gate does NOT apply `unknownPolicy`:
    // the detector's confidence floor (0.80) marks even clearly-English short
    // text as "unknown", and a foreign `<html lang>` / host declaration alone
    // can then flip it to "non-english". So before rejecting we ask whether the
    // ACTUAL text leans English (at least half its exclusive stopword evidence).
    // If it does, a foreign declaration is NOT a reason to reject — that is
    // exactly the valid-English-translation case the operator requires to pass.
    // "Unknown" never rejects here; genuinely ambiguous text falls through to
    // the quality gate and the (now language-aware) critic.
    const detection = detectLanguage(body, { htmlLang });
    const leansEnglish = detection.englishRatio !== null && detection.englishRatio >= 0.5;
    if (decision.verdict === "non-english" && !leansEnglish) {
      return {
        decision: "reject",
        gate: GATE.LANGUAGE,
        reason: `review gate: language non-english (${decision.detection.reason})`,
        detection: decision.detection,
      };
    }
  }

  const q = quality ?? {};
  if (q.enabled !== false) {
    const maxMojibake = Number.isFinite(q.maxMojibakeRatio) ? q.maxMojibakeRatio : DEFAULT_MAX_MOJIBAKE_RATIO;
    const mojibake = mojibakeRatio(body);
    if (mojibake > maxMojibake) {
      return {
        decision: "reject",
        gate: GATE.QUALITY,
        reason: `review gate: encoding corruption (mojibake ratio ${mojibake.toFixed(3)})`,
        metrics: { mojibakeRatio: mojibake },
      };
    }
    const minBigram = Number.isFinite(q.minBigramRatio) ? q.minBigramRatio : DEFAULT_MIN_BIGRAM_RATIO;
    const bigram = repetitionPenalty(body);
    if (wordCount(body) >= MIN_WORDS_FOR_REPETITION && bigram < minBigram) {
      return {
        decision: "reject",
        gate: GATE.QUALITY,
        reason: `review gate: degenerate repetition (bigram ratio ${bigram.toFixed(3)})`,
        metrics: { bigramRatio: bigram },
      };
    }
  }

  return { decision: "proceed", gate: null, reason: null };
}
