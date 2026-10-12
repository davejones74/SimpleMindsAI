import { executeFullRun } from "../training/lifecycle.js";
import { defaultEvalSeed } from "../cli/report.js";
import { throwIfAborted } from "./cancel.js";

/**
 * One training run through the SAME lifecycle the CLI uses
 * (`executeFullRun`): recover → lock → snapshot → plan → baseline eval → train
 * → candidate eval → promote/reject → exactly-once consumption commit.
 *
 * The only additions over the CLI path are:
 *   - an explicit `parentVersion` (from the dashboard's training-parent
 *     selector) instead of always the active pointer;
 *   - a fail-closed eligibility gate: a one-shot run refuses to start below
 *     `minEligible` reviewed+unconsumed articles rather than training on nothing.
 *
 * Cancellation is cooperative between runs. A run in flight is interrupted only
 * by the supervisor's last-resort tree kill, and the Python staging_dir +
 * "consume only after train+eval" guarantees make that safe: no partial
 * checkpoint is committed and no article is consumed prematurely.
 */
export async function runTrainingOnce(ctx) {
  const { registry, store, trainer, signal } = ctx;
  throwIfAborted(signal);

  const minEligible = ctx.minEligible ?? 1;
  const stats = store.getStats();
  if (stats.trainable < minEligible) {
    const err = new Error(
      `insufficient eligible material: ${stats.trainable} reviewed+unconsumed article(s), need ${minEligible}. ` +
        "Run bounded/continuous learning (or review articles) first.",
    );
    err.code = "INSUFFICIENT_ELIGIBLE";
    err.eligible = stats.trainable;
    throw err;
  }

  const out = await executeFullRun({
    registry,
    deps: {
      store,
      trainer,
      complete: ctx.complete ?? null,
      markConsumed: (ids, runId) => store.markConsumed(ids, { runId }),
      evalSeed: ctx.evalSeed ?? defaultEvalSeed,
      // Injectable seams (defaults apply when omitted): the loss gate and the
      // serving-pointer move. Production never overrides them; tests do.
      evaluateLoss: ctx.evaluateLoss ?? undefined,
      setActive: ctx.setActive ?? undefined,
      worker: ctx.worker ?? null,
    },
    options: {
      parentVersion: ctx.parentVersion ?? null,
      snapshotLimit: ctx.snapshotLimit,
      evalDatasetId: ctx.evalDatasetId,
      paths: ctx.paths,
    },
    logger: ctx.logger ?? console,
  });
  return out;
}
