#!/usr/bin/env node
/**
 * Backfill durable licence provenance for existing articles.
 *
 * Default: DRY RUN, read-only. `--apply` is refused against production paths
 * unless `--allow-production` is supplied, and still requires `--confirm`.
 *
 * It resolves a licence decision from the article's source host and appends a
 * `licence` event per article. It never rewrites article text, reviews,
 * consumption, replay eligibility or checkpoint pointers.
 *
 * Usage:
 *   node scripts/knowledge-pilot/backfill-licences.mjs --store <dir> [--out report.json]
 *   node scripts/knowledge-pilot/backfill-licences.mjs --store <dir> --apply --confirm [--allow-production]
 */
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { ArticleStore } from "../../src/storage/article-store.js";
import { resolveLicence } from "../../src/domain/licence.js";

const PRODUCTION_PREFIXES = ["/var/lib/simpleminds", "/opt/simpleminds"];
const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");

function parseArgs(argv) {
  const opts = { store: process.env.ARTICLE_DIR ?? path.resolve("data/articles"), out: null, apply: false, confirm: false, allowProduction: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--store") opts.store = argv[++i];
    else if (arg.startsWith("--store=")) opts.store = arg.slice("--store=".length);
    else if (arg === "--out") opts.out = argv[++i];
    else if (arg.startsWith("--out=")) opts.out = arg.slice("--out=".length);
    else if (arg === "--apply") opts.apply = true;
    else if (arg === "--confirm") opts.confirm = true;
    else if (arg === "--allow-production") opts.allowProduction = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/knowledge-pilot/backfill-licences.mjs --store <article-dir> [--out report.json] [--apply --confirm [--allow-production]]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.apply) {
  if (!opts.confirm) throw new Error("--apply requires --confirm");
  const resolved = path.resolve(opts.store);
  const production = PRODUCTION_PREFIXES.some((prefix) => resolved === prefix || resolved.startsWith(`${prefix}${path.sep}`));
  if (production && !opts.allowProduction) {
    throw new Error(`refusing --apply against a production path: ${opts.store} (pass --allow-production after separate authorisation)`);
  }
}

const store = await ArticleStore.open(opts.store, { readOnly: !opts.apply });
const byStatus = {};
const samples = [];
let scanned = 0;
let alreadyResolved = 0;
let resolved = 0;
let unresolved = 0;
try {
  let after = null;
  for (;;) {
    const page = store.articlesPage({ after, limit: 200 });
    if (!page.items.length) break;
    for (const article of page.items) {
      scanned += 1;
      if (article.licence) {
        alreadyResolved += 1;
        continue;
      }
      if (!article.sourceUrl && !article.sourceDomain) {
        unresolved += 1;
        continue;
      }
      const licence = resolveLicence({ sourceUrl: article.sourceUrl ?? null, sourceDomain: article.sourceDomain ?? null });
      const key = `${licence.status}:${licence.decision}`;
      byStatus[key] = (byStatus[key] ?? 0) + 1;
      resolved += 1;
      if (samples.length < 10) samples.push({ articleId: article.articleId, sourceDomain: licence.sourceHost, status: licence.status, decision: licence.decision, id: licence.id });
      if (opts.apply) await store.setLicence(article.articleId, { licence });
    }
    after = page.nextCursor;
    if (!after) break;
  }
} finally {
  await store.close();
}

const report = {
  schema: "sma/licence-backfill@1",
  at: new Date().toISOString(),
  mode: opts.apply ? "apply" : "dry-run",
  store: opts.store,
  storeFingerprint: sha256(opts.store),
  scanned,
  alreadyResolved,
  resolved,
  unresolvedNoSource: unresolved,
  byStatus,
  samples,
  note: "Licence decisions are provenance only unless LICENCE_ENFORCEMENT=enforce. No article text, review, consumption or replay eligibility is changed by this script.",
};
if (opts.out) await writeFile(opts.out, `${JSON.stringify(report, null, 2)}\n`);
else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (opts.out) {
  console.log(`licence backfill (${report.mode}): scanned=${scanned} resolved=${resolved} already=${alreadyResolved} no-source=${unresolved}`);
  for (const [key, count] of Object.entries(byStatus)) console.log(`  ${key}: ${count}`);
}
