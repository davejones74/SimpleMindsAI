import { OllamaClient } from "../services/ollama-client.js";
import { config } from "../config.js";
import { VERDICT } from "../domain/article.js";
import { authHeaders } from "../auth/simple-auth.js";
import { heuristicPenalty } from "../domain/review-gates.js";

const GRAPHQL_URL = process.env.GRAPHQL_URL ?? "http://localhost:4000/graphql";
const REVIEW_M = `
mutation Review($input: ReviewInput!) {
  recordReview(input: $input) { applied review { reviewId verdict score } article { articleId status } }
}
`;

async function gql(query, variables) {
  const body = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ query, variables }),
  });
  const json = await body.json();
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  return json.data;
}

/**
 * The teacher critic prompt.
 *
 * It is deliberately LANGUAGE- AND CORRUPTION-AWARE (defect D6): the critic used
 * to be blind to language and encoding, so it could score foreign-language prose
 * or mojibake as "useful" on content alone. It now hard-rules those to 0 while
 * still accepting a valid ENGLISH TRANSLATION — the training text is judged on
 * its own merits, never on the source's declared language.
 *
 * The marker phrases ("harsh but fair teacher", "reviewing a single ARTICLE",
 * "suggestedImportance") are relied on by the fixture critic in ollama-client.js;
 * keep them if this text changes.
 */
export const CRITIC_PROMPT = [
  "You are a harsh but fair teacher reviewing a single ARTICLE for a tiny text-generation student.",
  "Score the ARTICLE 0-10 (float) for how useful it is as training material, and give 1-2 sentences of rationale.",
  "Hard rules:",
  "  - 0 if the text is empty, degenerate repetition, incoherent, unsafe, or pure boilerplate.",
  "  - 0 if the ARTICLE is NOT fluent English (foreign-language prose, or text that reads as machine translation).",
  "  - 0 if the ARTICLE is encoding-corrupted (mojibake, stray replacement characters) or truncated to fragments.",
  "  - A correct ENGLISH TRANSLATION of a foreign-language source IS valid material: judge the English text on its own merits.",
  "  - Penalize padding and low information density: verbose is NOT valuable.",
  "  - Prefer: correct, specific, well-structured, information-dense English prose.",
  "You MAY suggest an importance of Normal, Important, or Critical, but the operator decides importance.",
  'Return strict JSON: { "score": number, "rationale": string, "suggestedImportance": "Normal"|"Important"|"Critical" }',
].join("\n");

/**
 * Map a critic score to a verdict using the review policy thresholds.
 *
 *   score <= rejectScore => REJECT  (terminal: a clearly-bad article must never
 *     be left "inconclusive" and re-reviewed forever — the defect that produced
 *     a 98% `uncertain` backlog)
 *   score >= minScore   => APPROVE
 *   otherwise           => UNCERTAIN (retry, then retire after maxAttempts)
 *
 * A MISSING score never reaches this function: scoreOffline fails closed to
 * UNCERTAIN there, so "no signal" is never confused with "reject".
 */
export function scoreToVerdict(score, { minScore = config.review.minScore, rejectScore = config.review.rejectScore } = {}) {
  const s = Number(score);
  if (!Number.isFinite(s)) return VERDICT.UNCERTAIN;
  if (s <= rejectScore) return VERDICT.REJECT;
  if (s >= minScore) return VERDICT.APPROVE;
  return VERDICT.UNCERTAIN;
}

