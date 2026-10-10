import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { snapshotRowReader } from "../dataset/snapshot.js";
import { pythonTrainer } from "./python-trainer.js";

/**
 * Select the trainer from `TRAINER_KIND` (config, env-overridable at runtime).
 *
 * The default is the real Python trainer. The stub is selected ONLY by an
 * explicit `TRAINER_KIND=stub`; an unknown kind is a hard error rather than a
 * silent fallback, because a silent fallback would mean "we thought we trained
 * the brain" while no gradients ran.
 */
export function selectTrainer({ kind = config.trainerKind, ...opts } = {}) {
  if (kind === "python") return pythonTrainer(opts);
  if (kind === "stub") return stubTrainer(opts);
  throw new Error(`unknown TRAINER_KIND ${JSON.stringify(kind)}: expected 'python' or 'stub'`);
}

/**
 * The Trainer interface (requirement #9).
 *
 *   train(dataset, baseModel, configuration) -> TrainingResult
 *
 * `dataset` is ALWAYS a path to an immutable snapshot file (dataset/file.jsonl).
 * The trainer NEVER sees the live buffer and NEVER scrolls GraphQL. Everything
 * else in the system (GraphQL, crawler, curator, reward, planner, chat, dataset
 * storage) is deliberately decoupled from PyTorch/ONNX/CUDA — they only speak
 * to this interface.
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
 * Stub trainer — computes deterministic aggregate statistics over the article
 * snapshot and persists a checkpoint placeholder. No gradient, no GPU, no
 * framework. It exists to keep the LIFECYCLE honest (statuses, promotion,
 * provenance) long before real training arrives in Phase 2.
 */
export function stubTrainer({ overrides = {} } = {}) {
  return {
    kind: "stub",
    version: config.trainerVersion,
    train: async ({ datasetFile, baseModel, runId, configuration = {} }) => {
      const rows = await snapshotRowReader.read(datasetFile);
      const importanceMix = Object.fromEntries(
        ["Normal", "Important", "Critical"].map((i) => [i, rows.filter((r) => r.importance === i).length]),
      );
      const domains = Object.fromEntries(
        [...new Set(rows.map((r) => r.domain))].map((d) => [d, rows.filter((r) => r.domain === d).length]),
      );
      const origins = Object.fromEntries(
        [...new Set(rows.map((r) => r.origin))].map((o) => [o, rows.filter((r) => r.origin === o).length]),
      );
      const avgLoss = rows.length ? 1 : null; // placeholder — no real kernels
      const checkpointPath = path.join(configuration.checkpointDir ?? config.paths.models, runId, "checkpoint.json");
      await mkdir(path.dirname(checkpointPath), { recursive: true });
      await writeFile(
        checkpointPath,
        JSON.stringify(
          {
            meta: {
              at: new Date().toISOString(),
              trainerKind: "stub",
              trainerVersion: config.trainerVersion,
              baseModel,
              runId,
              datasetFile,
              articlesProcessed: rows.length,
            },
            stats: { avgLoss, importanceMix, domains, origins },
            note: "placeholder training artifact — real kernels arrive after Phase 2",
          },
          null,
          2,
        ),
        "utf8",
      );
      const t0 = Date.now();
      return {
        ...overrides.result,
        checkpointPath,
        recordsProcessed: rows.length,
        skipped: 0,
        avgLoss,
        importanceMix,
        durationMs: Date.now() - t0,
      };
    },
  };
}