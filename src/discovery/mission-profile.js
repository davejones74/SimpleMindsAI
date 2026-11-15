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

export const LANGUAGE_MECHANICS_STRONG_TERMS = Object.freeze([
  "grammar", "syntax", "punctuation", "sentence", "sentences", "paragraph",
  "paragraphs", "prose", "linguistics", "rhetoric", "clause", "clauses",
  "discourse", "semantics", "morphology", "phonology", "orthography",
  "lexicography", "etymology", "syntactic", "morphological", "phonological",
  "semantic", "grammatical", "ungrammatical",
]);

export const LANGUAGE_MECHANICS_WEAK_TERMS = Object.freeze([
  "language", "writing", "style", "clarity", "usage", "editing",
  "copyediting", "lexicon", "vocabulary", "composition", "text", "texts",
]);

export const LANGUAGE_MECHANICS_STRONG_PHRASES = Object.freeze([
  "sentence structure", "sentence boundary", "sentence boundaries",
  "sentence ending", "sentence endings", "paragraph structure",
  "paragraph coherence", "english grammar", "language mechanics",
  "clear prose", "complete sentences", "well formed prose",
  "syntactic structure", "discourse structure", "dependent clause",
  "independent clause", "subject verb agreement", "parts of speech",
  "verb tense", "grammatical error", "grammaticality judgement",
  "language acquisition", "language change", "semantic ambiguity",
  "discourse marker",
]);

export const COMMERCIAL_NEGATIVE_TERMS = Object.freeze([
  "pricing", "price", "prices", "buy", "purchase", "subscribe", "subscription",
  "trial", "demo", "coupon", "discount", "affiliate", "crm", "gadget",
  "headset", "stylus", "salary", "salaries", "jobs", "careers", "hiring",
  "recruitment", "catalogue", "catalog", "checkout", "cart",
]);

export const TECHNICAL_NEGATIVE_TERMS = Object.freeze([
  "nlp", "embedding", "embeddings", "pytorch", "tensorflow", "transformer",
  "transformers", "neural", "software", "python", "tensor", "api", "dataset",
  "datasets", "benchmark", "model", "models",
]);

export const TECHNICAL_NEGATIVE_PHRASES = Object.freeze([
  "sentence transformer", "sentence transformers", "sentence-transformers",
  "sentence embeddings", "semantic search", "natural language processing",
  "language model", "large language model", "machine learning", "deep learning",
  "programming language", "source code", "neural network", "data science",
  "information retrieval", "knowledge distillation", "text classification",
]);

