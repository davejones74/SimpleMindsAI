import { readFile } from "node:fs/promises";
import { OllamaClient } from "./ollama-client.js";

const GRAPHQL_URL = process.env.GRAPHQL_URL ?? "http://localhost:4000/graphql";
const PROMPT_M = `
mutation Ingest($input: PromptInput!) { ingestPrompt(input: $input) { id hash deduped } }
`;
const COMP_M = `
mutation IngestComp($input: CompletionInput!) { ingestCompletion(input: $input) { id } }
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
 * Curator — pipelines RAW text -> deepseek-r1:8b (Ollama) -> GraphQL buffer.
 *
 * This is the join point between Subsystem A (harvest) and the buffer that the
 * trainer (Subsystem C pipeline) consumes. It is deliberately dumb-on-purpose:
 * the LLM does the cleaning, this file only enforces the envelope (parse JSON,
 * tag provenance, rate-limit).
 */
export class Curator {
  constructor({ ollama = new OllamaClient() } = {}) {
    this.ollama = ollama;
  }

  async clean(rawText) {
    return this.ollama.clean(rawText);
  }

  async ingestPair({ prompt, completion, domain, source }) {
    if (!prompt || !completion) return null;
    const p = await gql(PROMPT_M, {
      input: { text: prompt, domain, source, rawText: undefined },
    });
    if (!p.ingestPrompt?.id) return null;
    await gql(COMP_M, {
      input: { promptId: p.ingestPrompt.id, text: completion, model: this.ollama.model, origin: "curated" },
    });
    return p.ingestPrompt;
  }

  /** One raw blob in -> N pairs out. Pulls through deepseek-r1 per batch. */
  async processRaw(rawText, { source = "harvest", concurrency = 2, sourceChapters = true } = {}) {
    const pairs = await this.clean(rawText);
    const results = [];
    let i = 0;
    const worker = async () => {
      while (i < pairs.length) {
        const idx = i++;
        const pair = pairs[idx];
        if (!pair?.prompt || !pair?.completion) continue;
        const res = await this.ingestPair({ ...pair, domain: pair.domain ?? "general", source });
        results.push({ ...pair, promptId: res?.id ?? null, ingested: !!res });
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
    const results = await curator.processRaw(String(text), { source });
    total += results.filter((r) => r.ingested).length;
  }
  console.log(`curated ${total} pairs -> ${GRAPHQL_URL}`);
}