import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Read-only reader for the Python brain store (`SMA_STORE`, default
 * `~/.sma/store`). This is the authoritative source of truth for *committed
 * artifacts* (brain versions, their manifests, provenance and recorded
 * metrics). The Node registry remains the source of truth for *orchestration*.
 *
 * Hard rules honoured here:
 *   - NEVER write, NEVER spawn Python, NEVER mutate the store.
 *   - Tolerate a missing store, a missing `active.json`, and empty versions.
 *   - Distinguish "metric unavailable" (null) from "metric is zero".
 *   - Report what is there; do not silently reconcile discrepancies.
 */

const RECORD = {
  manifest: "init-manifest.json",
  provenance: "provenance.json",
  trainState: "train-state.json",
  parameterDiff: "parameter-diff.json",
  config: "config.json",
  committed: "COMMITTED",
};

export function resolveStorePath(explicit = null) {
  if (explicit) return explicit;
  if (process.env.SMA_STORE) return process.env.SMA_STORE;
  return path.join(os.homedir(), ".sma", "store");
}

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function listVersionDirs(root) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^v\d+$/.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function readRecord(root, version, name) {
  return readJsonSafe(path.join(root, version, name));
}

/**
 * `vNNN.tmp` directories: candidates built by `train --stage-only` that have
 * not been promoted or discarded yet. They are NOT published versions and must
 * never be offered as one, so they are reported separately rather than being
 * folded into `versions`.
 */
function listStagedCandidates(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((d) => d.isDirectory() && /^v\d+\.tmp$/.test(d.name))
    .map((d) => ({
      version: d.name.slice(0, -".tmp".length),
      stagingDir: d.name,
      path: path.join(root, d.name),
      hasManifest: existsSync(path.join(root, d.name, RECORD.manifest)),
    }))
    .sort((a, b) => a.version.localeCompare(b.version));
}

/**
 * Versions whose weights were deliberately removed by retention, read from their
 * prune tombstones. The git-tracking mirror keeps their text, so these remain
 * part of history — they are listed so a shrunken store never looks like records
 * were lost.
 */
function listPrunedVersions(root) {
  const dir = path.join(root, "_pruned");
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((d) => d.isFile() && /^v\d+\.json$/.test(d.name))
    .map((d) => {
      const record = readJsonSafe(path.join(dir, d.name)) ?? {};
      return {
        version: d.name.slice(0, -".json".length),
        prunedAt: record.prunedAt ?? null,
        reason: record.reason ?? null,
        weightBytes: Number.isFinite(record.weightBytes) ? record.weightBytes : null,
        recordFiles: Array.isArray(record.recordFiles) ? Object.keys(record.recordFiles).sort() : [],
        mirrorRetained: record.mirror === "retained in git",
      };
    })
    .sort((a, b) => a.version.localeCompare(b.version));
}

/** Normalise recorded metrics, keeping null distinct from 0. */
function metricsFor(manifest, trainState) {
  // A trained version's most representative number is its held-out validation
  // loss; training loss is the fallback, then the legacy metric fields. The
  // precedence reads the fields train.py actually writes (finalValidationLoss /
  // finalTrainLoss / tokensSeen / stepsCompleted); the old fallbacks exist so
  // manifest-only records keep working. A recorded zero stays zero.
  const loss =
    trainState?.finalValidationLoss ?? trainState?.finalTrainLoss ??
    trainState?.loss ?? trainState?.metrics?.loss ?? manifest?.metrics?.loss ?? null;
  const steps =
    trainState?.stepsCompleted ?? trainState?.steps ?? manifest?.metrics?.stepsCompleted ?? null;
  const tokens =
    trainState?.tokensSeen ?? trainState?.tokensProcessed ?? manifest?.metrics?.tokens ?? null;
  const parameters = manifest?.sizes?.parametersUniqueByStorage ?? manifest?.parameterCount ?? null;
  return {
    loss: Number.isFinite(loss) ? loss : loss ?? null,
    steps: Number.isFinite(steps) ? steps : steps ?? null,
    tokens: Number.isFinite(tokens) ? tokens : tokens ?? null,
    parameters: Number.isFinite(parameters) ? parameters : parameters ?? null,
  };
}

