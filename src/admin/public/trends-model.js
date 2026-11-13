/**
 * Trends & Metrics view models.
 *
 * Pure, dependency-free helpers shared by the portal and the Node test suite.
 * Nothing here reads the DOM or fetches data: the server payload is the only
 * evidence, and every function preserves the distinction between a missing
 * measurement and a recorded zero.
 */

const OUTCOME_ORDER = ["promoted", "rejected", "inconclusive", "failed", "not_evaluated", "in_progress"];

export const OUTCOMES = Object.freeze(OUTCOME_ORDER);

export const OUTCOME_META = Object.freeze({
  promoted: { label: "Promoted", glyph: "▲", shape: "circle", tone: "good", className: "outcome-promoted" },
  rejected: { label: "Rejected", glyph: "✕", shape: "square", tone: "bad", className: "outcome-rejected" },
  inconclusive: { label: "Inconclusive", glyph: "?", shape: "diamond", tone: "warn", className: "outcome-inconclusive" },
  failed: { label: "Failed", glyph: "!", shape: "triangle", tone: "bad", className: "outcome-failed" },
  not_evaluated: { label: "Not evaluated", glyph: "–", shape: "hollow-circle", tone: "neutral", className: "outcome-not-evaluated" },
  in_progress: { label: "In progress", glyph: "◷", shape: "ring", tone: "info", className: "outcome-in-progress" },
});

export function outcomeMeta(outcome) {
  return OUTCOME_META[outcome] ?? {
    label: typeof outcome === "string" && outcome ? outcome : "Unknown",
    glyph: "·",
    shape: "circle",
    tone: "neutral",
    className: "outcome-unknown",
  };
}

export const TREND_META = Object.freeze({
  improving: { label: "Improving", className: "trend-improving" },
  plateauing: { label: "Plateauing", className: "trend-plateauing" },
  potentially_overfitting: { label: "Potentially overfitting", className: "trend-overfit" },
  worsening: { label: "Worsening", className: "trend-worsening" },
  insufficient_evidence: { label: "Insufficient evidence", className: "trend-insufficient" },
});

export function trendMeta(verdict) {
  return TREND_META[verdict] ?? { label: "Insufficient evidence", className: "trend-insufficient" };
}

