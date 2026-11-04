#!/usr/bin/env node
/**
 * Read-only audit of RETIRED articles that were consumed but are not currently
 * replayable. This is the targeted recovery decision for the legacy records
 * identified in the programme assessment.
 *
 * It never mutates the store. It emits per-record classification plus aggregate
 * counts/tokens so an operator can authorise a separate migration.
 *
 * Usage:
 *   node scripts/knowledge-pilot/audit-retired-replay.mjs \
 *     --store /var/lib/simpleminds/data/articles [--out report.json]
 */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { ArticleStore } from "../../src/storage/article-store.js";
import { STATUS } from "../../src/domain/article.js";
import {
  aggregateClassifications,
  classifyRetiredArticle,
} from "../../src/training/retired-replay-audit.js";

function parseArgs(argv) {
  const opts = {
    store: process.env.ARTICLE_DIR ?? path.resolve("data/articles"),
    out: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--store") opts.store = argv[++i];
    else if (arg.startsWith("--store=")) opts.store = arg.slice("--store=".length);
    else if (arg === "--out") opts.out = argv[++i];
    else if (arg.startsWith("--out=")) opts.out = arg.slice("--out=".length);
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/knowledge-pilot/audit-retired-replay.mjs --store <article-dir> [--out report.json]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");

const opts = parseArgs(process.argv.slice(2));
const store = await ArticleStore.open(opts.store, { readOnly: true });
const rows = [];
try {
  let after = null;
  for (;;) {
    const page = store.articlesPage({ after, limit: 200 });
    if (!page.items.length) break;
    for (const article of page.items) {
      if (article.status !== STATUS.RETIRED) continue;
      rows.push(classifyRetiredArticle(article, store.reviewsFor(article.articleId)));
    }
    after = page.nextCursor;
    if (!after) break;
  }
} finally {
  await store.close();
}

const counts = aggregateClassifications(rows, "classification");
const recoverable = rows.filter((row) => row.classification === "RECOVERABLE_SAFE");
const safeShort = rows.filter((row) => row.classification === "RECOVERABLE_SAFE_SHORT");
const report = {
  schema: "sma/retired-replay-audit@1",
  at: new Date().toISOString(),
  mode: "dry-run",
  store: opts.store,
  storeFingerprint: sha256(opts.store),
  scannedRetired: rows.length,
  counts,
  recoverableCount: recoverable.length,
  recoverableEstimatedTokens: recoverable.reduce((sum, row) => sum + row.estimatedTokens, 0),
  recoverableSafeShortCount: safeShort.length,
  recoverableSafeShortEstimatedTokens: safeShort.reduce((sum, row) => sum + row.estimatedTokens, 0),
  recoverableSafeShortRecords: safeShort.map((row) => ({
    articleId: row.articleId,
    sourceUrl: row.sourceUrl,
    sourceDomain: row.sourceDomain,
    estimatedTokens: row.estimatedTokens,
    licenceStatus: row.licenceStatus,
    reason: row.reason,
  })),
  byLicenceStatus: aggregateClassifications(rows, "licenceStatus"),
  byClassificationAndLicence: Object.fromEntries(
    [...new Set(rows.map((row) => row.classification))].sort().map((classification) => {
      const subset = rows.filter((row) => row.classification === classification);
      return [classification, aggregateClassifications(subset, "licenceStatus")];
    }),
  ),
  bySourceDomain: aggregateClassifications(rows, "sourceDomain"),
  recoverableBySourceDomain: aggregateClassifications(recoverable, "sourceDomain"),
  samples: {
    recoverable: recoverable.slice(0, 10),
    safeShort: safeShort.slice(0, 10),
    blocked: rows.filter((row) => row.classification.startsWith("BLOCKED_")).slice(0, 10),
  },
  note: "Read-only audit. No article, event or pointer was modified. Token counts are character/4 estimates; use the tokenizer for final planning.",
};

if (opts.out) await writeFile(opts.out, `${JSON.stringify(report, null, 2)}\n`);
else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (opts.out) {
  console.log(`retired-replay audit: ${rows.length} retired, ${recoverable.length} recoverable (${report.recoverableEstimatedTokens} estimated tokens)`);
  for (const [key, value] of Object.entries(counts)) console.log(`  ${key}: ${value.count} (${value.estimatedTokens} est tokens)`);
}
