import { mkdir, writeFile } from "node:fs/promises";
import { OllamaClient } from "./ollama-client.js";

const GRAPHQL_URL = process.env.GRAPHQL_URL ?? "http://localhost:4000/graphql";
const STATS_Q = `
  query Stats { stats { totalArticles pendingReview reviewed rejected trainable reviewCount avgReviewScore duplicationIndex byDomain { domain count } } }
`;
const SAMPLE_Q = `
  query Sample($after: String, $limit: Int) {
    trainableArticles(after: $after, limit: $limit) {
      items { articleId text domain importance }
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
 * generation."
 *
 * Critical stance baked in: the LLM NEVER sees the raw ledger wholesale. It only
 * receives *measurements* (per-domain counts, review coverage, duplication) plus
 * at most a few short domain samples, and returns a curriculum. Measurements are
 * ground truth; the LLM is advisory. Anything it says gets saved WITH the
 * measurements as context, so you can audit WHY it decided.
 */
export async function buildPlan() {
  const { stats } = await gql(STATS_Q);
  const byDomain = Object.fromEntries(stats.byDomain.map((d) => [d.domain, d.count]));

  const samples = {};
  let cursor = null;
  let guard = 0;
  while (guard++ < 20) {
    const { trainableArticles } = await gql(SAMPLE_Q, { after: cursor, limit: 100 });
    for (const it of trainableArticles.items) {
      const arr = (samples[it.domain ?? "unknown"] ??= []);
      if (arr.length < 30) arr.push(it.text.slice(0, 140));
    }
    if (!trainableArticles.nextCursor) break;
    cursor = trainableArticles.nextCursor;
  }

  const measurements = {
    totalArticles: stats.totalArticles,
    pendingReview: stats.pendingReview,
    reviewed: stats.reviewed,
    rejected: stats.rejected,
    trainable: stats.trainable,
    reviewCoverage: stats.reviewCount,
    avgReviewScore: stats.avgReviewScore,
    duplicationIndex: stats.duplicationIndex,
    domainCounts: byDomain,
    domainDiversity: Object.fromEntries(Object.entries(samples).map(([d, arr]) => [d, arr.length])),
  };

  const ollama = new OllamaClient();
  const { text } = await ollama.chat({
    format: "json",
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: [
          "You are the training curriculum planner for a small text-generation model.",
          "You receive a JSON blob of MEASUREMENTS (never raw data).",
          "Return strict JSON:",
          "{",
          '  "assessment": string,              // 2-3 sentence read of the data health',
          '  "buckets": [{ "domain": string, "targetRatio": number, "minimumImportance": "Normal"|"Important"|"Critical", "rationale": string }],',
          '  "priorities": [string],             // 3 concrete actions, most urgent first',
          '  "reviewCoverageWarning": boolean    // true if little reviewed material exists',
          "}",
          "Favour balance and under-represented domains, not fashion. Importance is operator-controlled.",
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
  plan ??= { assessment: "unparseable LLM plan", buckets: [], priorities: [], reviewCoverageWarning: true };

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
