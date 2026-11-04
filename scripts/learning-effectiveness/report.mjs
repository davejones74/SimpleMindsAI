#!/usr/bin/env node
/**
 * Read-only cumulative-learning-effectiveness report.
 *
 * Usage:
 *   node scripts/learning-effectiveness/report.mjs \
 *     --data-root /var/lib/simpleminds/data \
 *     [--store /var/lib/simpleminds/store] \
 *     [--out report.json] [--markdown report.md]
 *
 * It never writes to the data root or store. It reads durable ledgers only.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  buildLearningEffectiveness,
  renderLearningEffectivenessMarkdown,
} from "../../src/training/learning-effectiveness.js";

function parseArgs(argv) {
  const out = { dataRoot: null, store: null, out: null, markdown: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--data-root") out.dataRoot = argv[++i];
    else if (arg.startsWith("--data-root=")) out.dataRoot = arg.slice("--data-root=".length);
    else if (arg === "--store") out.store = argv[++i];
    else if (arg.startsWith("--store=")) out.store = arg.slice("--store=".length);
    else if (arg === "--out") out.out = argv[++i];
    else if (arg.startsWith("--out=")) out.out = arg.slice("--out=".length);
    else if (arg === "--markdown") out.markdown = argv[++i];
    else if (arg.startsWith("--markdown=")) out.markdown = arg.slice("--markdown=".length);
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/learning-effectiveness/report.mjs --data-root <data> [--store <store>] [--out report.json] [--markdown report.md]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); } catch { /* skip corrupt tail */ }
  }
  return out;
}

function readJson(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

const args = parseArgs(process.argv.slice(2));
const dataRoot = args.dataRoot ?? process.env.DATA_DIR ?? path.resolve("data");
const registry = path.join(dataRoot, "registry");
const evaluations = readJsonl(path.join(registry, "evaluations.ndjson"));
const contributions = readJsonl(path.join(dataRoot, "articles", "training-contribution.ndjson"));
const modelEvents = readJsonl(path.join(registry, "model-events.ndjson"));
const pointers = {
  active: args.store ? readJson(path.join(args.store, "active.json")) : null,
  working: args.store ? readJson(path.join(args.store, "working.json")) : null,
  workingLastGood: args.store ? readJson(path.join(args.store, "working-last-good.json")) : null,
};

const stableBaselineVersion = pointers.active?.version
  ?? [...new Set(contributions.map((c) => c.stableBaselineVersion).filter(Boolean))].at(-1)
  ?? null;
const stableEval = evaluations
  .filter((e) => e.kind === "baseline" && e.ok && Number.isFinite(Number(e.loss)) && (!stableBaselineVersion || e.version === stableBaselineVersion))
  .sort((a, b) => String(a.at ?? "").localeCompare(String(b.at ?? "")))
  .at(-1);
const stableLoss = stableEval ? Number(stableEval.loss) : null;

const report = buildLearningEffectiveness({
  contributions,
  evaluations,
  modelEvents,
  stableBaselineVersion,
  stableLoss,
  pointers,
});

const json = `${JSON.stringify(report, null, 2)}\n`;
const markdown = renderLearningEffectivenessMarkdown(report);
if (args.out) writeFileSync(args.out, json);
if (args.markdown) writeFileSync(args.markdown, markdown);
if (!args.out && !args.markdown) process.stdout.write(json);
else {
  console.log(`learning-effectiveness: ${report.effect.summary.measured}/${report.effect.summary.advances} working advances measured`);
  console.log(`stable=${stableBaselineVersion ?? "unknown"} loss=${stableLoss ?? "unavailable"} netDeltaVsStable=${report.effect.summary.netDeltaVsStable ?? "unavailable"}`);
}
