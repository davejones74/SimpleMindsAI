import path from "node:path";
import { REPO_ROOT, runPython, resolveStoreRoot } from "../brain/python-cli.js";
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
  signal = null,
} = {}) {
  const root = storeRoot(store);

  let status;
  try {
    status = await run(["status"], { store, bin, timeoutMs, signal });
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
    const active = await run(["active"], { store, bin, timeoutMs, signal });
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
 * Resolve an EXPLICIT committed parent version (the dashboard's training-parent
 * selector). Fail-closed and symmetric with `resolvePythonBaseline`: an unknown,
 * uncommitted, or integrity-failing version is never silently swapped for the
 * active pointer.
 */
export async function resolvePythonVersion(version, {
  store = config.pythonStore ?? undefined,
  bin = config.pythonBin ?? undefined,
  run = runPython,
  timeoutMs = 120_000,
  signal = null,
} = {}) {
  const root = storeRoot(store);
  if (!version) throw new NoBaselineError("a parent version is required", { store: root });

  let status;
  try {
    status = await run(["status"], { store, bin, timeoutMs, signal });
  } catch (err) {
    throw new NoBaselineError(`cannot reach the Python store at ${root}: ${err.message}`, { store: root });
  }
  const entry = (status.versions ?? []).find((v) => v.version === version);
  if (!entry) throw new NoBaselineError(`requested parent ${version} does not exist in ${root}`, { store: root });
  if (!entry.committed) throw new NoBaselineError(`requested parent ${version} is not committed in ${root}`, { store: root });
  if (entry.artifactNameError || !entry.artifactName) {
    throw new NoBaselineError(
      `requested parent ${version} failed integrity check (${entry.artifactNameError ?? "no artifact name"})`,
      { store: root },
    );
  }
  return { version, path: path.join(root, version) };
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
  evalEvery = config.trainEvalEvery,
  computeDtype = config.trainComputeDtype,
  timeoutMs = config.trainTimeoutMs,
  run = runPython,
  version = config.pythonTrainerVersion,
  signal = null,
} = {}) {
  const root = storeRoot(store);
  const resolvedDtype = device === "cpu" ? "float32" : computeDtype;

  return {
    kind: "python",
    version,
    resolveBaseline: () => resolvePythonBaseline({ store, bin, run, signal }),
    resolveVersion: (v) => resolvePythonVersion(v, { store, bin, run, signal }),

    /**
     * Cheap, read-only corpus preflight. Loads only the parent tokenizer and
     * packs the corpus, so the lifecycle can refuse — or wait — before spending
     * a TrainingRun. Returns the `corpus-info` payload: `{ ok, blockCount, … }`,
     * or `{ ok:false, code:"INSUFFICIENT_CORPUS", ... }` when the corpus cannot
     * form one block. Distinct from `train`, which would also load the model.
     */
    async preflight({ datasetFile, parentVersion = null, valBlocks: requestedValBlocks } = {}) {
      if (!datasetFile) {
        throw new Error("pythonTrainer.preflight requires datasetFile (immutable corpus path)");
      }
      const corpusFile = path.isAbsolute(datasetFile) ? datasetFile : path.resolve(REPO_ROOT, datasetFile);
      const parent =
        parentVersion ?? (await resolvePythonBaseline({ store, bin, run, signal })).version;
      const blocks = Number.isInteger(requestedValBlocks) && requestedValBlocks >= 0
        ? requestedValBlocks
        : valBlocks;
      return run(
        [
          "corpus-info",
          "--parent", parent,
          "--corpus", corpusFile,
          "--seq-len", String(seqLen),
          "--val-blocks", String(blocks),
        ],
        { store, bin, timeoutMs, signal },
      );
    },

    async train({ datasetFile, runId, configuration = {}, stageOnly = false }) {
      if (!datasetFile) {
        throw new Error("pythonTrainer.train requires datasetFile (immutable corpus path)");
      }
      // The Python child runs from python/ while the lifecycle hands us
      // repo-root-relative paths (data/snapshots/...). Resolve them here so the
      // corpus is found regardless of the child's cwd.
      const corpusFile = path.isAbsolute(datasetFile) ? datasetFile : path.resolve(REPO_ROOT, datasetFile);
      const parentVersion =
        configuration.parentVersion ?? (await resolvePythonBaseline({ store, bin, run, signal })).version;

      const runSteps = Number.isInteger(configuration.steps) && configuration.steps > 0
        ? configuration.steps
        : steps;
      const runValBlocks = Number.isInteger(configuration.valBlocks) && configuration.valBlocks >= 0
        ? configuration.valBlocks
        : valBlocks;
      const runEvalEvery = Number.isInteger(configuration.evalEvery) && configuration.evalEvery >= 0
        ? configuration.evalEvery
        : evalEvery;
      const args = [
        "train",
        "--parent", parentVersion,
        "--corpus", corpusFile,
        "--lr", String(learningRate),
        "--steps", String(runSteps),
        "--seq-len", String(seqLen),
        "--micro-batch", String(microBatch),
        "--grad-accum", String(gradAccum),
        "--warmup", String(warmup),
        "--val-blocks", String(runValBlocks),
        "--eval-every", String(runEvalEvery),
        "--compute-dtype", resolvedDtype,
        "--device", device,
      ];
      if (runId) args.push("--run-id", String(runId));
      // Commit-on-promotion: build the checkpoint but leave it UNPUBLISHED
      // (`vNNN.tmp`); the lifecycle publishes it only on a real promotion.
      if (stageOnly) args.push("--stage-only");

      const t0 = Date.now();
      const out = await run(args, { store, bin, timeoutMs, signal });
      if (!out.ok || (!stageOnly && out.published === false)) {
        const err = new Error(
          `python training did not publish (${out.kind ?? "error"}): ${out.error ?? "unknown"}`,
        );
        // Carry the Python failure kind across the process boundary so the
        // supervisor can tell "too little material" (wait) from a real fault
        // (fail the job).
        err.code = out.code ?? (out.kind === "insufficient_corpus" ? "INSUFFICIENT_CORPUS" : undefined);
        err.pythonKind = out.kind ?? null;
        throw err;
      }

      const staged = out.staged ?? (stageOnly && out.published === false);
      const checkpointPath =
        out.checkpointPath ?? path.join(root, staged ? `${out.version}.tmp` : out.version);
      return {
        checkpointPath,
        version: out.version,
        staged,
        published: out.published !== false,
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
        trainBlockCount: out.trainBlockCount ?? null,
        validationBlockCount: out.validationBlockCount ?? null,
        trainTokensSeen: out.trainTokensSeen ?? null,
        validationTokensSeen: out.validationTokensSeen ?? null,
        replayTokensSeen: out.replayTokensSeen ?? null,
        freshTokensSeen: out.freshTokensSeen ?? null,
        replayDocumentCount: out.replayDocumentCount ?? null,
        freshDocumentCount: out.freshDocumentCount ?? null,
        corpusSplit: out.corpusSplit ?? null,
        stepsCompleted: out.stepsCompleted ?? null,
        device: out.device ?? device,
        durationMs: out.durationMs ?? Date.now() - t0,
        cfg: { lr: learningRate, steps: runSteps, valBlocks: runValBlocks, evalEvery: runEvalEvery, seqLen, microBatch, gradAccum, warmup, computeDtype: resolvedDtype },
        note: "python causal-LM training",
      };
    },

    /**
     * Commit-on-promotion: promote a staged candidate into an immutable `vNNN`.
     * Idempotent — publishing an already-committed version is a no-op — so a
     * crash between staging and publication is recovered by simply retrying.
     */
    async publishCandidate(version) {
      if (!version) throw new Error("pythonTrainer.publishCandidate requires a version");
      const out = await run(["publish", "--version", version], { store, bin, timeoutMs, signal });
      if (!out.ok) {
        const err = new Error(`python publish of ${version} failed: ${out.error ?? "unknown"}`);
        err.code = out.code;
        throw err;
      }
      return out;
    },

    /**
     * Commit-on-promotion: discard a staged candidate. The weights are dropped
     * (they lost the promotion gate) while the small audit record is retained
     * under `recordDir`. Idempotent — discarding an already-gone candidate is
     * not an error.
     */
    async discardCandidate(version, { recordDir = null } = {}) {
      if (!version) throw new Error("pythonTrainer.discardCandidate requires a version");
      const args = ["discard", "--version", version];
      if (recordDir) args.push("--keep-record", recordDir);
      const out = await run(args, { store, bin, timeoutMs, signal });
      if (!out.ok) {
        const err = new Error(`python discard of ${version} failed: ${out.error ?? "unknown"}`);
        err.code = out.code;
        throw err;
      }
      return out;
    },
  };
}
