/**
 * Trends & Metrics — deterministic analytics over recorded, comparable losses.
 *
 * This module is PURE: no I/O, no store access, no randomness. The backend
 * route feeds it evidence straight from the recorded train-state files and the
 * frozen eval-set registry records; it returns verdicts that are reproducible,
 * threshold-based arithmetic over finite observations — never a model's guess.
 *
 * Honesty rules mirrored in the UI:
 *   - "insufficient evidence" when there are too few finite samples to judge;
 *   - validation and training losses are ONLY ever compared within the SAME
 *     dataset hash (no cross-corpus comparison);
 *   - a version trained without periodic validation sampling is represented by
 *     its two recorded endpoints, which is too little to classify a trend —
 *     the UI says so instead of fabricating a verdict.
 *
 * The same honesty rules govern the run-event markers: a run is an EVENT, not a
 * published model version, so a run with no recorded evaluation is marked as
 * having no metric rather than plotted at zero.
 */

export const VERDICT = Object.freeze({
  INSUFFICIENT_EVIDENCE: "insufficient_evidence",
  IMPROVING: "improving",
  PLATEAUING: "plateauing",
  POTENTIALLY_OVERFITTING: "potentially_overfitting",
  WORSENING: "worsening",
});

export const LABELS = Object.freeze({
  [VERDICT.INSUFFICIENT_EVIDENCE]: "Insufficient evidence",
  [VERDICT.IMPROVING]: "Improving",
  [VERDICT.PLATEAUING]: "Plateauing",
  [VERDICT.POTENTIALLY_OVERFITTING]: "Potentially overfitting",
  [VERDICT.WORSENING]: "Worsening",
});

function finitePoints(series, field = "loss") {
  if (!Array.isArray(series)) return [];
  const pts = [];
  for (const [i, p] of series.entries()) {
    const raw = p?.[field];
    if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) continue;
    const loss = Number(raw);
    if (!Number.isFinite(loss)) continue;
    pts.push({ step: p?.step ?? i, loss });
  }
  pts.sort((a, b) => a.step - b.step);
  return pts;
}

/** Relative change from->to, scaled by |from|. Returns null when degenerate. */
function relChange(from, to) {
  const scale = Math.abs(from);
  if (!Number.isFinite(from) || !Number.isFinite(to) || scale < 1e-9) return null;
  return (to - from) / scale;
}

function pct(x) {
  if (x === null || !Number.isFinite(x)) return "—";
  return `${(x * 100).toFixed(1)}%`;
}

/** Evenly decimate a sorted series, always keeping first and last points. */
export function downsample(points, maxPoints = 1000) {
  if (!Array.isArray(points)) return [];
  if (points.length <= maxPoints || maxPoints < 2) return points;
  const out = [];
  for (let i = 0; i < maxPoints; i += 1) {
    const idx = Math.round((i / (maxPoints - 1)) * (points.length - 1));
    if (out.length === 0 || out[out.length - 1].step !== points[idx].step) out.push(points[idx]);
  }
  const last = points[points.length - 1];
  if (out.length === 0 || out[out.length - 1].step !== last.step) out.push(last);
  return out;
}

/** True when the training series has not materially degraded from its best. */
function trainingNotDegraded(training, worsenRise) {
  const tr = finitePoints(training);
  if (tr.length === 0) return true;
  const best = Math.min(...tr.map((p) => p.loss));
  const last = tr[tr.length - 1].loss;
  return last <= best * (1 + worsenRise);
}

/**
 * Ordered, threshold-based trend classification over FINITE validation samples.
 *
 * Rule order is deterministic:
 *   1. insufficient evidence        -> too few finite samples
 *   2. worsening                   -> validation rose >= worsenRise first->last
 *   3. potentially overfitting     -> not worsened overall, but validation has
 *                                     degraded >= overfitValRise from its best
 *                                     while training has NOT concurrently
 *                                     degraded (classic memorisation signature)
 *   4. improving                   -> validation dropped >= improveDrop
 *   5. plateauing                  -> everything else reachable (catch-all)
 */