export const COMMERCIAL_NEGATIVE_PHRASES = Object.freeze([
  "text to speech", "text-to-speech", "speech synthesis", "customer relationship management",
  "free trial", "book a demo", "contact sales", "best crm", "top crm",
  "software comparison", "product comparison", "buy now", "add to cart",
  "pricing plans", "subscription plans", "affiliate program",
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
  const strongTerms = [...new Set([
    ...(hasLanguageFocus ? LANGUAGE_MECHANICS_STRONG_TERMS : []),
    ...normList(cfg.strongTerms),
  ])];
  const weakTerms = [...new Set([
    ...(hasLanguageFocus ? LANGUAGE_MECHANICS_WEAK_TERMS : []),
    ...normList(cfg.weakTerms),
  ])];
  const strongPhrases = [...new Set([
    ...(hasLanguageFocus ? LANGUAGE_MECHANICS_STRONG_PHRASES : []),
    ...normList(cfg.strongPhrases),
  ])];
  const negativeTerms = [...new Set([
    ...(hasLanguageFocus ? COMMERCIAL_NEGATIVE_TERMS : []),
    ...(hasLanguageFocus ? TECHNICAL_NEGATIVE_TERMS : []),
    ...normList(cfg.negativeTerms),
  ])];
  const negativePhrases = [...new Set([
    ...(hasLanguageFocus ? COMMERCIAL_NEGATIVE_PHRASES : []),
    ...(hasLanguageFocus ? TECHNICAL_NEGATIVE_PHRASES : []),
    ...normList(cfg.negativePhrases),
  ])];
  const mode = ["off", "shadow", "weighted", "enforce"].includes(String(cfg.mode).toLowerCase())
    ? String(cfg.mode).toLowerCase()
    : "off";
  const languageShare = Math.max(0, Math.min(1, Number(cfg.languageShare) || 0.8));
  const broadShare = Math.max(0, Math.min(1, Number(cfg.broadShare) || 1 - languageShare));
  const minScore = Math.max(0, Math.min(1, Number(cfg.minScore) || 0.08));
  return {
    schema: "sma/mission-profile@2",
    policyVersion: String(cfg.policyVersion ?? "focus-v2"),
    mode,
    languageShare,
    broadShare,
    minScore,
    requireStrongSignal: cfg.requireStrongSignal !== false,
    terms,
    phrases,
    strongTerms,
    weakTerms,
    strongPhrases,
    negativeTerms,
    negativePhrases,
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

function countHits(s, list) {
  const hits = [];
  for (const value of list ?? []) {
    const needle = String(value ?? "").trim().toLowerCase();
    if (!needle) continue;
    if (s.includes(` ${needle} `)) hits.push(needle);
  }
  return hits;
}

/**
 * Explainable focus decision. A generic term such as "text" or "style" is only
 * a weak signal; it can never qualify a candidate on its own. Strong subject
 * terms or phrases are required, and commercial/product signals subtract from
 * the score. The returned reasons are persisted for audit/shadow comparison.
 */
export function explainFocusText(text, profile) {
  if (!profile || profile.mode === "off") {
    return {
      policyVersion: profile?.policyVersion ?? "focus-off",
      score: 1,
      qualified: true,
      signals: [],
      negativeSignals: [],
      strongSignals: 0,
      weakSignals: 0,
      threshold: profile?.minScore ?? 0,
    };
  }
  const s = ` ${normalizeFocusText(text)} `;
  if (!s.trim()) {
    return {
      policyVersion: profile.policyVersion ?? "focus-v2",
      score: 0,
      qualified: false,
      signals: [],
      negativeSignals: [],
      strongSignals: 0,
      weakSignals: 0,
      threshold: profile.minScore,
    };
  }
  const strongPhrases = countHits(s, profile.strongPhrases ?? profile.phrases);
  const strongTerms = countHits(s, profile.strongTerms ?? profile.terms ?? []);
  const weakTerms = countHits(s, profile.weakTerms ?? []);
  const negativePhrases = countHits(s, profile.negativePhrases ?? []);
  const negativeTerms = countHits(s, profile.negativeTerms ?? []);

  const strongSignals = strongPhrases.length + strongTerms.length;
  const weakSignals = weakTerms.length;
  const negative = negativePhrases.length + negativeTerms.length;
  const raw = strongPhrases.length * 3 + strongTerms.length * 2 + weakTerms.length * 0.35;
  const penalty = negativePhrases.length * 3 + negativeTerms.length * 2;
  const score = Math.max(0, Math.min(1, (raw - penalty) / 6));
  const qualified = (!profile.requireStrongSignal || strongSignals > 0) && score >= profile.minScore;
  return {
    policyVersion: profile.policyVersion ?? "focus-v2",
    score,
    qualified,
    signals: [...strongPhrases.map((v) => `phrase:${v}`), ...strongTerms.map((v) => `term:${v}`), ...weakTerms.map((v) => `weak:${v}`)],
    negativeSignals: [...negativePhrases.map((v) => `phrase:${v}`), ...negativeTerms.map((v) => `term:${v}`)],
    strongSignals,
    weakSignals,
    threshold: profile.minScore,
  };
}

/** Deterministic 0..1 relevance score for text/URL/title. */
export function scoreFocusText(text, profile) {
  return explainFocusText(text, profile).score;
}

/** Legacy v1 score, retained only for shadow comparisons and tests. */
export function scoreFocusTextLegacy(text, profile) {
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
  const decision = explainFocusText(`${url} ${text}`, profile);
  const legacyScore = scoreFocusTextLegacy(`${url} ${text}`, profile);
  const focus = decision.qualified;
  const shadow = profile.mode === "shadow";
  const legacyFocus = legacyScore >= profile.minScore;
  const audit = {
    policyVersion: decision.policyVersion,
    score: decision.score,
    threshold: decision.threshold,
    signals: decision.signals,
    negativeSignals: decision.negativeSignals,
    strongSignals: decision.strongSignals,
    weakSignals: decision.weakSignals,
    legacyScore,
    legacyFocus,
    shadow,
  };
  if (shadow) return { allow: true, kind: focus ? "focus" : "broad", score: decision.score, shadow: true, audit };
  if (focus) {
    if (counts) counts.focus++;
    return { allow: true, kind: "focus", score: decision.score, audit };
  }
  if (profile.mode === "enforce") {
    if (counts) counts.rejected++;
    return { allow: false, kind: "rejected", score: decision.score, audit };
  }
  if (!counts) return { allow: true, kind: "broad", score: decision.score, audit };
  const allowedBroad = Math.max(1, Math.floor((counts.focus * profile.broadShare) / Math.max(0.01, 1 - profile.broadShare)));
  if (counts.broad >= allowedBroad) {
    counts.rejected++;
    return { allow: false, kind: "rejected", score: decision.score, audit };
  }
  counts.broad++;
  return { allow: true, kind: "broad", score: decision.score, audit };
}
