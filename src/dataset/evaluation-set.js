import { existsSync, createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import readline from "node:readline";
import path from "node:path";
import { config } from "../config.js";

/**
 * Immutable evaluation set (requirement #4).
 *
 * One file per datasetId (default `eval-001`). Created once by a seed function,
 * never appended to afterwards — the same set evaluates every candidate, so
 * scores across a whole promotion ladder are comparable. A synthetic example is
 * BY CONSTRUCTION unable to enter: ingestion only ever happens through `seed()`
 * with origin filterable, and the leak guard (`makeEvalGuard`) rejects any
 * training row whose (prompt, completion) pair hash collides with this set.
 */
export function pairHash(prompt, completion) {
  return createHash("sha256").update(`${String(prompt)}\u0000${String(completion)}`, "utf8").digest("hex").slice(0, 32);
}

async function readLines(file) {
  const out = [];
  if (!existsSync(file)) return out;
  const rl = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const raw of rl) {
    if (!raw.trim()) continue;
    try { out.push(JSON.parse(raw)); } catch {}
  }
  return out;
}

/**
 * Load (or first-time seed and freeze) the evaluation set.
 * `seed` is a fn returning rows [{promptId, prompt, completion, domain}];
 * it is only consulted the first time the file does not exist — afterwards the
 * file on disk is the single source of truth (immutability).
 */
export async function loadEvaluationSet({ dir = config.paths.evaluation, datasetId = config.evalDatasetId, seed = null } = {}) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${datasetId}.jsonl`);
  let items = await readLines(file);
  if (!items.length && seed) {
    items = (await seed()).map((r, i) => ({
      promptId: r.promptId ?? `ev_${datasetId}_${i + 1}`,
      prompt: String(r.prompt ?? ""),
      completion: String(r.completion ?? ""),
      domain: r.domain ?? "general",
      createdAt: new Date().toISOString(),
    }));
    await writeFile(file, items.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  }
  const content = items.map((r) => r.prompt + "\u0000" + r.completion).join("\n");
  const datasetVersion = createHash("sha256").update(content, "utf8").digest("hex").slice(0, 12);
  const hashes = new Set(items.map((r) => pairHash(r.prompt, r.completion)));
  return { datasetId, datasetVersion, file, items, hashes, size: items.length };
}

/** Guard that keeps the evaluation set OUT of anything else. */
export function makeEvalGuard(evalSet) {
  return {
    contains(row) {
      return evalSet.hashes.has(pairHash(String(row.prompt ?? ""), String(row.completion ?? "")));
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