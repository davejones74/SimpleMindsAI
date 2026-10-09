import { existsSync, createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import readline from "node:readline";
import path from "node:path";
import { config } from "../config.js";
import { contentHash } from "../domain/article.js";

/**
 * Immutable evaluation set.
 *
 * One file per datasetId (default `eval-001`). Created once by a seed function,
 * never appended to afterwards — the same set evaluates every candidate, so
 * scores across a whole promotion ladder are comparable.
 *
 * The leak guard is CONTENT-HASH based: a training article is excluded whenever
 * the hash of its text collides with the hash of any evaluation row's text.
 * `pairHash` is retained for the complementary token-F1 evaluator's Q/A rows.
 */
export function pairHash(prompt, completion) {
  return createHash("sha256").update(`${String(prompt)}\u0000${String(completion)}`, "utf8").digest("hex").slice(0, 32);
}

/** The canonical text of an evaluation row (article text or legacy Q/A pair). */
export function evalText(row) {
  if (row && typeof row.text === "string" && row.text.length) return row.text;
  return `${String(row?.prompt ?? "")}\n\n${String(row?.completion ?? "")}`;
}

async function readLines(file) {
  const out = [];
  if (!existsSync(file)) return out;
  const rl = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const raw of rl) {
    if (!raw.trim()) continue;
    try {
      out.push(JSON.parse(raw));
    } catch {
      /* skip corrupt tail */
    }
  }
  return out;
}

/**
 * Load (or first-time seed and freeze) the evaluation set.
 * `seed` returns rows [{articleId?, text?, prompt?, completion?, domain}]; it is
 * consulted only when the file is absent — afterwards the file is authoritative.
 */
export async function loadEvaluationSet({ dir = config.paths.evaluation, datasetId = config.evalDatasetId, seed = null } = {}) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${datasetId}.jsonl`);
  let items = await readLines(file);
  if (!items.length && seed) {
    items = (await seed()).map((r, i) => ({
      articleId: r.articleId ?? `ev_${datasetId}_${i + 1}`,
      promptId: r.promptId ?? r.articleId ?? `ev_${datasetId}_${i + 1}`,
      text: r.text ?? `${String(r.prompt ?? "")}\n\n${String(r.completion ?? "")}`,
      prompt: r.prompt ?? undefined,
      completion: r.completion ?? undefined,
      domain: r.domain ?? "general",
      createdAt: new Date().toISOString(),
    }));
    await writeFile(file, items.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  }
  const content = items.map((r) => evalText(r)).join("\n");
  const datasetVersion = createHash("sha256").update(content, "utf8").digest("hex").slice(0, 12);
  const hashes = new Set(items.map((r) => contentHash(evalText(r))));
  return { datasetId, datasetVersion, file, items, hashes, size: items.length, evalText };
}

/** Guard that keeps the evaluation set OUT of anything else. */
export function makeEvalGuard(evalSet) {
  const hashOf = (row) => (row && typeof row.contentHash === "string" ? row.contentHash : contentHash(evalText(row)));
  return {
    contains(row) {
      return evalSet.hashes.has(hashOf(row));
    },
    filter(rows) {
      const kept = [];
      const excluded = [];
      for (const r of rows) {
        if (this.contains(r)) excluded.push(r);
        else kept.push(r);
      }
      return { kept, excluded };
    },
  };
}
