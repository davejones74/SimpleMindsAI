#!/usr/bin/env node
/**
 * Read-only baseline capture for the knowledge-accumulation pilot.
 * Writes a machine-readable JSON report; never mutates the source stores.
 */
import { createReadStream, existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

import { ArticleStore } from "../../src/storage/article-store.js";
import { RegistryStore } from "../../src/storage/registry-store.js";

const DEFAULTS = {
  articles: "/var/lib/simpleminds/data/articles",
  registry: "/var/lib/simpleminds/data/registry",
  frontier: "/var/lib/simpleminds/data/frontier/frontier.ndjson",
  store: "/var/lib/simpleminds/store",
  out: null,
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--articles") opts.articles = argv[++i];
    else if (arg === "--registry") opts.registry = argv[++i];
    else if (arg === "--frontier") opts.frontier = argv[++i];
    else if (arg === "--store") opts.store = argv[++i];
    else if (arg === "--out") opts.out = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/knowledge-pilot/collect-baseline.mjs --out baseline.json [--articles DIR] [--registry DIR] [--frontier FILE] [--store DIR]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

async function countLines(file) {
  if (!existsSync(file)) return 0;
  const rl = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let count = 0;
  for await (const line of rl) if (line.trim()) count += 1;
  return count;
}

async function frontierCounts(file) {
  const state = new Map();
  if (!existsSync(file)) return { total: 0, byState: {}, topErrors: {} };
  const rl = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.url) state.set(row.url, row);
    } catch { /* skip corrupt tail */ }
  }
  const byState = {};
  const topErrors = {};
  for (const row of state.values()) {
    byState[row.state] = (byState[row.state] ?? 0) + 1;
    const err = typeof row.lastError === "string" ? row.lastError : row.lastError?.reason ?? row.lastError?.code ?? null;
    if (err) topErrors[err] = (topErrors[err] ?? 0) + 1;
  }
  return { total: state.size, byState, topErrors };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const store = await ArticleStore.open(opts.articles, { readOnly: true });
  const registry = await RegistryStore.open(opts.registry, { readOnly: true });
  const stats = store.getStats();
  const activeFile = path.join(opts.store, "active.json");
  const workingFile = path.join(opts.store, "working.json");
  const active = existsSync(activeFile) ? JSON.parse(await readFile(activeFile, "utf8")) : null;
  const working = existsSync(workingFile) ? JSON.parse(await readFile(workingFile, "utf8")) : null;
  const versions = existsSync(opts.store)
    ? (await readFile(path.join(opts.store, "_allocations.ndjson"), "utf8").catch(() => "")).split(/\r?\n/).filter(Boolean).length
    : 0;
  const report = {
    schema: "sma/knowledge-pilot-baseline@1",
    at: new Date().toISOString(),
    gitHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    gitBranch: execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim(),
    paths: { articles: opts.articles, registry: opts.registry, frontier: opts.frontier, store: opts.store },
    active,
    working,
    articles: stats,
    articleLedger: {
      articleLines: await countLines(path.join(opts.articles, "articles.ndjson")),
      reviewLines: await countLines(path.join(opts.articles, "reviews.ndjson")),
      eventLines: await countLines(path.join(opts.articles, "article-events.ndjson")),
      consumptionLines: await countLines(path.join(opts.articles, "consumption.ndjson")),
      contributionLines: await countLines(path.join(opts.articles, "training-contribution.ndjson")),
      rawSourceLines: await countLines(path.join(opts.articles, "raw-sources.ndjson")),
    },
    registry: {
      runRecords: registry.listRuns().length,
      snapshotRecords: registry.listSnapshots().length,
      evaluationRecords: registry.listEvaluations().length,
      modelRecords: registry.listModels().length,
      runEventLines: await countLines(path.join(opts.registry, "run-events.ndjson")),
      modelEventLines: await countLines(path.join(opts.registry, "model-events.ndjson")),
    },
    frontier: await frontierCounts(opts.frontier),
    store: {
      allocatedVersions: versions,
      workingPointer: working,
      activePointer: active,
      staleTmpDirs: existsSync(opts.store) ? (await readFile("/dev/null").catch(() => "")) && null : null,
    },
    contributionSummary: {
      totalRuns: store.listContributions().length,
      promotedRuns: store.listContributions().filter((r) => r.decision === "promoted").length,
      rejectedRuns: store.listContributions().filter((r) => r.decision !== "promoted").length,
      uniqueBatchArticles: new Set(store.listContributions().flatMap((r) => [...(r.freshArticleIds ?? []), ...(r.replayArticleIds ?? [])])).size,
      uniquePromotedArticles: new Set(store.listContributions().filter((r) => r.decision === "promoted").flatMap((r) => [...(r.freshArticleIds ?? []), ...(r.replayArticleIds ?? [])])).size,
    },
  };
  const bytes = JSON.stringify(report, null, 2) + "\n";
  if (opts.out) await writeFile(opts.out, bytes, "utf8");
  else process.stdout.write(bytes);
  await store.close();
  await registry.close();
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
