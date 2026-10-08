import path from "node:path";
import { REPO_ROOT, runPython } from "../brain/python-cli.js";
import { config } from "../config.js";
import { decidePromotionByLoss, evaluateVersionLoss } from "./loss-evaluator.js";

/**
 * Promote (or refuse) a Python candidate brain.
 *
 * The active pointer is the single mutable name in the compute plane. It moves
 * ONLY when the loss gate says "promoted" — a rejected or unevaluated candidate
 * never gets near it. After the pointer moves, the resident student worker is
 * reloaded so the very next chat turn is answered by the new brain.
 *
 * Order matters: evaluate → decide → move pointer → reload worker. A crash
 * between the pointer write and the reload leaves a committed, valid version
 * active; the worker simply keeps serving the old one until its next reload,
 * which is the safe direction to fail in.
 */

/** Point the store's active pointer at a committed version (the one mutation). */
export async function setActiveVersion(version, {
  store = config.pythonStore ?? undefined,
  bin = config.pythonBin ?? undefined,
  models = config.paths.models,
  timeoutMs = 60_000,
} = {}) {
  // `--models` is a path, and Python runs with its own cwd; resolve it here.
  const mirror = path.isAbsolute(models) ? models : path.resolve(REPO_ROOT, models);
  const out = await runPython(["active", "--set", version, "--models", mirror], { store, bin, timeoutMs });
  if (!out.ok || !out.activated) throw new Error(`failed to activate ${version}: ${out.error ?? "unknown"}`);
  return out.activated;
}

/**
 * @returns {Promise<{decision, reason, parent, candidate, activated, workerReloaded, evaluationSet}>}
 */
export async function promotePythonCandidate({
  parentVersion,
  candidateVersion,
  evalSetFile = config.promoteEvalSet,
  criteria = {},
  store = config.pythonStore ?? undefined,
  bin = config.pythonBin ?? undefined,
  device = config.studentDevice,
  models = config.paths.models,
  worker = null,
  record = null,
} = {}) {
  if (!parentVersion || !candidateVersion) {
    throw new Error("promotePythonCandidate requires parentVersion and candidateVersion");
  }
  if (parentVersion === candidateVersion) {
    return {
      decision: "not_evaluated",
      reason: "parent and candidate are the same version",
      parent: { version: parentVersion, ok: false, error: "same version" },
      candidate: { version: candidateVersion, ok: false, error: "same version" },
      activated: null,
      workerReloaded: false,
      evaluationSet: evalSetFile ?? null,
    };
  }

  const parent = await evaluateVersionLoss({ version: parentVersion, evalSetFile, store, bin, device });
  const candidate = await evaluateVersionLoss({ version: candidateVersion, evalSetFile, store, bin, device });
  const decision = decidePromotionByLoss(parent, candidate, criteria);

  const result = {
    decision: decision.decision,
    reason: decision.reason,
    parent,
    candidate,
    improvement: decision.improvement,
    activated: null,
    workerReloaded: false,
    evaluationSet: evalSetFile ?? null,
  };

  if (record) Object.assign(record, { parentLoss: parent.loss, candidateLoss: candidate.loss, delta: decision.improvement, decision });

  if (decision.decision !== "promoted") return result;

  result.activated = await setActiveVersion(candidateVersion, { store, bin, models });
  if (worker) {
    await worker.reload();
    result.workerReloaded = true;
  }
  return result;
}
