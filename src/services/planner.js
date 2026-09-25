import { mkdir, writeFile } from "node:fs/promises";
import { OllamaClient } from "./ollama-client.js";

const GRAPHQL_URL = process.env.GRAPHQL_URL ?? "http://localhost:4000/graphql";
const STATS_Q = `
  query Stats { stats { totalPrompts trainedPrompts untrainedPrompts totalCompletions rewardCount avgReward duplicationIndex byDomain { domain count } } }
`;
const SAMPLE_Q = `
  query Sample($after: String, $limit: Int, $trained: Boolean) {
    prompts(after: $after, limit: $limit, trained: $trained) {
      items { id text domain rewardScore }
      nextCursor
    }
  }
`;

async function gql(query, variables = {}) {
  const body = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await body.json();
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  return json.data;
}

/**
 * Planner (Subsystem B) — "AI comes up with a balanced plan based around text
 *  generation."
 *
 * Critical stance baked in: the LLM NEVER sees the raw buffer. It only receives
 * *measurements* (per-domain counts, coverage, reward variance, duplication)?
 * and returns a curriculum. Measurements are ground truth; the LLM is advisory.
 * That is the difference between a planner that balances your data and a third
 * opinion poll that drifts your whole distribution. Anything the LLM says gets
 * saved with the measurements as context, so you can audit WHY it decided.
 */
export async function buildPlan() {
  const { stats } = await gql(STATS_Q);
  const byDomain = Object.fromEntries(stats.byDomain.map((d) => [d.domain, d.count]));

  // Sample up to 30 untrained prompts per domain for the LLM to see diversity.
  const samples = {};
  for (const { domain } of stats.byDomain) {
    samples[domain] = [];
  }
  let cursor = null;
  let guard = 0;
  while (guard++ < 60) {
    const { prompts } = await gql(SAMPLE_Q, { after: cursor, limit: 100, trained: false });
    for (const it of prompts.items) (samples[it.domain ?? "unknown"] ??= []).push(it.text.slice(0, 140));
    if (!prompts.nextCursor) break;
    cursor = prompts.nextCursor;
  }

  const measurements = {
    total: stats.totalPrompts,
    trained: stats.trainedPrompts,
    untrained: stats.untrainedPrompts,
    avgReward: stats.avgReward,
    rewardCoverage: stats.rewardCount,
    duplicationIndex: stats.duplicationIndex,
    domainCounts: byDomain,
    domainDiversity: Object.fromEntries(
      Object.entries(samples).map(([d, arr]) => [d, arr.length])
    ),
  };

  const ollama = new OllamaClient();
  const { text } = await ollama.chat({
    format: "json",
    temperature: 0.2,
    // deliberate: no maxTokens on a reasoning model — see OllamaClient note.
    messages: [
      {
        role: "system",
        content: [
          "You are the training curriculum planner for a small text-generation model.",
          "You receive a JSON blob of MEASUREMENTS (never raw data).",
          "Return strict JSON:",
          "{",
          '  "assessment": string,              // 2-3 sentence read of the data health',
          '  "buckets": [{ "domain": string, "targetRatio": number, "rationale": string }],',
          '  "priorities": [string],             // 3 concrete actions, most urgent first',
          '  "maxSyntheticShare": number,        // 0..1 cap on model-own outputs in next batch',
          '  "rewardVarianceWarning": boolean    // true if few/no reward scores exist',
          "}",
          "Assume the critic hasn't scored everything yet. Favor balance, not fashion.",
        ].join("\n"),
      },
      { role: "user", content: JSON.stringify(measurements) },
    ],
  });

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  let plan = null;
  if (start >= 0 && end > start) {
    try {
      plan = JSON.parse(text.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  plan ??= { assessment: "unparseable LLM plan", buckets: [], priorities: [], maxSyntheticShare: 0.25, rewardVarianceWarning: true };

  const record = { at: new Date().toISOString(), measurements, plan, model: ollama.model };
  const dir = "data/plans";
  await mkdir(dir, { recursive: true });
  const file = `${dir}/plan-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await writeFile(file, JSON.stringify(record, null, 2), "utf8");
  return { record, file };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  const { record, file } = await buildPlan();
  console.log(JSON.stringify(record.plan, null, 2));
  console.log(`\nplan persisted -> ${file}`);
}