/** Lean, always-cheap train-state summary attached to every version. */
function trainStateSummary(trainState) {
  if (!trainState || typeof trainState !== "object") return null;
  return {
    parentVersion: trainState.parentVersion ?? null,
    resumedFromStep: Number.isInteger(trainState.resumedFromStep) ? trainState.resumedFromStep : null,
    stepsCompleted: Number.isInteger(trainState.stepsCompleted) ? trainState.stepsCompleted : null,
    tokensSeen: Number.isFinite(trainState.tokensSeen) ? trainState.tokensSeen : null,
    datasetHash: trainState?.packing?.datasetHash ?? null,
    initialTrainLoss: Number.isFinite(trainState.initialTrainLoss) ? trainState.initialTrainLoss : null,
    finalTrainLoss: Number.isFinite(trainState.finalTrainLoss) ? trainState.finalTrainLoss : null,
    initialValidationLoss: Number.isFinite(trainState.initialValidationLoss) ? trainState.initialValidationLoss : null,
    finalValidationLoss: Number.isFinite(trainState.finalValidationLoss) ? trainState.finalValidationLoss : null,
    stoppedEarly: trainState.stoppedEarly ?? null,
    stopReason: trainState.stopReason ?? null,
    evalEvery: Number.isInteger(trainState?.config?.evalEvery) ? trainState.config.evalEvery : null,
  };
}

/**
 * Full train-state record for ONE version, including the per-step `history` and
 * `validationHistory` series. Kept separate from `readPythonStore` so the
 * overview/portal responses stay small: the series is only served to the
 * Trends & Metrics endpoint for the versions it plots.
 */
export function readPythonTrainState(version, explicit = null) {
  const root = resolveStorePath(explicit);
  return readRecord(root, version, RECORD.trainState);
}

/**
 * Every version number ever ALLOCATED, read from the store's durable
 * `_allocations.ndjson`. This is the authoritative record of attempts: a
 * rejected candidate burns its number even though it never becomes a `vNNN`
 * directory. Comparing a Node model's version against the version DIRECTORIES
 * alone therefore reports every discarded attempt as a "discrepancy".
 */
function listAllocatedVersions(root) {
  const file = path.join(root, "_allocations.ndjson");
  try {
    return readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l)?.version ?? null; } catch { return null; } })
      .filter((v) => typeof v === "string" && /^v\d+$/.test(v));
  } catch {
    return [];
  }
}

export function readPythonStore(explicit = null) {
  const root = resolveStorePath(explicit);
  const exists = existsSync(root);
  const result = {
    available: false,
    root,
    exists,
    activeVersion: null,
    active: null,
    versions: [],
    allocatedVersions: [],
    reason: null,
  };
  if (!exists) {
    result.reason = `store not found at ${root}`;
    return result;
  }

  const active = readJsonSafe(path.join(root, "active.json"));
  result.active = active;
  result.activeVersion = active?.version ?? null;

  for (const version of listVersionDirs(root)) {
    const dir = path.join(root, version);
    let committed = false;
    let committedAt = null;
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, RECORD.committed), "utf8"));
      committed = true;
      committedAt = parsed.committedAt ?? null;
    } catch {
      committed = existsSync(path.join(dir, RECORD.committed));
    }

    const manifest = readRecord(root, version, RECORD.manifest);
    const provenance = readRecord(root, version, RECORD.provenance);
    const trainState = readRecord(root, version, RECORD.trainState);
    const config = readRecord(root, version, RECORD.config);

    let bytes = null;
    try {
      bytes = readdirSync(dir)
        .map((f) => path.join(dir, f))
        .filter((f) => statSync(f).isFile())
        .reduce((a, f) => a + statSync(f).size, 0);
    } catch {
      bytes = null;
    }

    result.versions.push({
      version,
      path: dir,
      committed,
      committedAt,
      createdAt: manifest?.createdAt ?? null,
      artifactName: manifest ? `${provenance?.artifactName ?? manifest?.artifactName ?? ""}`.trim() || null : null,
      arch: config?.architecture ?? manifest?.architecture ?? null,
      metrics: metricsFor(manifest, trainState),
      trainState: trainStateSummary(trainState),
      bytes,
      provenance: provenance ?? null,
    });
  }

  result.available = true;
  if (!active) result.reason = "active.json missing (no brain activated)";

  // The other three states of a brain, kept deliberately OUT of `versions`:
  // a staged candidate is not published, a training run is not an artifact, and
  // a pruned version's WEIGHTS are gone even though its record survives. Mixing
  // them into one list is what makes a brain count look wrong.
  result.staged = listStagedCandidates(root);
  result.pruned = listPrunedVersions(root);
  result.allocatedVersions = [...new Set(listAllocatedVersions(root))].sort();
  result.counts = {
    published: result.versions.filter((v) => v.committed).length,
    uncommitted: result.versions.filter((v) => !v.committed).length,
    staged: result.staged.length,
    pruned: result.pruned.length,
    allocated: result.allocatedVersions.length,
  };
  return result;
}
