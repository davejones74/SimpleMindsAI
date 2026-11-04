#!/usr/bin/env node
/**
 * Isolated end-to-end curation/training experiment.
 *
 * Compares legacy (14k), segmented (full-source) and raw-text curation on the
 * same parent checkpoint, corpus sources and sealed prospective/retention
 * cohorts. It uses an isolated copy of the parent store and never touches
 * production.
 *
 * Usage:
 *   node scripts/learning-effectiveness/run-curation-experiment.mjs \
 *     --workdir /tmp/opencode/sma-curation-experiment \
 *     --parent-store /var/lib/simpleminds/store \
 *     --parent-version v493 \
 *     --python /opt/simpleminds/python/.venv/bin/python \
 *     [--force]
 */
import { mkdir, readFile, writeFile, cp, rm, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { resolveLicence } from "../../src/domain/licence.js";
import { preScreen } from "../../src/domain/review-gates.js";

const DEFAULT_MODES = ["legacy", "segmented", "raw-text"];

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i >= 0) return process.argv[i + 1];
  const pref = `${name}=`;
  const found = process.argv.find((v) => v.startsWith(pref));
  return found ? found.slice(pref.length) : fallback;
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

async function readJson(file) { return JSON.parse(await readFile(file, "utf8")); }
async function readJsonl(file) {
  return (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

const workdir = arg("--workdir");
const parentStore = arg("--parent-store", "/var/lib/simpleminds/store");
const parentVersion = arg("--parent-version", "v493");
const python = arg("--python", "/opt/simpleminds/python/.venv/bin/python");
const force = process.argv.includes("--force");
const suffix = arg("--suffix", "");
const fixedSteps = Number(arg("--fixed-steps", "0")) || 0;
const modes = String(arg("--modes", DEFAULT_MODES.join(","))).split(",").map((m) => m.trim()).filter(Boolean);
if (!workdir) throw new Error("--workdir is required");

const storesDir = path.join(workdir, "stores");
const resultsDir = path.join(workdir, "results");
await mkdir(storesDir, { recursive: true });
await mkdir(resultsDir, { recursive: true });

function run(verb, args, { timeout = 1_800_000 } = {}) {
  const r = spawnSync(python, ["-m", "sma.brain", verb, ...args], {
    cwd: path.resolve("python"),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout,
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`${verb} failed (${r.status}): ${(r.stderr ?? "").slice(-2000)}`);
  }
  try { return JSON.parse(r.stdout); } catch (err) {
    throw new Error(`${verb} returned invalid JSON: ${err.message}\n${r.stdout.slice(0, 1000)}`);
  }
}

async function prepareStore(storeKey) {
  const store = path.join(storesDir, storeKey);
  if (force && await exists(store)) await rm(store, { recursive: true, force: true });
  await mkdir(path.join(store, "_runs"), { recursive: true });
  if (!(await exists(path.join(store, parentVersion, "COMMITTED")))) {
    await cp(path.join(parentStore, parentVersion), path.join(store, parentVersion), { recursive: true });
  }
  const state = path.join(parentStore, "_runs", `${parentVersion}.train-state.pt`);
  const dest = path.join(store, "_runs", `${parentVersion}.train-state.pt`);
  if ((await exists(state)) && !(await exists(dest))) await cp(state, dest);
  return { store, hasCarryState: await exists(dest) };
}

function qualityMetrics(rows) {
  const result = { rows: rows.length, pass: 0, reject: 0, quarantine: 0, byGate: {}, licence: {} };
  for (const row of rows) {
    const gate = preScreen(row.text, {
      sourceUrl: row.sourceUrl ?? null,
      languageFilter: { enabled: true, shadow: false, minConfidence: 0.8, unknownPolicy: "reject" },
      quality: { enabled: true, maxMojibakeRatio: 0.02, minBigramRatio: 0.15 },
      completeness: { mode: "shadow" },
    });
    if (gate.decision === "reject") { result.reject += 1; result.byGate[gate.gate ?? "unknown"] = (result.byGate[gate.gate ?? "unknown"] ?? 0) + 1; }
    else { result.pass += 1; if (gate.completeness?.decision === "quarantine") result.quarantine += 1; }
    const licence = resolveLicence({ sourceUrl: row.sourceUrl ?? null });
    result.licence[licence.status] = (result.licence[licence.status] ?? 0) + 1;
  }
  result.passRate = result.rows ? result.pass / result.rows : null;
  return result;
}

function paired(parentEval, candidateEval) {
  const p = new Map((parentEval.perDocument ?? []).map((row) => [row.articleId ?? row.itemId, row]));
  const rows = [];
  for (const row of candidateEval.perDocument ?? []) {
    const key = row.articleId ?? row.itemId;
    const before = p.get(key);
    if (!before || !Number.isFinite(before.loss) || !Number.isFinite(row.loss)) continue;
    rows.push({ itemId: key, tokens: row.tokens ?? before.tokens ?? null, parentLoss: before.loss, candidateLoss: row.loss, delta: row.loss - before.loss });
  }
  const deltas = rows.map((r) => r.delta);
  const sorted = [...rows].sort((a, b) => a.delta - b.delta);
  return {
    documentsCompared: rows.length,
    meanDelta: deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null,
    worseCount: deltas.filter((d) => d > 0).length,
    over005: deltas.filter((d) => d > 0.05).length,
    over015: deltas.filter((d) => d > 0.15).length,
    best: sorted[0] ?? null,
    worst: sorted.at(-1) ?? null,
  };
}

const tokenMeasurements = await readJson(path.join(workdir, "token-measurements.json"));
const corpusManifest = await readJson(path.join(workdir, "corpus-manifest.json"));
const prospectiveFile = path.join(workdir, "cohorts", "prospective.jsonl");
const retentionFile = path.join(workdir, "cohorts", "retention.jsonl");
const summary = {
  schema: "sma/curation-experiment@1",
  at: new Date().toISOString(),
  workdir,
  parentVersion,
  python,
  tokenizer: tokenMeasurements.tokenizer,
  cohorts: {
    prospective: { file: prospectiveFile, ...tokenMeasurements.cohorts.prospective, manifest: corpusManifest.prospective },
    retention: { file: retentionFile, ...tokenMeasurements.cohorts.retention, manifest: corpusManifest.retention },
  },
  modes: {},
};

for (const mode of modes) {
  const storeKey = `${mode}${suffix}`;
  console.log(`\n=== ${storeKey} ===`);
  const { store, hasCarryState } = await prepareStore(storeKey);
  const corpusFile = path.join(workdir, "corpora", `${mode}.jsonl`);
  const rows = await readJsonl(corpusFile);
  const validationRows = rows.filter((r) => r.corpusRole === "validation");
  const validationFile = path.join(workdir, "corpora", `${mode}-validation.jsonl`);
  await writeFile(validationFile, validationRows.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const preflight = run("corpus-info", [
    "--parent", parentVersion, "--corpus", corpusFile, "--seq-len", "128",
    "--val-blocks", "32", "--validation-policy", "document-source-disjoint",
    "--require-prospective-validation", "--out", store,
  ]);
  if (preflight.ok === false) throw new Error(`${mode} preflight failed: ${preflight.error}`);
  const trainBlocks = Number(preflight.trainBlockCount ?? preflight.blockCount ?? 0);
  const steps = fixedSteps > 0 ? fixedSteps : Math.max(1, Math.min(300, Math.ceil((2 * trainBlocks) / 4)));
  console.log(`blocks=${trainBlocks} val=${preflight.validationBlockCount} steps=${steps}`);

  const trainArgs = [
    "--parent", parentVersion, "--corpus", corpusFile, "--version", "v494",
    "--out", store, "--lr", "1e-4", "--steps", String(steps),
    "--seq-len", "128", "--micro-batch", "2", "--grad-accum", "2", "--warmup", "10",
    "--val-blocks", "32", "--validation-policy", "document-source-disjoint",
    "--require-prospective-validation", "--device", "auto", "--compute-dtype", "bfloat16",
    "--eval-every", "20", "--select-best", ...(hasCarryState ? ["--carry-optimizer"] : []),
  ];
  const train = run("train", trainArgs);
  if (train.ok === false) throw new Error(`${mode} train failed: ${train.error}`);

  const evals = {};
  for (const [label, file] of [["prospective", prospectiveFile], ["retention", retentionFile], ["validation", validationFile]]) {
    evals[label] = {
      parent: run("eval", ["--version", parentVersion, "--eval-set", file, "--seq-len", "128", "--micro-batch", "2", "--device", "auto", "--per-document", "--verify-weights", "--out", store]),
      candidate: run("eval", ["--version", "v494", "--eval-set", file, "--seq-len", "128", "--micro-batch", "2", "--device", "auto", "--per-document", "--verify-weights", "--out", store]),
    };
    evals[label].paired = paired(evals[label].parent, evals[label].candidate);
    evals[label].improvement = evals[label].parent.evalLoss - evals[label].candidate.evalLoss;
  }

  const result = {
    mode,
    storeKey,
    fixedSteps: fixedSteps > 0 ? fixedSteps : null,
    store,
    corpus: corpusManifest.corpora[mode],
    actualTokens: tokenMeasurements.corpora[mode],
    quality: qualityMetrics(rows),
    preflight,
    steps,
    train: {
      ok: train.ok,
      version: train.version,
      parentVersion: train.parentVersion,
      stepsCompleted: train.trainState?.stepsCompleted ?? train.stepsCompleted ?? null,
      finalTrainLoss: train.trainState?.finalTrainLoss ?? train.finalTrainLoss ?? null,
      finalValidationLoss: train.trainState?.finalValidationLoss ?? train.finalValidationLoss ?? null,
      selectedValidationLoss: train.trainState?.selectedValidationLoss ?? train.selectedValidationLoss ?? null,
      wallSeconds: train.wallSeconds ?? train.trainState?.wallSeconds ?? null,
      tokensSeen: train.trainState?.tokensSeen ?? train.tokensSeen ?? null,
      optimizerMode: train.trainState?.optimizerMode ?? null,
      carryOptimizerFrom: train.trainState?.carryOptimizerFrom ?? null,
      raw: train,
    },
    evals: Object.fromEntries(Object.entries(evals).map(([key, value]) => [key, {
      parentLoss: value.parent.evalLoss,
      candidateLoss: value.candidate.evalLoss,
      improvement: value.improvement,
      paired: value.paired,
      blocks: value.candidate.evaluationSet?.blockCount ?? null,
      tokens: value.candidate.evaluationSet?.tokensSeen ?? null,
    }])),
  };
  summary.modes[storeKey] = result;
  await mkdir(path.join(resultsDir, storeKey), { recursive: true });
  await writeFile(path.join(resultsDir, storeKey, "train.json"), JSON.stringify(train, null, 2));
  await writeFile(path.join(resultsDir, storeKey, "evals.json"), JSON.stringify(evals, null, 2));
  await writeFile(path.join(resultsDir, storeKey, "result.json"), JSON.stringify(result, null, 2));
  console.log(`prospective Δ ${result.evals.prospective.improvement.toFixed(6)} | retention Δ ${result.evals.retention.improvement.toFixed(6)} | validation Δ ${result.evals.validation.improvement.toFixed(6)}`);
}

await writeFile(path.join(resultsDir, `experiment-summary${suffix ? `-${suffix}` : ""}.json`), JSON.stringify(summary, null, 2));
console.log(`\nsummary written to ${path.join(resultsDir, `experiment-summary${suffix ? `-${suffix}` : ""}.json`)}`);
