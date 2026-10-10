import { readFile } from "node:fs/promises";
import { OllamaClient } from "./ollama-client.js";

const GRAPHQL_URL = process.env.GRAPHQL_URL ?? "http://localhost:4000/graphql";
const ARTICLE_M = `
mutation Ingest($input: ArticleInput!) { ingestArticle(input: $input) { articleId contentHash status } }
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

/**
 * Curator — pipelines RAW text -> deepseek-r1 (Ollama) -> GraphQL article store.
 *
 * This is the join point between Subsystem A (harvest) and the article ledger
 * the trainer consumes. It is deliberately dumb-on-purpose: the LLM does the
 * cleaning, this file only enforces the envelope (parse JSON, tag provenance).
 * Each cleaned unit becomes ONE article — continuous prose, not a pair.
 */
export class Curator {
  constructor({ ollama = new OllamaClient() } = {}) {
    this.ollama = ollama;
  }

  async clean(rawText) {
    return this.ollama.clean(rawText);
  }

  async ingestArticleText({ text, domain, source, rawText }) {
    if (!text) return null;
    const data = await gql(ARTICLE_M, {
      input: { text, domain: domain ?? "general", source, rawText },
    });
    return data.ingestArticle ?? null;
  }

  /** One raw blob in -> N articles out (cleaned by the teacher model). */
  async processRaw(rawText, { source = "harvest", concurrency = 2, domain = "general" } = {}) {
    const cleaned = await this.clean(rawText);
    const results = [];
    let i = 0;
    const worker = async () => {
      while (i < cleaned.length) {
        const idx = i++;
        const unit = cleaned[idx];
        const text = unit?.text ?? (unit?.prompt ? `${unit.prompt}\n\n${unit.completion ?? ""}`.trim() : null);
        if (!text) continue;
        const res = await this.ingestArticleText({
          text,
          domain: unit.domain ?? domain,
          source,
          rawText,
        });
        results.push({ ...unit, articleId: res?.articleId ?? null, ingested: !!res });
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return results;
  }
}

// CLI: node src/services/curator.js --file data/raw/sample.ndjson [--source my-src]
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : null;
  };
  const file = arg("--file") ?? "data/raw/sample.ndjson";
  const source = arg("--source") ?? "harvest";
  const raw = (await readFile(file, "utf8")).split("\n").filter(Boolean);
  const curator = new Curator();
  let total = 0;
  for (const line of raw) {
    let doc;
    try {
      doc = JSON.parse(line);
    } catch {
      continue; // tolerate non-JSONL raw files
    }
    const text = doc?.text ?? line;
    const results = await curator.processRaw(String(text), { source, domain: doc?.domain });
    total += results.filter((r) => r.ingested).length;
  }
  console.log(`curated ${total} articles -> ${GRAPHQL_URL}`);
}