export function classifyTrend(validation, training = null, thresholds = {}) {
  const t = {
    minPoints: thresholds.minPoints ?? 3,
    improveDrop: thresholds.improveDrop ?? 0.01,
    worsenRise: thresholds.worsenRise ?? 0.05,
    overfitValRise: thresholds.overfitValRise ?? 0.02,
  };
  const v = finitePoints(validation);
  const evidence = () => ({
    points: v.length,
    first: v[0]?.loss ?? null,
    last: v[v.length - 1]?.loss ?? null,
    best: v.length ? Math.min(...v.map((p) => p.loss)) : null,
    firstStep: v[0]?.step ?? null,
    lastStep: v[v.length - 1]?.step ?? null,
  });
  if (v.length === 0) {
    return { verdict: VERDICT.INSUFFICIENT_EVIDENCE, thresholds: t, evidence: evidence(), reason: "No recorded validation losses." };
  }
  if (v.length < t.minPoints) {
    return {
      verdict: VERDICT.INSUFFICIENT_EVIDENCE,
      thresholds: t,
      evidence: evidence(),
      reason: `Only ${v.length} validation sample${v.length === 1 ? "" : "s"} recorded; ${t.minPoints} are needed to classify a trend.`,
    };
  }
  const first = v[0].loss;
  const last = v[v.length - 1].loss;
  const best = Math.min(...v.map((p) => p.loss));
  const rel = relChange(first, last);

  if (rel !== null && rel >= t.worsenRise) {
    return {
      verdict: VERDICT.WORSENING,
      thresholds: t,
      evidence: evidence(),
      reason: `Validation loss rose ${pct(rel)} from first to last (threshold ${pct(t.worsenRise)}).`,
    };
  }
  const offBestRel = best < 1e-9 ? null : (last - best) / best;
  if (offBestRel !== null && offBestRel >= t.overfitValRise && trainingNotDegraded(training, t.worsenRise)) {
    return {
      verdict: VERDICT.POTENTIALLY_OVERFITTING,
      thresholds: t,
      evidence: { ...evidence(), offBestRel },
      reason: `Validation worsened ${pct(offBestRel)} from its best while training did not degrade — the classic memorisation signature.`,
    };
  }
  if (rel !== null && rel <= -t.improveDrop) {
    return {
      verdict: VERDICT.IMPROVING,
      thresholds: t,
      evidence: evidence(),
      reason: `Validation loss fell ${pct(-rel)} from first to last (threshold ${pct(t.improveDrop)}).`,
    };
  }
  return {
    verdict: VERDICT.PLATEAUING,
    thresholds: t,
    evidence: evidence(),
    reason: "Validation stayed within the improving/worsening/overfit bands.",
  };
}

/** Loss series recorded for a version while it trained. */export function deriveSeries(trainState) {
  const ts = trainState && typeof trainState === "object" ? trainState : {};
  // Deduplicate by step: a periodic sample can land on the same step as the
  // opening point (e.g. evalEvery=1), and counting it twice would overstate the
  // evidence. The later sample wins, matching mergeChain.
  const byStep = new Map();
  for (const p of finitePoints(ts.validationHistory)) byStep.set(p.step, p);
  const validation = [...byStep.values()].sort((a, b) => a.step - b.step);
  let sampling = "none";
  // "periodic" means a CURVE exists (>2 distinct points). Two points are the
  // opening and closing endpoints even when a (too coarse) evalEvery produced
  // them; labelling those "periodic" hid the hint to tighten the cadence.
  if (validation.length > 2) sampling = (ts.config?.evalEvery ?? 0) > 0 ? "periodic" : "endpoints";
  else if (validation.length > 0) sampling = "endpoints";
  if (validation.length === 0) {
    const a = ts.initialValidationLoss;
    const b = ts.finalValidationLoss;
    if (Number.isFinite(a) && Number.isFinite(b)) {
      const finalStep = Number.isInteger(ts.stepsCompleted) && ts.stepsCompleted > 0 ? ts.stepsCompleted - 1 : 0;
      validation.push({ step: 0, loss: a });
      validation.push({ step: finalStep, loss: b });
      sampling = "endpoints";
    }
  }
  return {
    validationSeries: validation,
    trainingSeries: finitePoints(ts.history, "loss"),
    sampling,
    stepsCompleted: Number.isInteger(ts.stepsCompleted) ? ts.stepsCompleted : null,
    resumedFromStep: Number.isInteger(ts.resumedFromStep) ? ts.resumedFromStep : null,
    evalEvery: Number.isInteger(ts.config?.evalEvery) ? ts.config.evalEvery : 0,
    initialValidationLoss: Number.isFinite(ts.initialValidationLoss) ? ts.initialValidationLoss : null,
    finalValidationLoss: Number.isFinite(ts.finalValidationLoss) ? ts.finalValidationLoss : null,
  };
}

