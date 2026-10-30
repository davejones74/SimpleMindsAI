import { contentHash } from "../domain/article.js";
import { preScreen } from "../domain/review-gates.js";
import { config } from "../config.js";
import { publisherFromUrl, normalizeSourceUrl } from "./partition.js";
import { evaluateCorpusLanguage } from "./language-policy.js";

export const CORPUS_MODES = Object.freeze(["fragment", "raw-text"]);
export const CORPUS_TEXT_SOURCES = Object.freeze(["text", "rawText", "rawText-fallback"]);

const SKIP_LINE = /^(toggle\b|jump to content\b|main menu\b|navigation\b|contribute\b|tools\b|appearance\b|search\b|donate\b|create account\b|log in\b|personal tools\b|contents\b|move to sidebar\b|hide\b|for the .* see\b|from wikipedia, the free encyclopedia\b|wikimedia commons has media\b)/i;
const REFERENCE_MARK = /\[\s*(?:\d+|edit|citation needed|a|b|c|d)\s*\]/gi;
const SPACE_BEFORE_PUNCT = /\s+([,.;:!?])/g;
const MULTISPACE = /\s+/g;
const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”",
  mdash: "—", ndash: "–", copy: "©", reg: "®", trade: "™",
};

export function decodeEntities(text) {
  return String(text ?? "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body) => {
    if (body[0] === "#") {
      const hex = body[1]?.toLowerCase() === "x";
      const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

export function normalizeCorpusLine(line) {
  let value = String(line ?? "").replace(MULTISPACE, " ").trim();
  value = value.replace(REFERENCE_MARK, "");
  value = value.replace(SPACE_BEFORE_PUNCT, "$1");
  return value.replace(MULTISPACE, " ").trim();
}

function proseRatio(line) {
  const letters = [...line].filter((ch) => /[\p{L}\s]/u.test(ch)).length;
  return letters / Math.max(1, [...line].length);
}

export function sentenceRatio(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return 0;
  const complete = lines.filter((line) => /[.!?"']$/.test(line)).length;
  return complete / lines.length;
}

export function buildCommonLines(articles, { threshold = config.trainCorpusCommonLineDocs } = {}) {
  const counts = new Map();
  const minimum = Math.max(2, Number(threshold) || 2);
  for (const article of articles) {
    const raw = typeof article?.rawText === "string" ? article.rawText : "";
    if (!raw) continue;
    const seen = new Set();
    for (const line of decodeEntities(raw).split(/\r?\n/)) {
      const normalized = normalizeCorpusLine(line);
      if (normalized.length >= 40) seen.add(normalized);
    }
    for (const line of seen) counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  const common = new Set();
  for (const [line, count] of counts) if (count >= minimum) common.add(line);
  return common;
}

export function cleanRawText(rawText, {
  commonLines = new Set(),
  minChars = config.trainCorpusMinChars,
  minSentenceRatio = config.trainCorpusMinSentenceRatio,
} = {}) {
  const kept = [];
  for (const rawLine of decodeEntities(rawText).split(/\r?\n/)) {
    const line = normalizeCorpusLine(rawLine);
    if (line.length < 40) continue;
    if (commonLines.has(line)) continue;
    if (SKIP_LINE.test(line)) continue;
    if (proseRatio(line) < 0.65) continue;
    kept.push(line);
  }
  const text = kept.join("\n");
  const ratio = sentenceRatio(text);
  if (text.length < minChars || ratio < minSentenceRatio) {
    return { text, chars: text.length, sentenceRatio: ratio, accepted: false };
  }
  return { text, chars: text.length, sentenceRatio: ratio, accepted: true };
}

export function curationGateOptions(article) {
  return {
    sourceUrl: article?.sourceUrl ?? null,
    htmlLang: article?.htmlLang ?? null,
    languageFilter: config.languageFilter ?? null,
    quality: {
      enabled: true,
      minBigramRatio: config.review.qualityMinBigramRatio,
      maxMojibakeRatio: config.review.qualityMaxMojibakeRatio,
    },
    completeness: { mode: config.review.completenessMode ?? "shadow" },
  };
}

export function corpusTextForArticle(article, {
  mode = config.trainCorpusMode,
  commonLines = new Set(),
  minChars = config.trainCorpusMinChars,
  minSentenceRatio = config.trainCorpusMinSentenceRatio,
} = {}) {
  if (mode === "fragment") {
    return { text: String(article?.text ?? ""), source: "text", reason: null, chars: String(article?.text ?? "").length };
  }
  const rawText = typeof article?.rawText === "string" ? article.rawText : "";
  if (rawText.trim()) {
    const cleaned = cleanRawText(rawText, { commonLines, minChars, minSentenceRatio });
    if (cleaned.accepted) {
      return { text: cleaned.text, source: "rawText", reason: null, chars: cleaned.chars, sentenceRatio: cleaned.sentenceRatio };
    }
    return {
      text: String(article?.text ?? ""),
      source: "rawText-fallback",
      reason: cleaned.text.length < minChars ? "raw-too-short" : "raw-low-sentence-ratio",
      chars: String(article?.text ?? "").length,
      rawChars: cleaned.chars,
      sentenceRatio: cleaned.sentenceRatio,
    };
  }
  return { text: String(article?.text ?? ""), source: "text", reason: "no-raw-text", chars: String(article?.text ?? "").length };
}

export function corpusRowForArticle(article, {
  mode = config.trainCorpusMode,
  corpusRole = "train",
  commonLines = new Set(),
  minChars = config.trainCorpusMinChars,
  minSentenceRatio = config.trainCorpusMinSentenceRatio,
  suppressRawText = false,
  supportedLanguages = config.trainSupportedLanguages,
  languageMinConfidence = config.trainLanguageMinConfidence,
  languageUnknownPolicy = config.trainLanguageUnknownPolicy,
} = {}) {
  // A source with several curated chunks must not be incorporated as several
  // full copies of the same raw article. The caller chooses one representative
  // full-text row per source; other chunks remain useful curated text.
  const effectiveMode = suppressRawText ? "fragment" : mode;
  const selected = corpusTextForArticle(article, {
    mode: effectiveMode,
    commonLines,
    minChars,
    minSentenceRatio,
  });
  const hash = contentHash(selected.text);
  const sourceId = article.fetchedContentHash
    || normalizeSourceUrl(article.sourceUrl)
    || article.articleId;
  const publisherId = article.sourceDomain
    || publisherFromUrl(article.sourceUrl)
    || "unknown";
  const language = evaluateCorpusLanguage(selected.text, {
    htmlLang: article.htmlLang ?? null,
    sourceUrl: article.sourceUrl ?? null,
    supportedLanguages,
    minConfidence: languageMinConfidence,
    unknownPolicy: languageUnknownPolicy,
  });
  const qualityTier = selected.source === "rawText"
    ? "full-text"
    : selected.source === "rawText-fallback"
      ? "fallback"
      : "curated";
  const row = {
    articleId: article.articleId,
    contentHash: hash,
    text: selected.text,
    domain: article.domain ?? "general",
    importance: article.importance ?? "Normal",
    origin: article.origin ?? "curated",
    createdAt: article.createdAt ?? new Date().toISOString(),
    ...(corpusRole && corpusRole !== "train" ? { corpusRole } : {}),
    ...(article.sourceUrl ? { sourceUrl: article.sourceUrl } : {}),
    ...(article.fetchedContentHash ? { fetchedContentHash: article.fetchedContentHash } : {}),
    ...(article.model ? { teacherModel: article.model } : {}),
    ...(effectiveMode !== "fragment" || selected.source !== "text"
      ? { corpusMode: effectiveMode, corpusTextSource: selected.source }
      : {}),
    sourceId,
    publisherId,
    qualityTier,
    estimatedTokens: Math.ceil(selected.text.length / 4),
    rawTextSuppressed: Boolean(suppressRawText && article.rawText),
    language: language.language,
    languageConfidence: language.confidence,
    languageReason: language.reason,
    languageEligible: language.eligible,
    languagePolicyVersion: language.policyVersion,
  };
  return { row, selected, gate: preScreen(selected.text, curationGateOptions(article)), language };
}
