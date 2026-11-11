import { STOPWORDS } from "./tokens.js";

/**
 * Mission -> deterministic collection focus profile.
 *
 * The mission statement is not just a label: it selects WHICH candidate URLs are
 * worth fetching. This module derives a small, explainable vocabulary from the
 * active mission (and optional strategy focus settings) and scores candidates
 * BEFORE they enter the frontier. It deliberately does not inspect articles after
 * they have already been fetched.
 */

export const LANGUAGE_MECHANICS_TERMS = Object.freeze([
  "language", "grammar", "syntax", "punctuation", "sentence", "sentences",
  "paragraph", "paragraphs", "prose", "writing", "style", "clarity",
  "linguistics", "rhetoric", "clause", "clauses", "discourse", "usage",
  "editing", "copyediting", "semantics", "morphology", "phonology",
  "orthography", "lexicon", "vocabulary", "composition", "text", "texts",
]);

export const LANGUAGE_MECHANICS_PHRASES = Object.freeze([
  "sentence structure", "sentence boundary", "sentence boundaries",
  "sentence ending", "sentence endings", "paragraph structure",
  "paragraph coherence", "english grammar", "english usage",
  "language mechanics", "writing style", "clear prose", "complete sentences",
  "well formed prose", "syntactic structure", "discourse structure",
]);

const DEFAULT_FOCUS = Object.freeze({
  mode: "off",
  languageShare: 0.8,
  broadShare: 0.2,
  minScore: 0.08,
});

function words(text) {
  const out = [];
  const seen = new Set();
  for (const w of String(text ?? "").toLowerCase().match(/[a-z][a-z0-9'-]*/g) ?? []) {
    if (w.length < 3 || STOPWORDS.has(w) || /^\d+$/.test(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

function phrasesFromWords(ws) {
  const out = [];
  const seen = new Set();
  for (let i = 0; i + 1 < ws.length; i++) {
    const p = `${ws[i]} ${ws[i + 1]}`;
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

function normList(value) {
  return (Array.isArray(value) ? value : []).map((v) => String(v ?? "").trim().toLowerCase()).filter(Boolean);
}

/**
 * @param {object} opts
 * @param {string|string[]} [opts.missionTexts]
 * @param {object|null} [opts.strategy] - active strategy record (or its `.strategy`)
 * @param {object} [opts.focus] - { mode, languageShare, broadShare, minScore }
 */
export function createMissionProfile({
  missionTexts = [],
  strategy = null,
  focus = null,
} = {}) {
  const strategyFocus = strategy && typeof strategy === "object" ? (strategy.focus ?? strategy.strategy?.focus ?? null) : null;
  const cfg = { ...DEFAULT_FOCUS, ...(strategyFocus || {}), ...(focus || {}) };
  const texts = (Array.isArray(missionTexts) ? missionTexts : [missionTexts]).filter((t) => typeof t === "string" && t.trim());
  const missionWords = words(texts.join(" "));
  const hasLanguageFocus = /language|grammar|syntax|punctuation|sentence|paragraph|prose|writing|style|linguistic|rhetoric/i.test(texts.join(" "));
  const terms = [...new Set([
    ...missionWords.slice(0, 30),
    ...(hasLanguageFocus ? LANGUAGE_MECHANICS_TERMS : []),
    ...normList(cfg.topics),
  ])];
  const phrases = [...new Set([
    ...phrasesFromWords(missionWords).slice(0, 20),
    ...(hasLanguageFocus ? LANGUAGE_MECHANICS_PHRASES : []),
    ...normList(cfg.phrases),
  ])];
  const mode = ["off", "shadow", "weighted", "enforce"].includes(String(cfg.mode).toLowerCase())
    ? String(cfg.mode).toLowerCase()
    : "off";
  const languageShare = Math.max(0, Math.min(1, Number(cfg.languageShare) || 0.8));
  const broadShare = Math.max(0, Math.min(1, Number(cfg.broadShare) || 1 - languageShare));
  const minScore = Math.max(0, Math.min(1, Number(cfg.minScore) || 0.08));
  return {
    schema: "sma/mission-profile@1",
    mode,
    languageShare,
    broadShare,
    minScore,
    terms,
    phrases,
    missionTexts: texts,
    prompt: terms.length
      ? `Mission focus: prefer complete English prose demonstrating ${terms.slice(0, 12).join(", ")}. ` +
        `Keep roughly ${Math.round(languageShare * 100)}% of acquisition focused on these language mechanics and ${Math.round(broadShare * 100)}% broad, high-quality prose.`
      : null,
  };
}

export function normalizeFocusText(text) {
  return String(text ?? "").toLowerCase().replace(/[\s_/?#=&.-]+/g, " ").trim();
}

/** Deterministic 0..1 relevance score for text/URL/title. */
export function scoreFocusText(text, profile) {
  if (!profile || profile.mode === "off") return 1;
  const s = ` ${normalizeFocusText(text)} `;
  if (!s.trim()) return 0;
  let phraseHits = 0;
  for (const p of profile.phrases) if (s.includes(` ${p} `)) phraseHits++;
  let termHits = 0;
  for (const t of profile.terms) if (s.includes(` ${t} `)) termHits++;
  const denom = Math.max(1, Math.min(12, profile.phrases.length + profile.terms.length));
  return Math.min(1, (phraseHits * 2 + termHits) / denom);
}

/**
 * 80/20 focus gate. The broad quota is enforced on the candidate stream, not on
 * already-captured articles.
 */
export function gateFocusCandidate(profile, { url = "", text = "", counts = null } = {}) {
  if (!profile || profile.mode === "off") return { allow: true, kind: "off", score: 1 };
  const score = scoreFocusText(`${url} ${text}`, profile);
  const focus = score >= profile.minScore;
  if (profile.mode === "shadow") return { allow: true, kind: focus ? "focus" : "broad", score, shadow: true };
  if (focus) {
    if (counts) counts.focus++;
    return { allow: true, kind: "focus", score };
  }
  if (profile.mode === "enforce") {
    if (counts) counts.rejected++;
    return { allow: false, kind: "rejected", score };
  }
  if (!counts) return { allow: true, kind: "broad", score };
  const allowedBroad = Math.max(1, Math.floor((counts.focus * profile.broadShare) / Math.max(0.01, 1 - profile.broadShare)));
  if (counts.broad >= allowedBroad) {
    counts.rejected++;
    return { allow: false, kind: "rejected", score };
  }
  counts.broad++;
  return { allow: true, kind: "broad", score };
}
