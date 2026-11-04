import { spawn } from "node:child_process";
import path from "node:path";

import { config } from "../config.js";
import { PYTHON_DIR, resolvePythonBin } from "../brain/python-cli.js";
import { validationAvailability } from "./validation-status.js";

/**
 * Real tokenizer measurement for corpus/validation observability.
 *
 * Node's snapshot sizing uses a deterministic char/4 estimate. That estimate is
 * fine for planning but wrong for decisions: a 131-token estimate was measured
 * as 97 real tokens, and a 3-document "available" validation cohort could not
 * form a single 128-token block. This wrapper asks the model-free Python
 * measurement module for authoritative counts.
 */
function runMeasure({ bin, cwd, timeoutMs, signal, payload }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["-m", "sma.measure", "--tokenizer", payload.tokenizerPath, "--seq-len", String(payload.seqLen)], {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      fn(value);
    };
    const onAbort = () => {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      finish(reject, new Error("tokenizer measurement aborted"));
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      finish(reject, new Error(`tokenizer measurement timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    signal?.addEventListener?.("abort", onAbort, { once: true });
    child.on("error", (err) => finish(reject, err));
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (code) => {
      if (code !== 0) {
        finish(reject, new Error(`tokenizer measurement failed (${code}): ${stderr.slice(0, 500)}`));
        return;
      }
      try {
        finish(resolve, JSON.parse(stdout));
      } catch (err) {
        finish(reject, new Error(`tokenizer measurement returned invalid JSON: ${err.message}`));
      }
    });
    child.stdin.end(payload.rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  });
}

export async function measureDocuments(rows, {
  tokenizerPath,
  seqLen = config.trainSeqLen,
  bin = config.pythonBin ?? resolvePythonBin(),
  cwd = PYTHON_DIR,
  timeoutMs = 60_000,
  signal = null,
  run = runMeasure,
} = {}) {
  if (!tokenizerPath) throw new Error("measureDocuments requires tokenizerPath");
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      schema: "sma/token-measurement@1",
      sequenceLength: seqLen,
      documentCount: 0,
      totalTokens: 0,
      blocksIfConcatenated: 0,
      droppedTokens: 0,
      documentsMeetingOneBlock: 0,
      documents: [],
    };
  }
  return run({ bin, cwd, timeoutMs, signal, payload: { tokenizerPath, seqLen, rows } });
}

/**
 * Augment the Node validation-availability view with authoritative tokenizer
 * counts. This is read-only: it measures the currently selected cohort without
 * building a snapshot or training.
 */
export async function measureValidationAvailability(store, registry, {
  config: cfg = config,
  tokenizerPath,
  seqLen = cfg.trainSeqLen,
  run = runMeasure,
  ...measureOptions
} = {}) {
  const availability = await validationAvailability(store, registry, cfg);
  const ids = availability.validationArticleIds ?? [];
  const rows = ids
    .map((id) => store.getArticle?.(id))
    .filter(Boolean)
    .map((article) => ({ itemId: article.articleId, text: article.text ?? "" }));
  const measurement = await measureDocuments(rows, { tokenizerPath, seqLen, run, ...measureOptions });
  return {
    ...availability,
    tokenizerMeasurement: measurement,
    authoritative: {
      actualTokens: measurement.totalTokens,
      actualBlocks: measurement.blocksIfConcatenated,
      documentsMeetingOneBlock: measurement.documentsMeetingOneBlock,
      targetTokens: availability.targetTokens,
      targetBlocks: Math.ceil((availability.targetTokens ?? 0) / seqLen) || 0,
      shortfallBlocks: Math.max(0, (Math.ceil((availability.targetTokens ?? 0) / seqLen) || 0) - measurement.blocksIfConcatenated),
      available: measurement.blocksIfConcatenated > 0,
    },
  };
}
