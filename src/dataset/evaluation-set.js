import { existsSync, createReadStream } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { contentHash } from "../domain/article.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
// The bundled, immutable corpora committed under data/evaluation/ (e.g.
// eval-002). When the configured evaluation directory has no copy of the
// requested dataset, the loader seeds from here and freezes the local copy, so
// every deployment evaluates against the exact same, reviewable documents.
const BUNDLED_EVAL_DIR = path.join(REPO_ROOT, "data", "evaluation");

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
 * consulted only when neither the local file nor the bundled copy exists —
 * afterwards the file is authoritative.
 */
export async function loadEvaluationSet({ dir = config.paths.evaluation, datasetId = config.evalDatasetId, seed = null, minDocuments = config.evalMinDocuments, minTokens = config.evalMinTokens } = {}) {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${datasetId}.jsonl`);
  let items = await readLines(file);
  let source = "local";
  // Precedence: the local frozen file, then an explicit in-process seed (tests,
  // and the legacy eval-001 Q/A seed), then the bundled corpus committed in the
  // repo. The bundled corpus is only reached when the caller supplies no seed.
  if (!items.length && seed) {
    source = "seed";
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
  if (!items.length) {
    const bundled = await readLines(path.join(BUNDLED_EVAL_DIR, `${datasetId}.jsonl`));
    if (bundled.length) {
      items = bundled;
      source = "bundled";
      await writeFile(file, items.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    }
  }
  const content = items.map((r) => evalText(r)).join("\n");
  const datasetVersion = createHash("sha256").update(content, "utf8").digest("hex").slice(0, 12);
  const hashes = new Set(items.map((r) => contentHash(evalText(r))));
  const charCount = items.reduce((n, r) => n + evalText(r).length, 0);
  // ~4 chars/token is an ESTIMATE for the advisory floor; the authoritative
  // token count is the trainer's `tokensSeen`, recorded on the evaluation.
  const estimatedTokens = Math.round(charCount / 4);
  const domains = items.reduce((m, r) => ((m[r.domain ?? "general"] = (m[r.domain ?? "general"] ?? 0) + 1), m), {});

  const warnings = [];
  const docFloor = Number.isFinite(Number(minDocuments)) && Number(minDocuments) > 0 ? Number(minDocuments) : 0;
  const tokenFloor = Number.isFinite(Number(minTokens)) && Number(minTokens) > 0 ? Number(minTokens) : 0;
  if (docFloor > 0 && items.length < docFloor) {
    warnings.push({
      code: "eval-set-undersized",
      severity: "advisory",
      datasetId,
      size: items.length,
      minDocuments: docFloor,
      message: `frozen evaluation set '${datasetId}' holds ${items.length} document(s), below the advisory minimum of ${docFloor}; evaluation and promotion are unaffected`,
    });
  }
  if (tokenFloor > 0 && estimatedTokens < tokenFloor) {
    warnings.push({
      code: "eval-set-undertokens",
      severity: "advisory",
      datasetId,
      estimatedTokens,
      minTokens: tokenFloor,
      message: `frozen evaluation set '${datasetId}' is ~${estimatedTokens} tokens (est.), below the advisory minimum of ${tokenFloor}; loss on a small set is dominated by sampling noise — use the bundled 'eval-002' baseline`,
    });
  }

  // Freeze manifest: the identity that makes the whole promotion ladder
  // comparable. Written once; a later load that observes drift warns loudly.
  const metric = {
    metric: "causal-cross-entropy",
    strategy: config.packStrategy ?? "concatenate-chunk-v1",
    sequenceLength: config.promoteEvalSeqLen,
    microBatch: config.promoteEvalMicroBatch,
    computeDtype: "float32",
  };
  const manifest = {
    datasetId,
    datasetVersion,
    size: items.length,
    charCount,
    estimatedTokens,
    domains,
    articleIds: items.map((r) => r.articleId ?? null),
    contentHashes: items.map((r) => contentHash(evalText(r))),
    metric,
    source,
    createdAt: new Date().toISOString(),
  };
  const manifestFile = path.join(dir, `${datasetId}.manifest.json`);
  if (!existsSync(manifestFile)) {
    await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  } else {
    try {
      const prior = JSON.parse(await readFile(manifestFile, "utf8"));
      if (prior.datasetVersion && prior.datasetVersion !== datasetVersion) {
        warnings.push({
          code: "eval-set-drifted",
          severity: "advisory",
          datasetId,
          expectedVersion: prior.datasetVersion,
          actualVersion: datasetVersion,
          message: `frozen evaluation set '${datasetId}' no longer matches its manifest (${prior.datasetVersion} -> ${datasetVersion}); scores before and after this change are not comparable`,
        });
      }
      if (prior.metric && JSON.stringify(prior.metric) !== JSON.stringify(metric)) {
        warnings.push({
          code: "eval-metric-changed",
          severity: "advisory",
          datasetId,
          expected: prior.metric,
          actual: metric,
          message: `evaluation metric parameters for '${datasetId}' changed; the promotion gate treats cross-signature comparisons as incomparable`,
        });
      }
    } catch {
      /* unreadable manifest: fall through without warning */
    }
  }

  return { datasetId, datasetVersion, file, items, hashes, size: items.length, charCount, estimatedTokens, domains, evalText, minDocuments: docFloor, minTokens: tokenFloor, manifest, warnings };
}

const LEAK_NGRAM_SIZE = 8;

export function normalizeLeakText(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9']+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function leakNgrams(text, size = LEAK_NGRAM_SIZE) {
  const words = normalizeLeakText(text).split(" ").filter(Boolean);
  if (words.length < size) return new Set();
  const out = new Set();
  for (let i = 0; i <= words.length - size; i += 1) out.add(words.slice(i, i + size).join(" "));
  return out;
}

/** Guard that keeps the evaluation set OUT of anything else.
 *
 * Exact content hashes catch identical rows. Normalized exact hashes catch
 * whitespace/punctuation variants, and an 8-word shingle overlap catches
 * near-duplicates introduced by raw-text cleaning, alternate URLs, or replay.
 * Any overlap is excluded; the guard reports which mechanism fired.
 */
export function makeEvalGuard(evalSet) {
  const hashOf = (row) => (row && typeof row.contentHash === "string" ? row.contentHash : contentHash(evalText(row)));
  const normalizedHashes = new Set();
  const evalNgrams = new Set();
  for (const item of evalSet.items ?? []) {
    const text = evalText(item);
    normalizedHashes.add(contentHash(normalizeLeakText(text)));
    for (const ngram of leakNgrams(text)) evalNgrams.add(ngram);
  }
  const stats = { exactHashes: evalSet.hashes?.size ?? 0, normalizedHashes: normalizedHashes.size, ngrams: evalNgrams.size, checks: 0, exactMatches: 0, normalizedMatches: 0, ngramMatches: 0 };
  return {
    contains(row) {
      stats.checks += 1;
      if (evalSet.hashes.has(hashOf(row))) {
        stats.exactMatches += 1;
        return true;
      }
      const text = row?.text ?? (row && (row.prompt || row.completion) ? evalText(row) : "");
      if (text && normalizedHashes.has(contentHash(normalizeLeakText(text)))) {
        stats.normalizedMatches += 1;
        return true;
      }
      if (text) {
        const rowNgrams = leakNgrams(text);
        for (const ngram of rowNgrams) {
          if (evalNgrams.has(ngram)) {
            stats.ngramMatches += 1;
            return true;
          }
        }
      }
      return false;
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
    stats() {
      return { ...stats };
    },
  };
}
