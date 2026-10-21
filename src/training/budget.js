/**
 * Data-aware training budget.
 *
 * The fixed step count was the dominant cause of both over-repetition on tiny
 * corpora and under-training on larger ones. Steps are now derived from the
 * number of TRAINING blocks (after validation has been held out) and a target
 * epoch count, then clamped by a mandatory hard cap. Everything returned here is
 * recorded on the run so the decision is reconstructible after the fact.
 */
export function computeTrainingBudget({
  trainBlockCount,
  targetEpochs,
  maxSteps,
  microBatch,
  gradAccum,
} = {}) {
  const blocks = Number(trainBlockCount);
  const epochs = Number(targetEpochs);
  const cap = Number(maxSteps);
  const micro = Number(microBatch);
  const accum = Number(gradAccum);
  const effectiveBatchSize = micro * accum;

  if (!Number.isInteger(blocks) || blocks <= 0) {
    throw new Error(`training budget needs a positive block count, got ${trainBlockCount}`);
  }
  if (!Number.isFinite(epochs) || epochs <= 0) {
    throw new Error(`TRAIN_TARGET_EPOCHS must be positive, got ${targetEpochs}`);
  }
  if (!Number.isFinite(cap) || cap < 1) {
    throw new Error(`TRAIN_MAX_STEPS must be at least 1, got ${maxSteps}`);
  }
  if (!Number.isInteger(micro) || micro <= 0 || !Number.isInteger(accum) || accum <= 0) {
    throw new Error(`micro-batch and gradient accumulation must be positive integers, got ${microBatch}/${gradAccum}`);
  }

  const requestedSteps = Math.max(1, Math.ceil((epochs * blocks) / effectiveBatchSize));
  const steps = Math.min(requestedSteps, Math.floor(cap));
  const effectiveEpochs = (steps * effectiveBatchSize) / blocks;

  return {
    trainBlockCount: blocks,
    targetEpochs: epochs,
    maxSteps: Math.floor(cap),
    effectiveBatchSize,
    requestedSteps,
    steps,
    effectiveEpochs,
    capped: requestedSteps > steps,
    capReason: requestedSteps > steps
      ? `requested ${requestedSteps} step(s) for ${epochs} epoch(s) exceeded TRAIN_MAX_STEPS=${Math.floor(cap)}`
      : null,
  };
}

/**
 * Evaluation cadence for a run.
 *
 * A fixed `TRAIN_EVAL_EVERY` is a trap once the step budget becomes data-derived:
 * 60 steps at every-10 gave 7 validation observations, but 8 steps at every-10
 * gives only the opening and closing points — too few to classify a trend. The
 * configured value is treated as a CAP, and the effective cadence is tightened
 * until a short run records roughly one sample per quarter of its steps.
 *
 * `0` (or an invalid value) means "periodic validation disabled" and is
 * preserved exactly.
 */
export function computeEvaluationCadence({ steps, configuredEvalEvery = 0 } = {}) {
  const configured = Number(configuredEvalEvery);
  if (!Number.isFinite(configured) || configured <= 0) return 0;
  const s = Number(steps);
  if (!Number.isInteger(s) || s <= 0) return configured;
  const target = Math.max(1, Math.floor(s / 4));
  return Math.min(Math.max(1, configured), target);
}

/**
 * Minimum usable-data gate. `tokens` is the unique token count of the training
 * stream (validation excluded), as reported by the trainer preflight. A missing
 * count is not treated as zero: legacy/custom trainers without preflight keep
 * their historical behaviour instead of being blocked by a metric they do not
 * provide.
 */
export function checkMinimumTrainingData({ trainTokensSeen, minUniqueTokens } = {}) {
  const floor = Number(minUniqueTokens);
  const tokens = trainTokensSeen == null ? null : Number(trainTokensSeen);
  if (!Number.isFinite(floor) || floor <= 0) {
    return { ok: true, enforced: false, floor: 0, tokens, reason: null };
  }
  if (!Number.isFinite(tokens)) {
    return { ok: true, enforced: false, floor, tokens: null, reason: null };
  }
  if (tokens < floor) {
    return {
      ok: false,
      enforced: true,
      floor,
      tokens,
      reason: `training corpus has ${tokens} unique token(s), below the minimum of ${floor}`,
    };
  }
  return { ok: true, enforced: true, floor, tokens, reason: null };
}
