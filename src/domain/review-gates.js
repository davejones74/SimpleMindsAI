/**
 * Review-time quality gates — deterministic, dependency-free.
 *
 * These run in the review lifecycle BEFORE the LLM critic, because the critic is
 * language-blind: it can score a French article, encoding-corrupted text, or a
 * catalogue/navigation shell as "useful" on content alone. The gates separate
 * the concerns the operator asked for:
 *
 *   - LANGUAGE (a decision, may reject): judged on the ACTUAL training text via
 *     the shared detector, with `<html lang>` / multilingual-host declarations as
 *     supplementary evidence. A valid English TRANSLATION is judged on its
 *     English text and passes — provenance alone is never a rejection rule.
 *   - QUALITY (a decision, may reject): encoding corruption (mojibake) and
 *     degenerate repetition that survived cleaning.
 *   - PAGE CHROME (a decision, may reject): a high-confidence navigation /
 *     catalogue shell (especially archive.org details pages) that contains
 *     enough words to look like prose.
 *   - MISSION: NOT here — relevance is advisory only and must never reject an
 *     otherwise valid article. It belongs to selection, not to this gate.
 *
 * Every gate is reversible through configuration: disabling the language filter,
 * the quality gate, or the whole gate set restores prior behaviour exactly.
 */

import { assess, detectLanguage } from "./language.js";

export const GATE = Object.freeze({ LANGUAGE: "language", QUALITY: "quality", PAGE_CHROME: "page-chrome", CONTENT: "content" });

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

/**
 * High-confidence catalogue/navigation-shell detection.
 *
 * A details page can contain hundreds of words, sentence-like metadata lines and
 * a healthy bigram ratio, so the prose completeness gate alone cannot reject it.
 * This gate only fires on a STRONG cluster of page-chrome markers, never on one
 * incidental word. It is therefore safe to enforce while completeness remains
 * shadow-calibrated.
 */
const ARCHIVE_CHROME_MARKERS = [
  "uploaded by",
  "digitizing sponsor",
  "download options",
  "read in browser",
  "borrow this item",
  "possible copyright status",
  "access-restricted-item",
  "full text",
  "scanner",
  "identifier",
  "view in",
  "page numbers",
  "contributor",
];
const ARCHIVE_SPECIFIC_MARKERS = new Set([
  "uploaded by",
  "digitizing sponsor",
  "download options",
  "read in browser",
  "borrow this item",
  "possible copyright status",
  "access-restricted-item",
]);

