#!/usr/bin/env node
/** Run the real recoverPendingPromotions over a file-based crash fixture. */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { recoverPendingPromotions } from "../src/training/lifecycle.js";

const root = process.env.CRASH_ROOT;
if (!root) throw new Error("CRASH_ROOT is required");
const readJson = (file, fallback = null) => {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
};
const writeJson = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
};
const appendConsumption = (ids, runId, meta = {}) => {
  const file = path.join(root, "consumption.ndjson");
  const existing = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
  const seen = new Set(existing.map((r) => `${r.runId}\u0000${r.articleId}`));
  const added = [];
  for (const articleId of ids) {
    if (seen.has(`${runId}\u0000${articleId}`)) continue;
    const rec = { articleId, runId, ...meta, at: new Date().toISOString() };
    existing.push(rec);
    added.push(rec);
  }
  writeFileSync(file, existing.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { consumed: added, skipped: ids.filter((id) => !added.some((r) => r.articleId === id)).map((id) => ({ articleId: id, reason: "already-consumed" })) };
};
const trainer = {
  async publishCandidate() { return { published: true }; },
  async setWorking(version, meta) {
    writeJson(path.join(root, "working.json"), { schema: "sma/working@1", version, ...(meta ?? {}) });
    return { version };
  },
  async setWorkingLastGood(version, meta) {
    writeJson(path.join(root, "working-last-good.json"), { schema: "sma/working@1", version, ...(meta ?? {}) });
    return { version };
  },
};
const store = {
  markConsumed: (ids, opts = {}) => appendConsumption(ids, opts.runId ?? null, opts),
  async deferArticles() { return { deferred: [], replayPool: [], skipped: [] }; },
};
const registry = { async runEvent() { return {}; } };
const recovered = await recoverPendingPromotions({
  registry,
  store,
  trainer,
  setActive: async () => { throw new Error("active pointer must not move during working recovery"); },
  options: { paths: { snapshots: path.join(root, "snapshots"), models: path.join(root, "models") } },
  logger: { error() {}, log() {} },
});
process.stdout.write(JSON.stringify({ recovered }) + "\n");