export function finiteNumber(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function fmtLoss(value) {
  const n = finiteNumber(value);
  return n === null ? "—" : n.toFixed(n >= 100 ? 1 : 3);
}

export function fmtPct(rel, digits = 1) {
  const n = finiteNumber(rel);
  if (n === null) return "—";
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${(Math.abs(n) * 100).toFixed(digits)}%`;
}

export function fmtRate(rel, digits = 1) {
  const n = finiteNumber(rel);
  return n === null ? "—" : `${(n * 100).toFixed(digits)}%`;
}

export function fmtCount(value) {
  const n = finiteNumber(value);
  return n === null ? "—" : Math.round(n).toLocaleString();
}

export function formatDuration(ms) {
  const n = finiteNumber(ms);
  if (n === null || n < 0) return "—";
  const totalSeconds = Math.round(n / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24) return `${hours}h ${mins}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export function formatTimeTick(ms) {
  const n = finiteNumber(ms);
  if (n === null) return "—";
  return new Date(n).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatDateTime(iso) {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return String(iso);
  return new Date(ms).toLocaleString();
}

/** All 64-hex hashes cited anywhere in a stored reason, unique and in order. */
export function extractCitedHashes(text) {
  if (typeof text !== "string" || !text) return [];
  const matches = text.match(/\b[a-f0-9]{64}\b/gi) ?? [];
  return [...new Set(matches.map((h) => h.toLowerCase()))];
}

function niceStep(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / pow;
  let mult;
  if (norm <= 1) mult = 1;
  else if (norm <= 2) mult = 2;
  else if (norm <= 2.5) mult = 2.5;
  else if (norm <= 5) mult = 5;
  else mult = 10;
  return mult * pow;
}

function roundTick(value) {
  if (!Number.isFinite(value)) return value;
  const abs = Math.abs(value);
  const decimals = abs >= 100 ? 0 : abs >= 1 ? 2 : 4;
  return Number(value.toFixed(decimals));
}

export function chooseTicks(min, max, count = 5) {
  const lo = finiteNumber(min);
  const hi = finiteNumber(max);
  if (lo === null || hi === null) return [];
  if (lo === hi) return [lo];
  const span = hi - lo;
  const step = niceStep(span / Math.max(1, count - 1));
  const ticks = [];
  const start = Math.ceil(lo / step) * step;
  for (let value = start; value <= hi + step * 1e-9; value += step) {
    ticks.push(roundTick(value));
  }
  if (ticks.length === 0) ticks.push(roundTick(lo), roundTick(hi));
  return [...new Set(ticks)];
}

function padDomain(min, max, ratio = 0.04) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (max === min) {
    const pad = Math.max(Math.abs(max) * 0.02, 1e-4);
    return { min: min - pad, max: max + pad };
  }
  const pad = (max - min) * ratio;
  return { min: min - pad, max: max + pad };
}

function makeScale(domainMin, domainMax, rangeMin, rangeMax) {
  const span = domainMax - domainMin;
  return (value) => {
    if (!Number.isFinite(value)) return null;
    if (!(span > 0)) return (rangeMin + rangeMax) / 2;
    return rangeMin + ((value - domainMin) / span) * (rangeMax - rangeMin);
  };
}

export function runNumber(runId) {
  const match = String(runId ?? "").match(/(\d+)/);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export function sortEventsAscending(events) {
  return [...(events ?? [])].sort((a, b) => {
    const ta = a?.trainedAt ? Date.parse(a.trainedAt) : NaN;
    const tb = b?.trainedAt ? Date.parse(b.trainedAt) : NaN;
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
    if (Number.isFinite(ta) && !Number.isFinite(tb)) return -1;
    if (!Number.isFinite(ta) && Number.isFinite(tb)) return 1;
    return runNumber(a?.runId) - runNumber(b?.runId);
  });
}

function minPoint(points) {
  let best = null;
  for (const p of points ?? []) {
    if (!p || !Number.isFinite(p.loss)) continue;
    if (best === null || p.loss < best.loss) best = p;
  }
  return best;
}

function minFrozen(events) {
  let best = null;
  for (const e of events ?? []) {
    if (!e || !Number.isFinite(e.loss)) continue;
    if (best === null || e.loss < best.loss) best = e;
  }
  return best;
}

function flattenTraining(metrics) {
  return (metrics?.training ?? [])
    .flatMap((segment) =>
      (segment.points ?? [])
        .filter((p) => Number.isFinite(p.loss))
        .map((p) => ({
          step: p.step + (Number.isFinite(segment.stepOffset) ? segment.stepOffset : 0),
          loss: p.loss,
          version: segment.version ?? p.version ?? null,
        })),
    )
    .sort((a, b) => a.step - b.step);
}

function flattenValidation(metrics) {
  return (metrics?.chain?.points ?? [])
    .filter((p) => Number.isFinite(p.loss))
    .map((p) => ({ step: p.step, loss: p.loss, version: p.version ?? null }))
    .sort((a, b) => a.step - b.step);
}

export function summarizeEvents(events) {
  const list = Array.isArray(events) ? events.filter((e) => e && e.runId) : [];
  const counts = {};
  for (const outcome of OUTCOME_ORDER) counts[outcome] = 0;
  let evaluated = 0;
  let terminalEvaluated = 0;
  for (const e of list) {
    if (Object.prototype.hasOwnProperty.call(counts, e.outcome)) counts[e.outcome] += 1;
    if (Number.isFinite(e.loss)) evaluated += 1;
    if (e.outcome === "promoted" || e.outcome === "rejected" || e.outcome === "inconclusive") terminalEvaluated += 1;
  }
  return {
    total: list.length,
    counts,
    evaluated,
    evaluationCoverage: list.length ? evaluated / list.length : null,
    terminalEvaluated,
    promotionRate: terminalEvaluated ? counts.promoted / terminalEvaluated : null,
  };
}

/**
 * Verdict view model. Percentages and gaps are only computed inside one
 * measurement basis: held-out validation is compared with held-out validation,
 * training with training, and the frozen evaluation set stays separate.
 */
export function buildVerdict(metrics) {
  const trend = metrics?.trend ?? {};
  const evidence = trend.evidence ?? {};
  const thresholds = metrics?.thresholds ?? {};
  const segments = metrics?.segments ?? [];
  const effectiveSegment = segments.find((s) => s.version === metrics?.effectiveVersion) ?? segments[0] ?? null;
  const validation = flattenValidation(metrics);
  const training = flattenTraining(metrics);
  const firstValidation = validation[0] ?? null;
  const latestValidation = validation.length ? validation[validation.length - 1] : null;
  const bestValidation = metrics?.bestValidation ?? minPoint(validation);
  const trainingAtLatestValidation = latestValidation
    ? [...training].reverse().find((p) => p.step === latestValidation.step) ?? null
    : null;
  const gap = latestValidation && trainingAtLatestValidation
    ? {
        step: latestValidation.step,
        validation: latestValidation.loss,
        training: trainingAtLatestValidation.loss,
        value: latestValidation.loss - trainingAtLatestValidation.loss,
      }
    : null;
  const runHealth = metrics?.runHealth ?? summarizeEvents(metrics?.events ?? []);
  const bestFrozen = metrics?.bestFrozenEvaluation ?? minFrozen(metrics?.events ?? []);
  const lastVsBestRel = latestValidation && bestValidation
    ? (latestValidation.loss - bestValidation.loss) / Math.abs(bestValidation.loss || 1)
    : null;
  return {
    verdict: trend.verdict ?? "insufficient_evidence",
    label: trendMeta(trend.verdict).label,
    className: trendMeta(trend.verdict).className,
    reason: trend.reason ?? "No classification reason recorded.",
    sufficient: evidence.sufficient ?? (validation.length >= (thresholds.minPoints ?? 3)),
    thresholds,
    evidence,
    validation: {
      first: firstValidation?.loss ?? evidence.first ?? null,
      latest: latestValidation?.loss ?? evidence.last ?? null,
      best: bestValidation?.loss ?? evidence.best ?? null,
      bestStep: bestValidation?.step ?? evidence.bestStep ?? null,
      bestVersion: bestValidation?.version ?? evidence.bestVersion ?? null,
      firstStep: firstValidation?.step ?? evidence.firstStep ?? null,
      lastStep: latestValidation?.step ?? evidence.lastStep ?? null,
      points: validation.length,
      improvementRel: evidence.improvementRel ?? (firstValidation && latestValidation
        ? (latestValidation.loss - firstValidation.loss) / Math.abs(firstValidation.loss || 1)
        : null),
      lastVsBestRel,
    },
    training: {
      first: training[0]?.loss ?? null,
      latest: training.length ? training[training.length - 1].loss : null,
      best: minPoint(training)?.loss ?? null,
      points: training.length,
    },
    gap,
    steps: {
      from: metrics?.chain?.fromStep ?? validation[0]?.step ?? null,
      to: metrics?.chain?.toStep ?? (validation.length ? validation[validation.length - 1].step : null),
    },
    effectiveVersion: metrics?.effectiveVersion ?? null,
    activeVersion: metrics?.workspace?.activeVersion ?? null,
    activeModel: metrics?.activeModel ?? null,
    latestVersion: latestValidation?.version ?? effectiveSegment?.version ?? null,
    bestValidation,
    bestFrozen,
    runHealth,
    datasetHash: metrics?.datasetHash ?? null,
    sampling: effectiveSegment?.sampling ?? null,
    evalEvery: effectiveSegment?.evalEvery ?? null,
    segments: segments.length,
  };
}

/** Training/validation chart geometry. Validation observations are discrete. */
export function buildTrainingChart(metrics, { width = 1100, height = 430 } = {}) {
  const padding = { left: 64, right: 24, top: 24, bottom: 54 };
  const training = flattenTraining(metrics);
  const validation = flattenValidation(metrics);
  const segments = metrics?.segments ?? [];
  const effectiveSegment = segments.find((s) => s.version === metrics?.effectiveVersion) ?? segments[0] ?? null;
  const all = [...training, ...validation];
  if (all.length === 0) {
    return {
      empty: true,
      reason: "No finite training or held-out validation losses were recorded for this version.",
      width,
      height,
      training,
      validation,
      segments,
      sampling: effectiveSegment?.sampling ?? "none",
      stepBasis: metrics?.chain?.stepBasis ?? "training-step",
    };
  }

  const xValues = all.map((p) => p.step).filter(Number.isFinite);
  const yValues = all.map((p) => p.loss).filter(Number.isFinite);
  const xRaw = { min: Math.min(...xValues), max: Math.max(...xValues) };
  if (xRaw.min === xRaw.max) {
    xRaw.min -= 1;
    xRaw.max += 1;
  }
  const xDomain = padDomain(xRaw.min, xRaw.max, 0.01);
  const yDomain = padDomain(Math.min(...yValues), Math.max(...yValues), 0.05);
  const sx = makeScale(xDomain.min, xDomain.max, padding.left, width - padding.right);
  const sy = makeScale(yDomain.min, yDomain.max, height - padding.bottom, padding.top);
  const bestValidation = metrics?.bestValidation && Number.isFinite(metrics.bestValidation.step)
    ? metrics.bestValidation
    : minPoint(validation);

  return {
    empty: false,
    width,
    height,
    padding,
    plot: {
      left: padding.left,
      right: width - padding.right,
      top: padding.top,
      bottom: height - padding.bottom,
    },
    xDomain,
    yDomain,
    xTicks: chooseTicks(xDomain.min, xDomain.max, 6).map((value) => ({ value, x: sx(value) })),
    yTicks: chooseTicks(yDomain.min, yDomain.max, 5).map((value) => ({ value, y: sy(value) })),
    training: training.map((p) => ({ ...p, x: sx(p.step), y: sy(p.loss) })),
    validation: validation.map((p) => ({ ...p, x: sx(p.step), y: sy(p.loss) })),
    bestValidation: bestValidation
      ? { ...bestValidation, x: sx(bestValidation.step), y: sy(bestValidation.loss) }
      : null,
    trainingCount: training.length,
    validationCount: validation.length,
    trainingTotal: segments.reduce((n, s) => n + (Number.isFinite(s.trainingSamples) ? s.trainingSamples : 0), 0) || training.length,
    validationTotal: segments.reduce((n, s) => n + (Number.isFinite(s.validationSamples) ? s.validationSamples : 0), 0) || validation.length,
    sampling: effectiveSegment?.sampling ?? "none",
    stepBasis: metrics?.chain?.stepBasis ?? "training-step",
    segmentCount: segments.length,
  };
}

/** Frozen-evaluation/run-outcome scatter geometry. */
export function buildRunOutcomeChart(metrics, { xMode = "sequence", width = 1100, height = 420 } = {}) {
  const padding = { left: 64, right: 24, top: 24, bottom: 50 };
  const events = sortEventsAscending(metrics?.events ?? []);
  const stripHeight = events.some((e) => !Number.isFinite(e.loss)) ? 34 : 0;
  // Leave room for the x-axis tick labels between the plot and the strip; the
  // strip is a separate lane, not a part of the loss axis.
  const plotBottom = height - padding.bottom - stripHeight - (stripHeight ? 24 : 0);
  const stripTop = plotBottom + 34;
  const stripMarkerY = stripTop + stripHeight - 8;
  if (events.length === 0) {
    return { empty: true, reason: "No recorded runs for this store yet.", width, height, xMode, events: [] };
  }

  const positioned = events.map((event, index) => {
    const time = event?.trainedAt ? Date.parse(event.trainedAt) : NaN;
    const baseX = xMode === "time" ? (Number.isFinite(time) ? time : null) : index;
    return { event, sequence: index + 1, time, baseX };
  });

  // Exact-tie grouping for the time axis. Sequence mode is unique by
  // construction. The renderer spreads a tie symmetrically; no run gains a
  // false chronological position, and the tooltip says the runs share a time.
  const groups = new Map();
  for (const point of positioned) {
    if (point.baseX === null) continue;
    const key = String(point.baseX);
    const list = groups.get(key) ?? [];
    list.push(point);
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    list.forEach((point, index) => {
      point.tieIndex = index;
      point.tieCount = list.length;
    });
  }

  const measured = positioned.filter((p) => Number.isFinite(p.event.loss));
  const unmeasured = positioned.filter((p) => !Number.isFinite(p.event.loss));
  if (measured.length === 0) {
    return {
      empty: true,
      reason: "No run has a recorded frozen evaluation-set loss. Runs remain visible below as unevaluated events.",
      width,
      height,
      xMode,
      events,
      measured: [],
      unmeasured,
      measuredCount: 0,
      unmeasuredCount: unmeasured.length,
      stripHeight,
    };
  }

  const xValues = positioned.map((p) => p.baseX).filter((v) => Number.isFinite(v));
  let xMin = xMode === "sequence" ? 0 : Math.min(...xValues);
  let xMax = xMode === "sequence" ? Math.max(0, events.length - 1) : Math.max(...xValues);
  if (xMin === xMax) {
    xMin = xMode === "time" ? xMin - 3600_000 : xMin - 1;
    xMax = xMode === "time" ? xMax + 3600_000 : xMax + 1;
  }
  const xDomain = xMode === "time" ? { min: xMin, max: xMax } : padDomain(xMin, xMax, 0.01);
  const losses = measured.map((p) => p.event.loss);
  const yDomain = padDomain(Math.min(...losses), Math.max(...losses), 0.06);
  const sx = makeScale(xDomain.min, xDomain.max, padding.left, width - padding.right);
  const sy = makeScale(yDomain.min, yDomain.max, plotBottom, padding.top);

  const place = (point) => {
    const basePixel = point.baseX === null ? width - padding.right : sx(point.baseX);
    const spread = Math.min(18, (Math.max(0, point.tieCount - 1) * 7) / 2);
    const offset = point.tieCount > 1 ? (point.tieIndex - (point.tieCount - 1) / 2) * 7 : 0;
    return {
      ...point,
      x: Math.max(padding.left, Math.min(width - padding.right, basePixel + Math.max(-spread, Math.min(spread, offset)))),
    };
  };

  const bestEventPayload = metrics?.bestFrozenEvaluation ?? null;
  const bestPoint = bestEventPayload
    ? measured.find((point) => point.event.runId === bestEventPayload.runId) ?? measured.reduce((a, b) => (b.event.loss < a.event.loss ? b : a), measured[0])
    : measured.reduce((a, b) => (b.event.loss < a.event.loss ? b : a), measured[0]);
  const bestEvent = bestPoint?.event ?? null;
  const measuredPoints = measured.map((point) => {
    const placed = place(point);
    return {
      ...placed,
      y: sy(point.event.loss),
      outcome: point.event.outcome,
      meta: outcomeMeta(point.event.outcome),
    };
  });
  const unmeasuredPoints = unmeasured.map((point) => ({
    ...place(point),
    stripY: stripMarkerY,
    outcome: point.event.outcome,
    meta: outcomeMeta(point.event.outcome),
  }));

  return {
    empty: false,
    width,
    height,
    padding,
    plot: { left: padding.left, right: width - padding.right, top: padding.top, bottom: plotBottom },
    strip: stripHeight ? { top: stripTop, height: stripHeight, y: stripMarkerY } : null,
    stripHeight,
    xMode,
    xDomain,
    yDomain,
    xTicks: chooseTicks(xDomain.min, xDomain.max, 6).map((value) => ({
      value,
      x: sx(value),
      label: xMode === "time" ? formatTimeTick(value) : String(Math.round(value)),
    })),
    yTicks: chooseTicks(yDomain.min, yDomain.max, 5).map((value) => ({ value, y: sy(value) })),
    measured: measuredPoints,
    unmeasured: unmeasuredPoints,
    best: bestEvent && Number.isFinite(bestEvent.loss)
      ? { event: bestEvent, x: measuredPoints.find((p) => p.event.runId === bestEvent.runId)?.x ?? sx(0), y: sy(bestEvent.loss) }
      : null,
    total: events.length,
    measuredCount: measured.length,
    unmeasuredCount: unmeasured.length,
    identityRecorded: events.filter((e) => e.evaluationDatasetHash).length,
    citedHashCount: events.reduce((n, e) => n + (extractCitedHashes(e.decisionReason).length ? 1 : 0), 0),
    tieGroups: [...groups.values()].filter((list) => list.length > 1).length,
  };
}

export function filterRuns(events, { query = "", outcome = "", version = "" } = {}) {
  const needle = String(query ?? "").trim().toLowerCase();
  const wantedOutcome = String(outcome ?? "");
  const wantedVersion = String(version ?? "");
  return (events ?? []).filter((event) => {
    if (!event || !event.runId) return false;
    if (wantedOutcome && event.outcome !== wantedOutcome) return false;
    if (wantedVersion && event.version !== wantedVersion) return false;
    if (!needle) return true;
    const haystack = [event.runId, event.version, event.modelId, event.datasetId, event.parentVersion]
      .filter((v) => v !== null && v !== undefined)
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

function cmpNullable(a, b, direction) {
  const an = finiteNumber(a);
  const bn = finiteNumber(b);
  if (an === null && bn === null) return 0;
  if (an === null) return 1;
  if (bn === null) return -1;
  return (an - bn) * direction;
}

export function sortRuns(runs, sortKey = "newest") {
  const copy = [...(runs ?? [])];
  switch (sortKey) {
    case "oldest":
      return copy.sort((a, b) => {
        const byTime = cmpNullable(Date.parse(a.trainedAt ?? a.startedAt ?? ""), Date.parse(b.trainedAt ?? b.startedAt ?? ""), 1);
        return byTime || runNumber(a.runId) - runNumber(b.runId);
      });
    case "loss-asc":
      return copy.sort((a, b) => cmpNullable(a.loss, b.loss, 1));
    case "loss-desc":
      return copy.sort((a, b) => cmpNullable(a.loss, b.loss, -1));
    case "validation-asc":
      return copy.sort((a, b) => cmpNullable(a.validationLoss, b.validationLoss, 1));
    case "validation-desc":
      return copy.sort((a, b) => cmpNullable(a.validationLoss, b.validationLoss, -1));
    case "run-asc":
      return copy.sort((a, b) => runNumber(a.runId) - runNumber(b.runId));
    case "newest":
    default:
      return copy.sort((a, b) => {
        const byTime = cmpNullable(Date.parse(a.trainedAt ?? a.startedAt ?? ""), Date.parse(b.trainedAt ?? b.startedAt ?? ""), -1);
        return byTime || runNumber(b.runId) - runNumber(a.runId);
      });
  }
}

export function paginateRuns(runs, page = 1, pageSize = 50) {
  const size = Math.max(1, Math.floor(finiteNumber(pageSize) ?? 50));
  const total = (runs ?? []).length;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.max(1, Math.min(pages, Math.floor(finiteNumber(page) ?? 1)));
  const start = (current - 1) * size;
  return {
    items: (runs ?? []).slice(start, start + size),
    total,
    page: current,
    pages,
    pageSize: size,
    start: total ? start + 1 : 0,
    end: Math.min(total, start + size),
  };
}

export function indexHistory(history) {
  const byRun = new Map();
  const pyByVersion = new Map();
  for (const run of history?.registry?.runs ?? []) {
    if (run?.runId) byRun.set(run.runId, run);
  }
  for (const version of history?.pythonStore?.versions ?? []) {
    if (version?.version) pyByVersion.set(version.version, version);
  }
  return { history, byRun, pyByVersion };
}

export function runDetailsNeedHistory(events) {
  return (events ?? []).some((event) =>
    event.decisionReason === undefined
    || event.validationLoss === undefined
    || event.trainingSteps === undefined
    || event.checkpointPath === undefined,
  );
}

/**
 * Merge a persisted run event with the existing `/training-history` fallback.
 * Every value is either recorded or null; nothing is inferred from an outcome
 * label or replaced with zero.
 */
export function buildRunDetail(event, { byRun = new Map(), pyByVersion = new Map(), evaluationSet = null } = {}) {
  const run = byRun.get(event?.runId) ?? null;
  const pyVersion = event?.version ? pyByVersion.get(event.version) ?? null : null;
  const decisionReason = event?.decisionReason ?? run?.candidate?.note ?? run?.note ?? null;
  const statusNote = event?.statusNote ?? null;
  const validationLoss = event?.validationLoss ?? pyVersion?.trainState?.finalValidationLoss ?? null;
  const trainingSteps = event?.trainingSteps
    ?? pyVersion?.trainState?.stepsCompleted
    ?? run?.trainingBudget?.steps
    ?? null;
  const checkpointPath = event?.checkpointPath ?? run?.candidate?.checkpointPath ?? null;
  const startedAt = event?.startedAt ?? run?.startedAt ?? null;
  const endedAt = event?.endedAt ?? event?.completedAt ?? event?.lastEventAt ?? run?.completedAt ?? null;
  const startMs = startedAt ? Date.parse(startedAt) : NaN;
  const endMs = endedAt ? Date.parse(endedAt) : NaN;
  const durationMs = event?.durationMs
    ?? (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs ? endMs - startMs : null);
  return {
    ...event,
    meta: outcomeMeta(event?.outcome),
    decisionReason,
    statusNote,
    validationLoss,
    trainingSteps,
    checkpointPath,
    modelId: event?.modelId ?? run?.candidate?.modelId ?? null,
    datasetId: event?.datasetId ?? run?.datasetId ?? null,
    startedAt,
    endedAt,
    durationMs,
    evaluationDatasetHash: event?.evaluationDatasetHash ?? null,
    citedHashes: extractCitedHashes(decisionReason),
    evaluationSet,
  };
}
