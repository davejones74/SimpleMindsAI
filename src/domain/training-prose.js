/**
 * Training-prose eligibility.
 *
 * The operator clarified that "language focus" means well-formed English prose
 * and sentence/paragraph construction, not articles ABOUT language, programming
 * languages, language models or other metaphorical uses of the word. This gate
 * therefore judges prose quality and technical-page shape, not subject keywords.
 *
 * It deliberately leaves the mission/topic score to acquisition; a history or
 * science article with complete, coherent English is useful training material
 * even when it is not a linguistics article.
 */
import { assessContentQuality } from "./content-quality.js";

export const TRAINING_PROSE_POLICY_VERSION = "training-prose-v1";

const TECHNICAL_HOST = /^(?:docs?|developer|developers|api|reference|support)\./i;
const NON_PROSE_HOSTS = new Set(["geeksforgeeks.org", "www.geeksforgeeks.org", "atscale.com", "www.atscale.com"]);
const NON_PROSE_PATH = /(?:^|\/)(?:funding|opportunities|proposers|awards|use-cases?|resources?|solutions?|platforms?)(?:\/|$|-)/i;
const TECHNICAL_PATH = /(?:^|\/)(?:docs?|documentation|api|reference|examples?|install|download|developer|developers|readthedocs|github|gitlab|stackoverflow|pypi|npm|pytorch|tensorflow|sbert)(?:\/|$)/i;
const CODE_MARKER = /```|(?:^|\n)\s*(?:def|class|import|from|function|const|let|var|return|async|await|pip|npm)\b|(?:torch|numpy|tensorflow|pytorch|json)\.[A-Za-z]|\bhttps?:\/\//gi;
const RETAIL_MARKER = /\b(buy|price|pricing|sale|shop|shopping|cart|checkout|discount|coupon|leggings|pants|dress|shoes|outfit|fabric|cashmere|silk|retail|affiliate)\b/gi;
const TECHNICAL_TOPIC = /\b(programming language|source code|software|compiler|runtime|javascript|typescript|python|java|rust|c\+\+|algorithm|machine learning|neural network|dataset|embedding|embeddings|nlp|language model|api)\b/gi;

function words(text) {
  return (String(text ?? "").match(/[A-Za-z0-9']+/g) ?? []).length;
}
function sentenceCount(text) {
  return (String(text ?? "").match(/[.!?]+(?=\s|$)/g) ?? []).length;
}

export function assessTrainingProse({ url = "", title = "", text = "" } = {}) {
  const body = String(text ?? "");
  const quality = assessContentQuality({ url, title, text: body });
  const reasons = [];
  if (quality.decision !== "allow") reasons.push(...quality.reasons);
  let host = "";
  let path = String(url ?? "");
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase().replace(/^www\./, "");
    path = `${u.pathname}${u.search}`;
  } catch { /* tolerate fixtures without URLs */ }
  if (TECHNICAL_HOST.test(host) || TECHNICAL_PATH.test(path) || NON_PROSE_HOSTS.has(host) || NON_PROSE_PATH.test(path)) reasons.push("technical-page");
  const wordCount = words(body);
  const sentences = sentenceCount(body);
  const codeMarkers = (body.match(CODE_MARKER) ?? []).length;
  const retailMarkers = (body.match(RETAIL_MARKER) ?? []).length;
  const technicalMarkers = (body.match(TECHNICAL_TOPIC) ?? []).length;
  if (wordCount > 0 && codeMarkers / Math.max(1, wordCount / 500) >= 3) reasons.push("code-heavy");
  // Technical vocabulary alone is not a reason to reject coherent scientific
  // prose. Only treat it as non-prose when the source is also a documentation
  // host/path or contains code markers.
  const technicalShape = TECHNICAL_HOST.test(host) || TECHNICAL_PATH.test(path) || codeMarkers > 0;
  if (wordCount > 0 && technicalShape && technicalMarkers / Math.max(1, wordCount / 1000) >= 8) reasons.push("technical-topic");
  if (retailMarkers >= 4) reasons.push("retail-commercial");
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const completeLines = lines.filter((line) => /[.!?"']$/.test(line)).length;
  const lineSentenceRatio = lines.length ? completeLines / lines.length : 0;
  const wordsPerSentence = sentences ? wordCount / sentences : wordCount;
  // Extracted paragraphs often contain citation markers or headings on separate
  // lines. Do not call a long, well-formed article fragmented merely because its
  // line breaks are not sentence boundaries.
  if (lines.length >= 4 && lineSentenceRatio < 0.35 && wordsPerSentence < 10) reasons.push("fragmented-prose");
  if (wordCount < 100 || sentences < 3) reasons.push("insufficient-prose");
  return {
    policyVersion: TRAINING_PROSE_POLICY_VERSION,
    eligible: reasons.length === 0,
    reasons: [...new Set(reasons)],
    metrics: { words: wordCount, sentences, codeMarkers, retailMarkers, technicalMarkers, lineSentenceRatio, qualityScore: quality.score },
  };
}

export function isTrainingProseEligible(article) {
  return assessTrainingProse({
    url: article?.sourceUrl ?? "",
    title: article?.title ?? "",
    text: article?.text ?? "",
  }).eligible;
}