/** Extract the first JSON object from a critic response, or null. */
function extractJsonObject(out) {
  const s = String(out ?? "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * A response that degenerates into a repeated token sequence ("the the the…")
 * is worth exactly one retry with a repeat penalty. A merely malformed response
 * is deterministic and is NOT retried.
 */
function looksDegenerate(text) {
  const s = String(text ?? "").trim();
  if (!s) return true;
  const words = s.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  if (words.length < 20) return false;
  const uniqueRatio = new Set(words).size / words.length;
  if (uniqueRatio < 0.2) return true;
  let run = 1;
  let maxRun = 1;
  for (let i = 1; i < words.length; i++) {
    if (words[i] === words[i - 1]) {
      if (++run > maxRun) maxRun = run;
    } else run = 1;
  }
  return maxRun >= 8;
}

/**
 * Classify a critic failure BEFORE retrying. Only genuine transient conditions
 * (timeout, network, 5xx, server repeat-limit) are retried; a deterministic
 * request error (400/404/422) is never retried — retrying it just wastes time.
 */
function isRetryableCriticError(err) {
  const msg = String(err?.message ?? "");
  if (/\b(400|401|403|404|405|422)\b/.test(msg)) return false;
  return /(timed out|timeout|abort|econn|enotfound|eai_again|etimedout|socket|fetch failed|network|refused|5\d\d|repeat limit)/i.test(msg);
}

/**
 * ReviewScorer — the teacher critic (formerly RewardScorer).
 *
 * The score is a REVIEW SIGNAL, never a training target: it decides a verdict,
 * and the verdict decides eligibility. It is deliberately NOT part of the loss.
 */
export class ReviewScorer {
  constructor({ ollama = new OllamaClient({ 
  temperature: config.criticTemperature, 
  model: config.criticModel ?? config.ollamaModel  // criticModel overrides, fallback to ollamaModel
}) } = {}) {
    this.ollama = ollama;
    this.criticVersion = config.criticVersion;
    this.rubricVersion = config.rubricVersion;
  }

  /** Judge WITHOUT touching GraphQL — returns the raw record. */
  async scoreOffline({ text, domain = "general" }) {
    const penalty = heuristicPenalty(text);
    const cfgMaxTokens = Number(config.criticMaxTokens);
    const maxTokens = Number.isFinite(cfgMaxTokens) && cfgMaxTokens > 0 ? cfgMaxTokens : null;
    const maxAttempts = Math.max(1, Number(config.criticMaxAttempts) || 1);
    let llm = null;
    let criticError = null;
    let criticAttempts = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      criticAttempts = attempt;
      try {
        const { text: out } = await this.ollama.chat({
          format: "json",
          maxTokens,
          // The retry after a degenerate loop nudges the model away from it.
          repeatPenalty: attempt > 1 ? config.criticRepeatPenalty : undefined,
          messages: [
            { role: "system", content: CRITIC_PROMPT },
            { role: "user", content: JSON.stringify({ domain, article: text }) },
          ],
        });
        const parsed = extractJsonObject(out);
        if (parsed) {
          llm = parsed;
          criticError = null;
          break;
        }
        criticError = "critic response contained no JSON object";
        // Only a degenerate response earns the one penalty retry; a merely
        // malformed one is deterministic.
        if (attempt >= maxAttempts || !looksDegenerate(out)) break;
      } catch (err) {
        criticError = `critic unavailable: ${err.message.slice(0, 80)}`;
        if (attempt >= maxAttempts || !isRetryableCriticError(err)) break;
      }
    }

    // Missing STAYS missing: an unparseable or absent critic score is NOT a
    // neutral 5 (that silently lost every article as `uncertain`). It is
    // recorded as missing and the article fails CLOSED to `uncertain` at score
    // 0 — never a fabricated middling value.
    const parsedScore = Number(llm?.score);
    const criticScoreMissing = !Number.isFinite(parsedScore);
    const raw = criticScoreMissing ? 0 : Math.max(0, Math.min(10, parsedScore));
    const final = Math.max(0, Math.min(10, raw * penalty));
    const guardrailResult = {
      passed: penalty > 0.1,
      heuristicPenalty: penalty,
      reason: penalty <= 0.1 ? "heuristic guardrail: degenerate repetition/length" : null,
    };
    const rationaleParts = [];
    if (llm?.rationale) rationaleParts.push(String(llm.rationale));
    if (criticError) rationaleParts.push(`[${criticError}]`);
    if (criticScoreMissing && !criticError) rationaleParts.push("[critic returned no finite score]");
    rationaleParts.push(`[heuristicPenalty=${penalty.toFixed(2)}]`);
    return {
      score: final,
      rawScore: criticScoreMissing ? null : raw,
      penalty,
      verdict: criticScoreMissing ? VERDICT.UNCERTAIN : scoreToVerdict(final),
      suggestedImportance: ["Normal", "Important", "Critical"].includes(llm?.suggestedImportance)
        ? llm.suggestedImportance
        : null,
      rationale: rationaleParts.join(" ").trim(),
      guardrailResult,
      criticModel: this.ollama.model,
      criticTemperature: this.ollama.defaultOptions?.temperature ?? null,
      criticResponded: llm != null,
      criticScoreMissing,
      criticError,
      criticAttempts,
      criticMaxTokens: maxTokens,
      criticPromptVersion: config.criticPromptVersion,
      criticVersion: this.criticVersion,
      rubricVersion: this.rubricVersion,
    };
  }

  async review({ articleId, text, domain }) {
    if (!articleId || !text) throw new Error("articleId/text required");
    const r = await this.scoreOffline({ text, domain });
    const data = await gql(REVIEW_M, {
      input: {
        articleId,
        verdict: r.verdict,
        score: r.score,
        rationale: r.rationale,
        authority: "TEACHER",
        reviewerModel: r.criticModel,
        reviewerVersion: r.criticVersion,
        rubricVersion: r.rubricVersion,
        suggestedImportance: r.suggestedImportance,
      },
    });
    return { ...r, stored: data.recordReview };
  }
}

/** Backwards-compatible alias while the last call sites migrate. */
export const RewardScorer = ReviewScorer;

// The repetition guardrail primitive lives in the shared gates module (so the
// review gate and this scorer can never disagree about "degenerate"); it is
// re-exported here to keep the historical public import path stable.
export { heuristicPenalty };

// CLI: review every pending article currently in the queue.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  const QUERY = `{ reviewQueue(limit: 200) { items { articleId text domain } } }`;
  const { reviewQueue } = await gql(QUERY);
  const scorer = new ReviewScorer();
  let done = 0;
  for (const a of reviewQueue.items) {
    const r = await scorer.review({ articleId: a.articleId, text: a.text, domain: a.domain });
    console.log(`reviewed ${a.articleId} -> ${r.verdict} (${r.score.toFixed(1)})`);
    done++;
  }
  console.log(`\nreviewed ${done} pending articles`);
}
