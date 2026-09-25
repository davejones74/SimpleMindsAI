import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import readline from "node:readline";
import path from "node:path";
import { config } from "../config.js";
import { pairHash } from "./evaluation-set.js";

/**
 * Immutable dataset snapshots (requirement #2 + #17).
 *
 * Training NEVER reads the live buffer. A snapshot is baked ONCE into a
 * hash-sealed NDJSON file; the TrainingRun records the exact datasetId +
 * datasetVersion (+ the content hash) it consumed, so any historical run is
 * byte-for-byte reproducible. The file is never rewritten — a new snapshot is a
 * new file with a new version id.
 *
 * Two hard guards live here:
 *   - maxSyntheticShare: after collection, excess synthetic rows are dropped
 *     (lowest reward first), each drop recorded. Prevents synthetic domination.
 *   - evaluation leak guard: any row whose (prompt, completion) pair exists in
 *     the immutable evaluation set is excluded. The eval set can never be
 *     trained on.
 */
export function rowForPrompt(prompt, completion) {
  return {
    promptId: prompt.id,
    prompt: prompt.text,
    completionId: completion.id,
    completion: completion.text ?? "",
    origin: completion.origin ?? "raw",
    domain: prompt.domain ?? "general",
    reward: prompt.rewardScore,
    createdAt: prompt.createdAt ?? new Date().toISOString(),
    hash: pairHash(prompt.text, completion.text ?? ""),
  };
}

/**
 * Pull up to `limit` UNTRAINED, scored rows out of the transient buffer.
 * Reaches into the BufferStore only — the immutable snapshot is what is ever
 * given to the trainer afterwards.
 */
export function collectRowsFromBuffer(store, { limit = config.snapshotLimit, minReward = config.minReward } = {}) {
  const stats = { lowReward: 0, noCompletion: 0, collected: 0 };
  const rows = [];
  let cursor = null;
  let guard = 0;
  while (rows.length < limit && guard++ < 200) {
    const { items, nextCursor } = store.promptsPage({ after: cursor, limit: 200, trained: false });
    for (const p of items) {
      if (p.trainedAt || rows.length >= limit) continue;
      const score = p.rewardScore;
      if (score == null || score < minReward) { stats.lowReward++; continue; }
      const comps = p.completions ?? [];
      if (!comps.length) { stats.noCompletion++; continue; }
      const best = [...comps].sort((a, b) => (b.rewardScore ?? 0) - (a.rewardScore ?? 0))[0];
      rows.push(rowForPrompt(p, best));
      stats.collected++;
    }
    if (!nextCursor || rows.length >= limit) break;
    cursor = nextCursor;
  }
  return { rows, stats };
}

/** Cap synthetic rows; drops are lowest-reward-first and always recorded. */
export function enforceSyntheticCap(rows, { maxSyntheticShare = config.maxSyntheticShare } = {}) {
  const share = Math.max(0, Math.min(1, Number(maxSyntheticShare) || 0));
  const cap = Math.floor(rows.length * share);
  const synth = rows.filter((r) => r.origin === "synthetic").sort((a, b) => a.reward - b.reward);
  // keep the top `cap` by reward; drop the lowest-reward excess FIRST (each recorded)
  const discarded = Math.max(0, synth.length - cap);
  const dropped = synth.slice(0, discarded);
  const droppedIds = new Set(dropped.map((r) => r.completionId));
  return {
    rows: rows.filter((r) => !droppedIds.has(r.completionId)),
    dropped,
    cap,
  };
}

/**
 * Bake rows into an immutable snapshot and register its manifest.
 * Returns both the manifest (registry) and the on-disk artifact.
 */
export async function buildSnapshot({ registry, rowsRaw, source = "buffer", dir = config.paths.snapshots, maxSyntheticShare = config.maxSyntheticShare, evalGuard = null }) {
  await mkdir(dir, { recursive: true });

  // 1. synthetic cap
  const { rows: capped, dropped } = enforceSyntheticCap(rowsRaw, { maxSyntheticShare });

  // 2. evaluation leak guard
  let excluded = [];
  let rows = capped;
  if (evalGuard) {
    const res = evalGuard.filter(rows);
    rows = res.kept;
    excluded = res.excluded;
  }

  const datasetId = registry.nextDatasetId();
  const contents = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  const hash = createHash("sha256").update(contents, "utf8").digest("hex");
  const datasetVersion = hash.slice(0, 12);
  const file = path.join(dir, `${datasetId}-${datasetVersion}.jsonl`);
  if (!existsSync(file)) await writeFile(file, contents, "utf8");

  const syntheticCount = rows.filter((r) => r.origin === "synthetic").length;
  const manifest = await registry.createSnapshot({
    datasetId,
    datasetVersion,
    source,
    recordCount: rows.length,
    syntheticCount,
    syntheticShare: rows.length ? syntheticCount / rows.length : 0,
    file,
    hash,
    categories: Object.fromEntries(
      [...new Set(rows.map((r) => r.domain))].map((d) => [d, rows.filter((r) => r.domain === d).length])
    ),
    rowIds: rows.map((r) => r.promptId),
    droppedSynthetic: dropped.map((r) => ({ completionId: r.completionId, reward: r.reward, reason: "maxSyntheticShare-excess" })),
    leakExcluded: excluded.map((r) => r.hash),
    builderVersion: "snapshot-v1",
  });
  return { manifest, file, rows, dropped, excluded, datasetVersion, hash };
}

export const snapshotRowReader = {
  async read(file) {
    const out = [];
    if (!existsSync(file)) throw new Error(`snapshot file missing: ${file}`);
    const rl = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const raw of rl) {
      if (!raw.trim()) continue;
      try { out.push(JSON.parse(raw)); } catch {}
    }
    return out;
  },
};