/**
 * Merge per-segment series of one lineage into a single step-keyed chain.
 * `segments` = array of `{ version, series, datasetHash }`. Points are unioned
 * by step; in the (guarded) case of duplicate steps the later segment wins.
 */
export function mergeChain(segments, maxPoints = 1000) {
  const byStep = new Map();
  let coverageFrom = null;
  let coverageTo = null;
  let collisions = 0;
  for (const seg of segments) {
    // A lineage chain is a SEQUENCE of trainings, each starting at step 0. The
    // caller supplies a cumulative `stepOffset` per segment so two sessions do
    // not silently overwrite each other on the step axis; the count of any
    // residual same-step overlaps is reported instead of hidden.
    const offset = Number.isFinite(seg.stepOffset) ? seg.stepOffset : 0;
    for (const p of seg.series) {
      const step = p.step + offset;
      if (byStep.has(step)) collisions += 1;
      byStep.set(step, { step, loss: p.loss, version: seg.version });
      coverageFrom = coverageFrom === null ? step : Math.min(coverageFrom, step);
      coverageTo = coverageTo === null ? step : Math.max(coverageTo, step);
    }
  }
  const points = [...byStep.values()].sort((a, b) => a.step - b.step);
  return { points: downsample(points, maxPoints), from: coverageFrom, to: coverageTo, collisions };
}

/**
 * Independent y-scales for the two measurement bases on the loss chart.
 *
 * The chart previously forced training loss, in-training validation loss and the
 * frozen-eval-set run markers onto ONE y-axis. Those are not the same
 * measurement: the frozen eval set is a small, separate corpus and scores in a
 * different band, while in-training validation shares the training corpus. With
 * one shared axis the smaller-band curve is compressed into a few pixels and
 * reads as a straight line even when it is moving.
 *
 * `left` spans validation + training (same corpus, comparable); `right` spans
 * only the frozen-eval-set markers. Ranges are padded when degenerate. Returns a
 * `hasLeft`/`hasRight` flag per axis so the renderer can hide an axis that has no
 * data instead of drawing a fake one.
 */
export function computeChartScales({ validation = [], training = [], markers = [] } = {}) {
  const valLosses = finitePoints(validation).map((p) => p.loss);
  const trainLosses = finitePoints(training).map((p) => p.loss);
  const leftLosses = [...valLosses, ...trainLosses];
  // Markers carry a finite loss by construction here; missing stays missing.
  const rightLosses = (markers ?? [])
    .map((m) => (m && m.loss != null ? Number(m.loss) : NaN))
    .filter((v) => Number.isFinite(v));
  const span = (values) => {
    if (!values.length) return { min: null, max: null, degenerate: false };
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (!(max > min)) {
      const pad = Math.max(Math.abs(max) * 0.02, 1e-4);
      min -= pad;
      max += pad;
      return { min, max, degenerate: true };
    }
    return { min, max, degenerate: false };
  };
  return {
    left: { ...span(leftLosses), label: "in-run + held-out loss (same corpus)" },
    right: { ...span(rightLosses), label: "frozen evaluation-set loss" },
    hasLeft: leftLosses.length > 0,
    hasRight: rightLosses.length > 0,
  };
}

/**
 * Pick the version worth defaulting the Trends view to.
 * Precedence: explicit request > active committed version > latest committed
 * version that actually trained > latest committed version.
 * Returns `{ requested, effective, default: boolean }`, or `null` when there is
 * nothing to show. Throws only when an explicit version is unknown.
 */
