import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { snapshotRowReader } from "../dataset/snapshot.js";

/**
 * The Trainer interface (requirement #9).
 *
 *   train(dataset, baseModel, configuration) -> TrainingResult
 *
 * `dataset` is ALWAYS a path to an immutable snapshot file (dataset/file.jsonl).
 * The trainer NEVER sees the live buffer and NEVER scrolls GraphQL. Everything
 * else in the system (GraphQL, crawler, curator, reward, planner, chat, dataset
 * storage) is deliberately decoupled from PyTorch/ONNX/CUDA — they only speak
 * to this interface. Swapping the stub for a real backprop implementation is a
 * one-file change, not a rewrite.
 *
 * Contract the lifecycle relies on:
 *   - it only mutates the filesystem (checkpoint dir) and returns a result;
 *   - it does NOT mark data consumed — the lifecycle commits consumption AFTER
 *     this resolves (exactly-once, crash-safe).
 */
export function assertTrainer(trainer) {
  if (!trainer || typeof trainer.train !== "function") {
    throw new Error("trainer must implement train({ datasetFile, baseModel, runId, configuration })");
  }
  return trainer;
}

/**
 * Stub trainer — computes deterministic aggregate statistics over the snapshot
 * and persists a checkpoint placeholder. No gradient, no GPU, no framework.
 * It exists to keep the LIFECYCLE honest (statuses, promotion, provenance) long
 * before any actual learning does.
 */
export function stubTrainer(overrides = {}) {
  return {
    kind: "stub",
    version: config.trainerVersion,
    async train({ datasetFile, baseModel, runId, configuration = {} }) {
      const rows = await snapshotRowReader.read(datasetFile);
      const rewards = rows.map((r) => Number(r.reward ?? 0)).filter(Number.isFinite);
      const avgReward = rewards.length ? rewards.reduce((a, b) => a + b, 0) / rewards.length : 0;
      const avgLoss = 1 - avgReward / 10;
      const checkpointDir = (configuration?.checkpointDir) ?? config.paths.models;
      const checkpointPath = path.join(checkpointDir, String(runId), "checkpoint.json");
      await mkdir(path.dirname(checkpointPath), { recursive: true });
      await writeFile(
        checkpointPath,
        JSON.stringify(
          {
            meta: {
              generatedAt: new Date().toISOString(),
              trainerKind: "stub",
              trainerVersion: this.version,
              baseModel,
              runId,
              datasetFile,
              recordsProcessed: rows.length,
            },
            stats: {
              avgReward,
              avgLoss,
              domains: Object.fromEntries(
                [...new Set(rows.map((r) => r.domain))].map((d) => [d, rows.filter((r) => r.domain === d).length])
              ),
              origins: Object.fromEntries(
                [...new Set(rows.map((r) => r.origin))].map((o) => [o, rows.filter((r) => r.origin === o).length])
              ),
            },
            note: "placeholder training artifact — real kernels arrive after Phase 2",
          },
          null,
          2
        ),
        "utf8"
      );
      const t0 = performance.now();
      return {
        ...overrides.result,
        checkpointPath,
        recordsProcessed: rows.length,
        skipped: 0,
        avgReward,
        avgLoss,
        durationMs: Math.round(performance.now() - t0),
      };
    },
  };
}