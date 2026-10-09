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

/** Normalise recorded metrics, keeping null distinct from 0. */
function metricsFor(manifest, trainState) {
  const loss =
    trainState?.lastLoss ?? trainState?.loss ?? trainState?.metrics?.loss ?? manifest?.metrics?.loss ?? null;
  const steps =
    trainState?.stepsCompleted ?? trainState?.steps ?? manifest?.metrics?.stepsCompleted ?? null;
  const tokens = manifest?.metrics?.tokens ?? trainState?.tokensProcessed ?? null;
  const parameters = manifest?.sizes?.parametersUniqueByStorage ?? manifest?.parameterCount ?? null;
  return {
    loss: Number.isFinite(loss) ? loss : loss ?? null,
    steps: Number.isFinite(steps) ? steps : steps ?? null,
    tokens: Number.isFinite(tokens) ? tokens : tokens ?? null,
    parameters: Number.isFinite(parameters) ? parameters : parameters ?? null,
  };
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
      bytes,
      provenance: provenance ?? null,
    });
  }

  result.available = true;
  if (!active) result.reason = "active.json missing (no brain activated)";
  return result;
}