function sourceHost(sourceUrl) {
  try {
    return new URL(String(sourceUrl)).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function assessPageChrome(text, { sourceUrl = null } = {}) {
  const s = String(text ?? "");
  const trimmed = s.trim();
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
  const lower = trimmed.toLowerCase();
  const archiveHits = ARCHIVE_CHROME_MARKERS.filter((marker) => lower.includes(marker));
  const archiveSpecificHits = archiveHits.filter((marker) => ARCHIVE_SPECIFIC_MARKERS.has(marker)).length;
  const navLines = (trimmed.match(NAV_MARKERS) ?? []).length;
  const urls = (trimmed.match(/\bhttps?:\/\//gi) ?? []).length;
  const words = wordCount(trimmed);
  const navDensity = lines.length ? navLines / lines.length : 0;
  const urlDensity = words ? urls / words : 0;
  const shortLines = lines.filter((l) => l.trim().length <= 48).length;
  const shortLineRatio = lines.length ? shortLines / lines.length : 0;
  const host = sourceHost(sourceUrl);
  const metrics = {
    lines: lines.length,
    words,
    navLines,
    navDensity,
    urls,
    urlDensity,
    shortLineRatio,
    archiveHits,
    archiveSpecificHits,
  };

  const archiveHost = host === "archive.org";
  if (archiveHost && archiveSpecificHits >= 2 && archiveHits.length >= 3) {
    return {
      decision: "reject",
      reason: `archive.org details/catalogue chrome (${archiveHits.length} markers)`,
      metrics,
    };
  }
  if (archiveHost && archiveHits.length >= 2 && urlDensity >= 0.02 && words < 2000) {
    return {
      decision: "reject",
      reason: "archive.org download/metadata chrome",
      metrics,
    };
  }
  if (navDensity >= 0.35 && urlDensity >= 0.15 && lines.length >= 8) {
    return {
      decision: "reject",
      reason: "navigation/link shell without substantive prose",
      metrics,
    };
  }
  if (shortLineRatio >= 0.8 && urlDensity >= 0.1 && navDensity >= 0.15 && words < 600) {
    return {
      decision: "reject",
      reason: "short-line navigation/catalogue block",
      metrics,
    };
  }
  return { decision: "proceed", reason: null, metrics };
}


const CONTENT_REFERENCE_LINE = /(retrieved|archived from|isbn|doi:|issn|oclc|\bpp?\.\s*\d|\bvol\.\s*\d|\bpress\b|\bjournal\b|encyclop|bibliography|references?|further reading|external links?|citations?)/i;
const CONTENT_LIST_LINE = /^\s*(?:[\d↑•*\-–—]+[\.\)]?\s+|[A-Z][a-z]+:\s*)/;
const CONTENT_NAV_START = /^(jump to content|main menu|navigation|neidio|prif ddewislen|zum inhalt|aller au contenu|menú principal|contenido|ir al contenido|skip to content|navigate)\b/i;

/**
 * Deterministic content-type gate. The teacher critic is good at judging prose
 * it is shown, but it cannot know that the "article" is actually a bibliography,
 * a table of party names, a navigation shell, or a 121-character citation. This
 * gate rejects those before the critic and before they can become training text.
 *
 * It is intentionally conservative: it fires only when the defect dominates the
 * whole unit, not when a real article contains a reference or a heading.
 */
export function assessContentQuality(text, {
  minWords = 60,
  referenceLineRatio = 0.5,
  listLineRatio = 0.6,
  navDensity = 0.25,
} = {}) {
  const s = String(text ?? "");
  const trimmed = s.trim();
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
  const words = wordCount(trimmed);
  const sentences = sentenceCount(trimmed);
  const referenceLines = lines.filter((l) => CONTENT_REFERENCE_LINE.test(l)).length;
  const listLines = lines.filter((l) => CONTENT_LIST_LINE.test(l.trim())).length;
  const navLines = lines.filter((l) => { NAV_MARKERS.lastIndex = 0; return NAV_MARKERS.test(l); }).length;
  const proseLines = lines.filter((l) => l.split(/\s+/).length >= 5 && !CONTENT_REFERENCE_LINE.test(l) && !CONTENT_LIST_LINE.test(l.trim())).length;
  const refRatio = lines.length ? referenceLines / lines.length : 0;
  const listRatio = lines.length ? listLines / lines.length : 0;
  const navRatio = lines.length ? navLines / lines.length : 0;
  const proseLineRatio = lines.length ? proseLines / lines.length : 0;
  const metrics = { chars: trimmed.length, words, sentences, lines: lines.length, referenceLines, refRatio, listLines, listRatio, navLines, navRatio, proseLineRatio };

  if (words < Math.max(1, Number(minWords) || 0)) {
    return { decision: "reject", reason: `content: fragment too short (${words} word(s), need ${minWords})`, metrics };
  }
  if (lines.length >= 2 && refRatio >= referenceLineRatio && referenceLines >= 2) {
    return { decision: "reject", reason: `content: reference/citation list (${referenceLines}/${lines.length} lines)`, metrics };
  }
  if (referenceLines >= 3 && words < 160) {
    return { decision: "reject", reason: `content: citation-heavy fragment (${referenceLines} reference lines, ${words} words)`, metrics };
  }
  if (lines.length >= 2 && listRatio >= listLineRatio && sentences <= 3) {
    return { decision: "reject", reason: `content: list/table without prose (${listLines}/${lines.length} lines)`, metrics };
  }
  if (lines.length >= 4 && proseLineRatio < 0.4 && words < 400) {
    return { decision: "reject", reason: `content: mostly references/lists/navigation (prose line ratio ${proseLineRatio.toFixed(2)})`, metrics };
  }
  const firstLine = lines[0]?.trim() ?? "";
  if ((firstLine.length <= 60 && CONTENT_NAV_START.test(firstLine)) || (lines.length >= 8 && navRatio >= navDensity)) {
    return { decision: "reject", reason: `content: navigation/page-chrome shell (${navLines}/${lines.length} nav lines)`, metrics };
  }
  if (sentences <= 1 && words >= Math.max(1, Number(minWords) || 0)) {
    return { decision: "reject", reason: "content: no coherent multi-sentence prose", metrics };
  }
  return { decision: "proceed", reason: null, metrics };
}

export function preScreen(text, {
  sourceUrl = null,
  htmlLang = null,
  languageFilter = null,
  quality = null,
  completeness = null,
  pageChrome = null,
  content = null,
} = {}) {
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

  if (pageChrome?.enabled !== false) {
    const chromeResult = assessPageChrome(body, { sourceUrl });
    if (chromeResult.decision === "reject") {
      return {
        decision: "reject",
        gate: GATE.PAGE_CHROME,
        reason: `review gate: ${chromeResult.reason}`,
        metrics: chromeResult.metrics,
        completeness: completenessResult,
      };
    }
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

  if (content?.enabled === true) {
    const contentResult = assessContentQuality(body, {
      minWords: content?.minWords,
      referenceLineRatio: content?.referenceLineRatio,
      listLineRatio: content?.listLineRatio,
      navDensity: content?.navDensity,
    });
    if (contentResult.decision === "reject") {
      return {
        decision: "reject",
        gate: GATE.CONTENT,
        reason: `review gate: ${contentResult.reason}`,
        metrics: contentResult.metrics,
        completeness: completenessResult,
      };
    }
  }

  return { decision: "proceed", gate: null, reason: null, completeness: completenessResult };
}
