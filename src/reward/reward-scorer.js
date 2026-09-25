import { OllamaClient } from "../services/ollama-client.js";
import { config } from "../config.js";

const GRAPHQL_URL = process.env.GRAPHQL_URL ?? "http://localhost:4000/graphql";
const SCORE_M = `
mutation Score($input: ScoreInput!) { scoreCompletion(input: $input) { id score } }
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
  "You are a harsh but fair reward model for a tiny text-generation student.",
  "Score the COMPLETION 0-10 (float) for the PROMPT. Also return 1-2 sentence rationale.",
  "Hard rules:",
  "  - 0 if the completion is empty, repeats itself, ignores instructions, or is unsafe.",
  "  - Penalize obvious length-gaming: verbose padding is NOT quality.",
  "  - Prefer: correct, specific, well-structured, low fluff.",
  "Return strict JSON: { \"score\": number, \"rationale\": string }",
].join("\n");

/**
 * RewardScorer — the RLAIF critic.
 *
 * Guardrail before ANY LLM call: a cheap, deterministic heuristic (repetition +
 * length floor). The judge's score is multiplied by it and clamped. This stops
 * the two worst failure modes for LLM-as-a-judge loops:
 *   1. reward hacking / length bias (padding to score high),
 *   2. echo collapse (student learns to imitate the critic's own style).
 */
export function heuristicPenalty(text) {
  const words = String(text ?? "").toLowerCase().match(/[a-z0-9']+/g) ?? [];
  if (words.length < 3) return 0.0;
  const bigrams = new Set();
  for (let i = 0; i < words.length - 1; i++) bigrams.add(words[i] + " " + words[i + 1]);
  const ratio = bigrams.size / Math.max(1, words.length - 1); // 1 = fully diverse
  return Math.max(0, Math.min(1, ratio));
}

export class RewardScorer {
  constructor({ ollama = new OllamaClient({ temperature: config.criticTemperature }) } = {}) {
    this.ollama = ollama;
    this.criticVersion = config.criticVersion;
    this.rubricVersion = config.rubricVersion;
  }

  /**
   * Score WITHOUT touching the buffer/GraphQL — returns the raw record
   * (used by the synthetic-feedback path, which writes its own ingest).
   */
  async scoreOffline({ promptText, completionText }) {
    const penalty = heuristicPenalty(completionText);

    let llm = null;
    try {
      const { text } = await this.ollama.chat({
        format: "json",
        messages: [
          { role: "system", content: CRITIC_PROMPT },
          { role: "user", content: JSON.stringify({ prompt: promptText ?? "(no prompt)", completion: completionText }) },
        ],
      });
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start >= 0 && end > start) llm = JSON.parse(text.slice(start, end + 1));
    } catch (err) {
      llm = { score: 5, rationale: `critic unavailable: ${err.message.slice(0, 80)}` };
    }

    const raw = Math.max(0, Math.min(10, Number(llm?.score ?? 5)));
    const final = Math.max(0, Math.min(10, raw * penalty));
    const reason = `${llm?.rationale ?? ""} [heuristicPenalty=${penalty.toFixed(2)}]`.trim();
    const guardrailResult = {
      passed: penalty > 0.1,
      heuristicPenalty: penalty,
      reason: penalty <= 0.1 ? "heuristic guardrail: degenerate repetition/length" : null,
    };
    return {
      completionId: null,
      score: final,
      rawScore: raw,
      penalty,
      rationale: reason,
      guardrailResult,
      criticModel: this.ollama.model,
      criticVersion: this.criticVersion,
      rubricVersion: this.rubricVersion,
    };
  }

  async score({ completionId, promptText, completionText }) {
    if (!completionId || !completionText) throw new Error("completionId/text required");
    const r = await this.scoreOffline({ promptText, completionText });

    const data = await gql(SCORE_M, {
      input: {
        completionId,
        score: r.score,
        rationale: r.rationale,
        criticModel: this.ollama.model,
        criticVersion: this.criticVersion,
        rubricVersion: this.rubricVersion,
        guardrailResult: r.guardrailResult,
      },
    });
    return {
      completionId,
      rawScore: r.rawScore,
      penalty: r.penalty,
      final: data.scoreCompletion.score,
      rationale: r.rationale,
      guardrailResult: r.guardrailResult,
    };
  }
}

// CLI: score every unscored completion currently in the buffer.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  const QUERY = `
    {
      prompts(limit: 200) {
        items {
          id text
          completions { id text model rewardScore }
        }
      }
    }`;
  const { prompts } = await gql(QUERY);
  const scorer = new RewardScorer();
  let done = 0, skipped = 0;
  for (const p of prompts.items) {
    for (const c of p.completions) {
      if (c.rewardScore != null) { skipped++; continue; }
      const r = await scorer.score({ completionId: c.id, promptText: p.text, completionText: c.text });
      console.log(`scored ${r.final.toFixed(1)} (${r.rawScore.toFixed(1)} x ${r.penalty.toFixed(2)}) ${c.id}`);
      done++;
    }
  }
  console.log(`\nscored ${done}, skipped ${skipped} already-scored`);
}