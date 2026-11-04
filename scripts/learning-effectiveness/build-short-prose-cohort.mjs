#!/usr/bin/env node
/**
 * Extract the audited 596-record safe short-prose candidate subset into an
 * isolated experiment corpus. Read-only against production; writes only to the
 * requested isolated work directory.
 *
 * Usage:
 *   node scripts/learning-effectiveness/build-short-prose-cohort.mjs \
 *     --store /var/lib/simpleminds/data/articles \
 *     --audit /tmp/retired-replay-audit-postdeploy.json \
 *     --outdir /tmp/opencode/sma-short-prose-experiment \
 *     [--tokenizer /var/lib/simpleminds/store/v493/tokenizer.json]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

import { ArticleStore } from "../../src/storage/article-store.js";
import { RETIRED_REPLAY_CLASS, classifyRetiredArticle } from "../../src/training/retired-replay-audit.js";
import { measureDocuments } from "../../src/training/tokenizer-measurement.js";

const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");
function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i >= 0) return process.argv[i + 1];
  const pref = `${name}=`;
  const found = process.argv.find((v) => v.startsWith(pref));
  return found ? found.slice(pref.length) : fallback;
}

const storeDir = arg("--store", "/var/lib/simpleminds/data/articles");
const auditFile = arg("--audit");
const outdir = arg("--outdir");
const tokenizer = arg("--tokenizer");
if (!auditFile || !outdir) throw new Error("--audit and --outdir are required");
await mkdir(outdir, { recursive: true });

const audit = JSON.parse(await readFile(auditFile, "utf8"));
const candidates = audit.recoverableSafeShortRecords ?? [];
const store = await ArticleStore.open(storeDir, { readOnly: true });
const included = [];
const excluded = [];
try {
  for (const candidate of candidates) {
    const article = store.getArticle(candidate.articleId);
    if (!article) { excluded.push({ articleId: candidate.articleId, reason: "missing-article" }); continue; }
    const classification = classifyRetiredArticle(article, store.reviewsFor(article.articleId));
    if (classification.classification !== RETIRED_REPLAY_CLASS.RECOVERABLE_SAFE_SHORT) {
      excluded.push({ articleId: candidate.articleId, reason: `reclassified:${classification.classification}` });
      continue;
    }
    included.push({
      articleId: article.articleId,
      contentHash: article.contentHash,
      text: article.text,
      sourceUrl: article.sourceUrl ?? null,
      sourceDomain: candidate.sourceDomain ?? null,
      licence: article.licence ?? null,
      estimatedTokens: classification.estimatedTokens,
    });
  }
} finally {
  await store.close();
}

const manifest = {
  schema: "sma/short-prose-candidate@1",
  at: new Date().toISOString(),
  sourceAudit: auditFile,
  sourceAuditSha256: sha256(JSON.stringify(audit)),
  store: storeDir,
  candidateCount: candidates.length,
  includedCount: included.length,
  excludedCount: excluded.length,
  includedEstimatedTokens: included.reduce((sum, row) => sum + row.estimatedTokens, 0),
  excluded,
  bySourceDomain: Object.fromEntries([...new Set(included.map((r) => r.sourceDomain))].map((domain) => [domain, included.filter((r) => r.sourceDomain === domain).length])),
  byLicenceStatus: Object.fromEntries([...new Set(included.map((r) => r.licence?.status ?? "none"))].map((status) => [status, included.filter((r) => (r.licence?.status ?? "none") === status).length])),
};
if (tokenizer) {
  manifest.tokenizerMeasurement = await measureDocuments(included.map((r) => ({ itemId: r.articleId, text: r.text })), {
    tokenizerPath: tokenizer,
    seqLen: 128,
    bin: process.env.SMA_PYTHON || "/opt/simpleminds/python/.venv/bin/python",
  });
}
const jsonl = included.map(({ text, ...meta }) => JSON.stringify({ ...meta, text })).join("\n") + "\n";
await writeFile(path.join(outdir, "candidate.jsonl"), jsonl);
await writeFile(path.join(outdir, "candidate.manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
await writeFile(path.join(outdir, "candidate.sha256"), `${sha256(jsonl)}  candidate.jsonl\n`);
console.log(`short-prose candidate: ${included.length}/${candidates.length} included, ${manifest.includedEstimatedTokens} est tokens`);
console.log(`by domain: ${JSON.stringify(manifest.bySourceDomain)}`);
console.log(`licence: ${JSON.stringify(manifest.byLicenceStatus)}`);
if (manifest.tokenizerMeasurement) console.log(`actual tokens: ${manifest.tokenizerMeasurement.totalTokens}, blocks: ${manifest.tokenizerMeasurement.blocksIfConcatenated}, docs: ${manifest.tokenizerMeasurement.documentCount}`);
