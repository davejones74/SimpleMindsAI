#!/usr/bin/env node
/**
 * Build an isolated pilot ArticleStore from a small, deterministic subset of
 * production accepted material. Read-only against production; writes only under
 * --out-store. No production article is consumed or modified.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

import { ArticleStore } from "../../src/storage/article-store.js";
import { STATUS, isReplayPool, isTrainable } from "../../src/domain/article.js";
import { preScreen } from "../../src/domain/review-gates.js";

const POLICY_PATH = path.resolve("scripts/knowledge-pilot/replay-licence-policy.json");
const PRODUCTION_PREFIXES = ["/var/lib/simpleminds", "/opt/simpleminds"];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function parseArgs(argv) {
  const opts = {
    source: process.env.ARTICLE_DIR ?? "/var/lib/simpleminds/data/articles",
    outStore: null,
    manifest: null,
    fresh: 32,
    replay: 8,
    retired: 4,
    maxChars: 12000,
    minChars: 300,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--source") opts.source = argv[++i];
    else if (arg === "--out-store") opts.outStore = argv[++i];
    else if (arg === "--manifest") opts.manifest = argv[++i];
    else if (arg === "--fresh") opts.fresh = Number(argv[++i]);
    else if (arg === "--replay") opts.replay = Number(argv[++i]);
    else if (arg === "--retired") opts.retired = Number(argv[++i]);
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/knowledge-pilot/build-pilot-articles.mjs --out-store DIR --manifest FILE [--source DIR] [--fresh n] [--replay n] [--retired n]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!opts.outStore) throw new Error("--out-store is required");
  if (PRODUCTION_PREFIXES.some((prefix) => path.resolve(opts.outStore).startsWith(prefix))) {
    throw new Error(`refusing to write a pilot store under a production path: ${opts.outStore}`);
  }
  return opts;
}

function hostOf(article) {
  try { return new URL(article.sourceUrl).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return ""; }
}
function domainAllowed(host, policy) {
  return policy.safeDomains.some((d) => host === d || host.endsWith(`.${d}`));
}
function balanced(rows, limit) {
  const byDomain = new Map();
  for (const row of rows) {
    const host = hostOf(row);
    const list = byDomain.get(host) ?? [];
    list.push(row);
    byDomain.set(host, list);
  }
  const keys = [...byDomain.keys()].sort();
  const out = [];
  let index = 0;
  while (out.length < limit) {
    let added = false;
    for (const key of keys) {
      const list = byDomain.get(key);
      if (index < list.length && out.length < limit) {
        out.push(list[index]);
        added = true;
      }
    }
    index += 1;
    if (!added) break;
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const policy = JSON.parse(await readFile(POLICY_PATH, "utf8"));
  const source = await ArticleStore.open(opts.source, { readOnly: true });
  const fresh = [];
  const replay = [];
  const retired = [];
  let after = null;
  try {
    for (;;) {
      const page = source.articlesPage({ after, limit: 200 });
      if (!page.items.length) break;
      for (const a of page.items) {
        const host = hostOf(a);
        if (!domainAllowed(host, policy)) continue;
        const text = String(a.text ?? "");
        if (text.length < opts.minChars || text.length > opts.maxChars) continue;
        const gate = preScreen(text, {
          sourceUrl: a.sourceUrl ?? null,
          htmlLang: a.htmlLang ?? null,
          languageFilter: { enabled: true, shadow: false, minConfidence: 0.8, unknownPolicy: "reject" },
          quality: { enabled: true, minBigramRatio: 0.15, maxMojibakeRatio: 0.02 },
          completeness: { mode: "enforce" },
        });
        if (gate.decision === "reject") continue;
        const item = { ...a, _host: host };
        if (a.status === STATUS.REVIEWED) fresh.push(item);
        if (isReplayPool(a) && a.consumedAt) replay.push(item);
        if (a.status === STATUS.RETIRED && a.consumedAt) retired.push(item);
      }
      after = page.nextCursor;
      if (!after) break;
    }
  } finally {
    await source.close();
  }

  const usedHashes = new Set();
  const take = (rows, limit, role) => {
    const out = [];
    for (const article of balanced(rows, limit * 4)) {
      const hash = sha256(article.text);
      if (usedHashes.has(hash)) continue;
      usedHashes.add(hash);
      out.push({ article, role });
      if (out.length >= limit) break;
    }
    return out;
  };
  const selected = [
    ...take(replay, opts.replay, "replay"),
    ...take(retired, opts.retired, "retired-replay"),
    ...take(fresh, opts.fresh, "fresh"),
  ];
  if (!selected.length) throw new Error("no eligible pilot articles found");

  await mkdir(opts.outStore, { recursive: true });
  const pilot = await ArticleStore.open(opts.outStore);
  const rows = [];
  try {
    for (const { article, role } of selected) {
      const created = await pilot.ingestArticle({
        text: article.text,
        domain: article.domain ?? "general",
        source: "pilot-import",
        model: article.model ?? null,
        rawText: article.rawText ?? article.text,
        sourceUrl: article.sourceUrl ?? null,
        fetchedContentHash: article.fetchedContentHash ?? null,
        fetchedAt: article.fetchedAt ?? null,
        htmlLang: article.htmlLang ?? null,
        extraction: article.extraction ?? null,
        reviewRequested: false,
      });
      if (created.deduped) {
        rows.push({ sourceArticleId: article.articleId, pilotArticleId: created.articleId, role, duplicate: true, textHash: sha256(article.text) });
        continue;
      }
      await pilot.recordReview({ articleId: created.articleId, verdict: "approve", authority: "human" });
      if (role !== "fresh") {
        await pilot.markConsumed([created.articleId], { runId: "pilot-seed", checkpointRole: "seed", version: "v482" });
      }
      if (role === "retired-replay") {
        await pilot.retireArticle(created.articleId, { reason: "pilot: retired after consumption; replay eligibility migrated" });
        await pilot.setReplayEligibility(created.articleId, { eligible: true, reason: "pilot migration: safe accepted text with intact provenance" });
      }
      rows.push({
        sourceArticleId: article.articleId,
        pilotArticleId: created.articleId,
        role,
        sourceUrl: article.sourceUrl ?? null,
        sourceDomain: article._host,
        textHash: sha256(article.text),
        chars: String(article.text).length,
        estimatedTokens: Math.ceil(String(article.text).length / 4),
      });
    }
    const manifest = {
      schema: "sma/knowledge-pilot-corpus@1",
      at: new Date().toISOString(),
      sourceStore: opts.source,
      pilotStore: opts.outStore,
      articleCount: rows.length,
      roleCounts: rows.reduce((acc, r) => { acc[r.role] = (acc[r.role] ?? 0) + 1; return acc; }, {}),
      estimatedTokens: rows.reduce((sum, r) => sum + (r.estimatedTokens ?? 0), 0),
      articles: rows,
      note: "Isolated pilot subset. No production article was consumed or modified. Text is not included in this manifest.",
    };
    const bytes = JSON.stringify(manifest, null, 2) + "\n";
    if (opts.manifest) await writeFile(opts.manifest, bytes, "utf8");
    else process.stdout.write(bytes);
  } finally {
    await pilot.close();
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
