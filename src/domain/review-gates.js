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
 *
 * An EMPTY string is degenerate (0), but a non-empty string with NO ASCII words
 * (e.g. non-Latin script) is NOT repetition: it returns neutral 1.0 so callers
 * never spuriously zero a critic score — rejecting non-English text is the
 * language gate's job, not the repetition metric's.
 */
export function repetitionPenalty(text) {
  const s = String(text ?? "");
  const words = s.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  if (words.length === 0) return s.trim().length === 0 ? 0 : 1;
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
// Navigation/boilerplate markers are used as DENSITY signals, never as a
// blanket substring ban: one "Home" in a long article is not navigation.
const NAV_MARKERS = /(^|\n)\s*(home|login|log in|sign in|sign up|register|menu|search|privacy|terms|terms of use|cookie policy|copyright|all rights reserved|share|subscribe|advertisement|skip to content)\b/gi;
const REFERENCE_MARKERS = /(\breferences?\b|\bbibliography\b|\bcitations?\b|\bfurther reading\b|^\s*\[\d+\]|\bdoi:\s*10\.|\bhttps?:\/\/|^\s*\d+\.\s|^\s*-\s)/gim;

/** Count terminal sentence boundaries (., ! or ? followed by space/end). */
function sentenceCount(text) {
  const s = String(text ?? "").trim();
  if (!s) return 0;
  const matches = s.match(/[.!?]+(?=\s|$)/g);
  return matches ? matches.length : 0;
}

function lineCount(text) {
  return String(text ?? "").split(/\r?\n/).filter((l) => l.trim()).length;
}

/**
 * Deterministic COMPLETENESS signals.
 *
 * This is the pre-review signal that distinguishes prose from a title, a
 * heading, a citation/reference list, navigation text or a metadata block. It
 * is pure and explainable: the same text always yields the same metrics and the
 * same advisory decision. It does NOT run the critic.
 */
export function assessCompleteness(text) {
  const s = String(text ?? "");
  const trimmed = s.trim();
  const chars = trimmed.length;
  const words = (trimmed.match(/[A-Za-z0-9']+/g) ?? []).length;
  const alpha = (trimmed.match(/[A-Za-z]/g) ?? []).length;
  const sentences = sentenceCount(trimmed);
  const refMarkers = (trimmed.match(REFERENCE_MARKERS) ?? []).length;
  const navLines = (trimmed.match(NAV_MARKERS) ?? []).length;
  const urlMatches = (trimmed.match(/\bhttps?:\/\//gi) ?? []).length;
  const lines = lineCount(trimmed);
  const wordsPerSentence = sentences > 0 ? words / sentences : words;
  const referenceDensity = words > 0 ? refMarkers / Math.max(1, lines) : 0;
  const navDensity = lines > 0 ? navLines / lines : 0;
  const metrics = {
    chars, words, sentences, lines, wordsPerSentence,
    refMarkers, navLines, urls: urlMatches, alphaRatio: chars ? alpha / chars : 0,
    referenceDensity, navDensity,
  };

  // Hard reject: no usable prose at all.
  if (chars < 20 || words < 3) {
    return { decision: "reject", reason: "no substantive text (too short to contain a sentence)", metrics };
  }
  if (sentences === 0 && words < 12) {
    return { decision: "reject", reason: "no sentence structure (title/heading/citation-like fragment)", metrics };
  }
  if (sentences === 0 && referenceDensity >= 0.5 && refMarkers >= 2) {
    return { decision: "reject", reason: "reference/citation list without prose", metrics };
  }
  if (sentences === 0 && navDensity >= 0.5 && navLines >= 2) {
    return { decision: "reject", reason: "navigation/boilerplate block without prose", metrics };
  }
  // Quarantine (reversible): borderline short or list-heavy text that may be a
  // legitimate concise passage. Never terminal on its own.
  if (sentences <= 1 && words < 30) {
    return { decision: "quarantine", reason: "very short prose; review before training", metrics };
  }
  if (referenceDensity >= 0.5 && words < 60) {
    return { decision: "quarantine", reason: "reference-dense short text", metrics };
  }
  return { decision: "proceed", reason: null, metrics };
}

export function preScreen(text, { sourceUrl = null, htmlLang = null, languageFilter = null, quality = null, completeness = null } = {}) {
  const body = String(text ?? "");
  const completenessResult = assessCompleteness(body);
  const completenessMode = String(completeness?.mode ?? "shadow").toLowerCase();
  // Shadow is the default: signals are recorded on the review record but never
  // change the verdict until the gate has been calibrated on labelled fixtures.
  if (completenessMode === "enforce" && completenessResult.decision !== "proceed") {
    return {
      decision: "reject",
      gate: "completeness",
      reason: `review gate: ${completenessResult.reason}`,
      metrics: completenessResult.metrics,
      completeness: completenessResult,
    };
  }

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

  return { decision: "proceed", gate: null, reason: null, completeness: completenessResult };
}