export function selectEffectiveVersion(versions, { requested = null, active = null, allowNotFound = false } = {}) {
  const committed = (versions ?? []).filter((v) => v && v.committed);
  if (requested) {
    const exact = committed.find((v) => v.version === requested);
    if (!exact) {
      if (allowNotFound) return null;
      throw new Error(`unknown version: ${requested}`);
    }
    return { requested, effective: requested, default: false };
  }
  if (active && committed.some((v) => v.version === active)) {
    return { requested: null, effective: active, default: true };
  }
  const trained = [...committed].reverse().filter((v) => v.trainState?.stepsCompleted > 0);
  const fallback = trained[0] ?? committed[committed.length - 1] ?? null;
  if (!fallback) return null;
  return { requested: null, effective: fallback.version, default: true };
}

/**
 * Per-dataset-hash best checkpoint among the given comparable entries.
 * `entries` = `{ version, loss, datasetHash, ... }`. Entries without a finite
 * loss or without a hash key are ignored (no cross-corpus comparison).
 */
export function bestCheckpoint(entries) {
  const bestByHash = new Map();
  for (const e of entries ?? []) {
    if (!e || !e.datasetHash || !Number.isFinite(e.loss)) continue;
    const cur = bestByHash.get(e.datasetHash);
    if (!cur || e.loss < cur.loss) bestByHash.set(e.datasetHash, { ...e });
  }
  return [...bestByHash.values()];
}

/**
 * The single best checkpoint comparable to one lineage, or null.
 *
 * `bestCheckpoint` above returns one winner *per dataset hash*, which is the
 * right answer for "what is the best thing I ever did on each corpus" — but on
 * a store where every version was trained on a different corpus, that list is
 * every version, and a card labelled "Best checkpoint" that renders all of them
 * is not a best, it is a disguised inventory.
 *
 * Losses are only comparable inside one dataset hash (see the honesty rules at
 * the top of this file), so the best checkpoint *for a lineage* is the best of
 * the entries sharing that lineage's hash. Entries on other corpora are not
 * worse versions of the same thing, they are a different measurement.
 */
export function bestCheckpointForHash(entries, datasetHash) {
  if (!datasetHash) return null;
  let best = null;
  for (const e of entries ?? []) {
    if (!e || e.datasetHash !== datasetHash || !Number.isFinite(e.loss)) continue;
    if (best === null || e.loss < best.loss) best = { ...e };
  }
  return best;
}

// --------------------------------------------------------------- run events
//
// A diamond on the Trends graph is a RUN, not a version. That distinction
// matters: most runs never become versions at all (they are rejected, they fail,
// or they are still running), and hiding them would make an unbroken line of
// successful promotions out of a lineage that actually had many failures. The
// markers below are therefore derived from persisted run/event data alone, and
// they carry whatever the ledger really recorded — a missing metric stays null,
// so the UI can say "not recorded" instead of inventing a number.

/** Run outcomes, as recorded in `run-events.ndjson` / the completion patch. */
export const RUN_OUTCOME = Object.freeze({
  PROMOTED: "promoted",
  REJECTED: "rejected",
  INCONCLUSIVE: "inconclusive",
  NOT_EVALUATED: "not_evaluated",
  FAILED: "failed",
  IN_PROGRESS: "in_progress",
});

export const RUN_OUTCOME_LABELS = Object.freeze({
  [RUN_OUTCOME.PROMOTED]: "Promoted",
  [RUN_OUTCOME.REJECTED]: "Rejected",
  [RUN_OUTCOME.INCONCLUSIVE]: "Inconclusive",
  [RUN_OUTCOME.NOT_EVALUATED]: "Not evaluated",
  [RUN_OUTCOME.FAILED]: "Failed",
  [RUN_OUTCOME.IN_PROGRESS]: "In progress",
});

/**
 * Finite number, or null.
 *
 * Every "missing" flavour is rejected explicitly and BEFORE coercion, because
 * `Number(null)`, `Number("")`, `Number(false)` and `Number([])` are all 0 — a
 * missing metric must never become a measured zero, which would read as a loss
 * of exactly nothing.
 */
