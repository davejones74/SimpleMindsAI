import path from "node:path";
import { runPython, resolveStoreRoot } from "../brain/python-cli.js";
import { config } from "../config.js";

/**
 * The real Trainer: a thin Node adapter over `python -m sma.brain train`.
 *
 * There is no fallback. If Python is unreachable, the store has no committed
 * baseline, or training fails its own numerical guards, `train` throws and the
 * lifecycle records a failed run — a stub is never silently substituted
 * (that only happens when the operator selects `TRAINER_KIND=stub`).
 *
 * Baseline resolution is explicit and fail-closed:
 *   - the store's `active.json` pointer is authoritative;
 *   - committed versions with no active pointer require an explicit `--adopt`
 *     (we never guess which lineage root to train from);
 *   - an active pointer naming a non-committed version is treated as corrupt.
 */

export class NoBaselineError extends Error {
  constructor(message, { store = null } = {}) {
    super(message);
    this.name = "NoBaselineError";
    this.store = store;
  }
}

function storeRoot(store) {
  return store ?? resolveStoreRoot();
}

/** Resolve the committed baseline version the next run must train from. */
export async function resolvePythonBaseline({
  store = config.pythonStore ?? undefined,
  bin = config.pythonBin ?? undefined,
  run = runPython,
  timeoutMs = 120_000,
} = {}) {
  const root = storeRoot(store);

  let status;
  try {
    status = await run(["status"], { store, bin, timeoutMs });
  } catch (err) {
    throw new NoBaselineError(
      `cannot reach the Python store at ${root}: ${err.message}. ` +
        "Run `npm run init:brain` to create a baseline.",
      { store: root },
    );
  }

  const committed = (status.versions ?? []).filter((v) => v.committed);
  const committedNames = committed.map((v) => v.version);

  let activeVersion = null;
  try {
    const active = await run(["active"], { store, bin, timeoutMs });
    activeVersion = active?.activeVersion ?? null;
  } catch {
    activeVersion = null;
  }

  if (activeVersion) {
    if (!committedNames.includes(activeVersion)) {
      throw new NoBaselineError(
        `active pointer names ${activeVersion}, which is not committed in ${root}. ` +
          "Refusing to train from an inconsistent store; re-activate a committed version " +
          "or run `npm run init:brain -- --adopt <version>`.",
        { store: root },
      );
    }
    return { version: activeVersion, path: path.join(root, activeVersion) };
  }

  if (committedNames.length) {
    const newest = committedNames[committedNames.length - 1];
    throw new NoBaselineError(
      `store ${root} has committed version(s) (${committedNames.join(", ")}) but no active ` +
        `pointer. Run \`npm run init:brain -- --adopt ${newest}\` to choose the baseline explicitly.`,
      { store: root },
    );
  }

  throw new NoBaselineError(
    `no committed Python baseline in ${root}. Run \`npm run init:brain\` to create one.`,
    { store: root },
  );
}

/**
 * @returns {{kind:"python", version, resolveBaseline, train}}
 */
export function pythonTrainer({
  store = config.pythonStore ?? undefined,
  bin = config.pythonBin ?? undefined,
  device = config.studentDevice,
  learningRate = config.trainLearningRate,
  steps = config.trainSteps,
  seqLen = config.trainSeqLen,
  microBatch = config.trainMicroBatch,
  gradAccum = config.trainGradAccum,
  warmup = config.trainWarmup,
  valBlocks = config.trainValBlocks,
  computeDtype = config.trainComputeDtype,
  timeoutMs = config.trainTimeoutMs,
  run = runPython,
  version = config.pythonTrainerVersion,
} = {}) {
  const root = storeRoot(store);
  const resolvedDtype = device === "cpu" ? "float32" : computeDtype;

  return {
    kind: "python",
    version,
    resolveBaseline: () => resolvePythonBaseline({ store, bin, run }),

    async train({ datasetFile, runId, configuration = {} }) {
      if (!datasetFile) {
        throw new Error("pythonTrainer.train requires datasetFile (immutable corpus path)");
      }
      const parentVersion =
        configuration.parentVersion ?? (await resolvePythonBaseline({ store, bin, run })).version;

      const args = [
        "train",
        "--parent", parentVersion,
        "--corpus", datasetFile,
        "--lr", String(learningRate),
        "--steps", String(steps),
        "--seq-len", String(seqLen),
        "--micro-batch", String(microBatch),
        "--grad-accum", String(gradAccum),
        "--warmup", String(warmup),
        "--val-blocks", String(valBlocks),
        "--compute-dtype", resolvedDtype,
        "--device", device,
      ];
      if (runId) args.push("--run-id", String(runId));

      const t0 = Date.now();
      const out = await run(args, { store, bin, timeoutMs });
      if (!out.ok || out.published === false) {
        throw new Error(`python training did not publish (${out.kind ?? "error"}): ${out.error ?? "unknown"}`);
      }

      return {
        checkpointPath: out.checkpointPath ?? path.join(root, out.version),
        version: out.version,
        parentVersion: out.parentVersion ?? parentVersion,
        trainingRunId: out.trainingRunId ?? null,
        nodeRunId: out.nodeRunId ?? runId ?? null,
        datasetHash: out.datasetHash ?? null,
        recordsProcessed: out.articleCount ?? configuration.recordCount ?? null,
        skipped: 0,
        initialTrainLoss: out.initialTrainLoss ?? null,
        finalTrainLoss: out.finalTrainLoss ?? null,
        finalValidationLoss: out.finalValidationLoss ?? null,
        avgLoss: out.finalTrainLoss ?? null,
        tokensSeen: out.tokensSeen ?? null,
        blockCount: out.blockCount ?? null,
        device: out.device ?? device,
        durationMs: out.durationMs ?? Date.now() - t0,
        cfg: { lr: learningRate, steps, seqLen, microBatch, gradAccum, warmup, computeDtype: resolvedDtype },
        note: "python causal-LM training",
      };
    },
  };
}
