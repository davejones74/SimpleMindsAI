import { OllamaClient } from "../services/ollama-client.js";
import { config } from "../config.js";
import { VERDICT } from "../domain/article.js";

const GRAPHQL_URL = process.env.GRAPHQL_URL ?? "http://localhost:4000/graphql";
const REVIEW_M = `
mutation Review($input: ReviewInput!) {
  recordReview(input: $input) { applied review { reviewId verdict score } article { articleId status } }
}
`;

async function gql(query, variables) {
  const body = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await body.json();
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  return json.data;
}

const CRITIC_PROMPT = [
  "You are a harsh but fair teacher reviewing a single ARTICLE for a tiny text-generation student.",
  "Score the ARTICLE 0-10 (float) for how useful it is as training material, and give 1-2 sentences of rationale.",
  "Hard rules:",
  "  - 0 if the text is empty, degenerate repetition, incoherent, unsafe, or pure boilerplate.",
  "  - Penalize padding and low information density: verbose is NOT valuable.",
  "  - Prefer: correct, specific, well-structured, information-dense prose.",
  "You MAY suggest an importance of Normal, Important, or Critical, but the operator decides importance.",
  'Return strict JSON: { "score": number, "rationale": string, "suggestedImportance": "Normal"|"Important"|"Critical" }',
].join("\n");

/**
 * Deterministic guardrail applied before any LLM judgement: a cheap repetition
 * density heuristic. It stops the two worst failure modes for LLM-as-a-judge —
 * length-gaming and echo collapse — from ever producing a high score.
 */
export function heuristicPenalty(text) {
  const words = String(text ?? "").toLowerCase().match(/[a-z0-9']+/g) ?? [];
  if (words.length < 3) return 0.0;
  const bigrams = new Set();
  for (let i = 0; i < words.length - 1; i++) bigrams.add(words[i] + " " + words[i + 1]);
  const ratio = bigrams.size / Math.max(1, words.length - 1); // 1 = fully diverse
  return Math.max(0, Math.min(1, ratio));
}

/** Map a critic score to a verdict using the review policy thresholds. */
export function scoreToVerdict(score, { minScore = config.review.minScore, uncertainScore = config.review.uncertainScore } = {}) {
  const s = Number(score);
  if (!Number.isFinite(s)) return VERDICT.UNCERTAIN;
  if (s <= uncertainScore) return VERDICT.UNCERTAIN;
  if (s >= minScore) return VERDICT.APPROVE;
  return VERDICT.UNCERTAIN;
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
    let llm = null;
    try {
      const { text: out } = await this.ollama.chat({
        format: "json",
        messages: [
          { role: "system", content: CRITIC_PROMPT },
          { role: "user", content: JSON.stringify({ domain, article: text }) },
        ],
      });
      const start = out.indexOf("{");
      const end = out.lastIndexOf("}");
      if (start >= 0 && end > start) llm = JSON.parse(out.slice(start, end + 1));
    } catch (err) {
      llm = { score: 5, rationale: `critic unavailable: ${err.message.slice(0, 80)}` };
    }

    const raw = Math.max(0, Math.min(10, Number(llm?.score ?? 5)));
    const final = Math.max(0, Math.min(10, raw * penalty));
    const guardrailResult = {
      passed: penalty > 0.1,
      heuristicPenalty: penalty,
      reason: penalty <= 0.1 ? "heuristic guardrail: degenerate repetition/length" : null,
    };
    return {
      score: final,
      rawScore: raw,
      penalty,
      verdict: scoreToVerdict(final),
      suggestedImportance: ["Normal", "Important", "Critical"].includes(llm?.suggestedImportance)
        ? llm.suggestedImportance
        : null,
      rationale: `${llm?.rationale ?? ""} [heuristicPenalty=${penalty.toFixed(2)}]`.trim(),
      guardrailResult,
      criticModel: this.ollama.model,
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