function finiteOrNull(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * First entry of `[[value, label], ...]` that holds a finite number.
 * Returns `{ value, source }`, or null when none of them is finite.
 */
function firstFinite(candidates) {
  for (const [value, source] of candidates) {
    const n = finiteOrNull(value);
    if (n !== null) return { value: n, source };
  }
  return null;
}

/**
 * Outcome of a run: a terminal failure outranks a promotion decision (a run
 * that later failed is not a promotion), then the durable promotion decision,
 * then the durable run status, then "still running".
 */
export function resolveRunOutcome(run) {
  const status = typeof run?.status === "string" ? run.status : null;
  const decision = typeof run?.promotionStatus === "string" ? run.promotionStatus : null;
  if (status === "failed") return RUN_OUTCOME.FAILED;
  if (decision === RUN_OUTCOME.PROMOTED) return RUN_OUTCOME.PROMOTED;
  if (decision === RUN_OUTCOME.INCONCLUSIVE) return RUN_OUTCOME.INCONCLUSIVE;
  if (decision === RUN_OUTCOME.NOT_EVALUATED) return RUN_OUTCOME.NOT_EVALUATED;
  if (decision === RUN_OUTCOME.REJECTED) return RUN_OUTCOME.REJECTED;
  if (status === RUN_OUTCOME.PROMOTED) return RUN_OUTCOME.PROMOTED;
  if (status === RUN_OUTCOME.INCONCLUSIVE) return RUN_OUTCOME.INCONCLUSIVE;
  if (status === RUN_OUTCOME.REJECTED) return RUN_OUTCOME.REJECTED;
  if (status === RUN_OUTCOME.NOT_EVALUATED) return RUN_OUTCOME.NOT_EVALUATED;
  return RUN_OUTCOME.IN_PROGRESS;
}

/**
 * Turn persisted runs (+ their durable candidate models) into graph events.
 *
 * `models` supplies the durable model-event score, which survives a restart
 * even though the run completion patch does not, so `loss` keeps its meaning
 * after the process that produced it is gone.
 *
 * Every field is nullable on purpose: a run that produced no version, no
 * dataset hash or no evaluation produces a row with nulls, not a fabricated
 * column. `state` is left for the caller because it is the only sight of the
 * Python store (this module must stay I/O-free).
 */
export function deriveRunEvents(runs, models = []) {
  const byRun = new Map();
  for (const m of models ?? []) {
    if (m && m.trainingRunId) byRun.set(m.trainingRunId, m);
  }

  const events = [];
  for (const run of runs ?? []) {
    if (!run || !run.runId) continue;
    const candidate = byRun.get(run.runId) ?? null;
    const outcome = resolveRunOutcome(run);
    // Only candidate losses, never the baseline: a baseline is the PARENT's
    // score and plotting it here would claim an improvement that never happened.
    const loss = firstFinite([
      [run.trainedEvaluation?.loss, "run.trainedEvaluation"],
      [candidate?.evaluationScore, "modelEvent.evaluationScore"],
    ]);
    events.push({
      runId: run.runId,
      outcome,
      version: run.runLinkage?.pythonVersion ?? candidate?.meta?.pythonVersion ?? null,
      parentVersion: run.runLinkage?.parentVersion ?? candidate?.meta?.parentVersion ?? null,
      loss: loss?.value ?? null,
      lossSource: loss?.source ?? null,
      datasetHash: run.runLinkage?.datasetHash ?? candidate?.meta?.datasetHash ?? null,
      evaluationDatasetHash: run.runLinkage?.evaluationDatasetHash ?? null,
      tokensSeen: finiteOrNull(run.trainedEvaluation?.tokensSeen ?? candidate?.meta?.tokensSeen),
      evaluationDelta: finiteOrNull(run.evaluationDelta),
      activatedVersion: run.activatedVersion ?? null,
      promoted: outcome === RUN_OUTCOME.PROMOTED,
      startedAt: run.startedAt ?? null,
      completedAt: run.completedAt ?? null,
      trainedAt: run.completedAt ?? run.startedAt ?? null,
      note: run.trainerNotes?.note ?? null,
    });
  }

  // Newest recorded event first, deterministically: time, then id as tiebreak.
  events.sort((a, b) => {
    const ta = a.trainedAt ? Date.parse(a.trainedAt) : 0;
    const tb = b.trainedAt ? Date.parse(b.trainedAt) : 0;
    if (ta !== tb) return tb - ta;
    return String(b.runId).localeCompare(String(a.runId));
  });
  return events;
}