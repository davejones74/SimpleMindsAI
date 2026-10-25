/**
 * Browser-side live-training telemetry.
 *
 * The server sends an authoritative snapshot on (re)connect and then coalesced
 * deltas on the existing SSE feed. This module keeps the rolling history
 * bounded and rejects stale sessions / duplicate or out-of-order sequences.
 * Nothing here is specific to 62M or 3B: it only ever sees step-level
 * aggregates, never parameters, tensors or activations.
 */

export const TELEMETRY_SCHEMA = "sma/training-telemetry@1";
export const TELEMETRY_HISTORY_LIMIT = 600;
const MAX_LAYER_ACTIVITY_LAYERS = 128;

const TERMINAL = new Set(["completed", "failed", "stopped", "interrupted"]);
const STALE_EXPECTED = new Set(["running"]);

const finiteOrNull = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
const intOrNull = (value) => (Number.isInteger(Number(value)) ? Number(value) : null);
const isoOrNull = (value) => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

export function cleanLayerActivity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.measure !== "gradientRms") return null;
  const layers = [];
  for (const raw of Array.isArray(value.layers) ? value.layers : []) {
    if (!raw || typeof raw !== "object") continue;
    const index = intOrNull(raw.index);
    if (index === null || index < 0 || index > 9999) continue;
    layers.push({
      index,
      componentId: typeof raw.componentId === "string" && raw.componentId
        ? raw.componentId
        : `model.layers.${index}`,
      rms: raw.rms === null || raw.rms === undefined ? null : finiteOrNull(raw.rms),
      elements: intOrNull(raw.elements) ?? 0,
    });
    if (layers.length >= MAX_LAYER_ACTIVITY_LAYERS) break;
  }
  if (!layers.length) return null;
  layers.sort((a, b) => a.index - b.index);
  return {
    measure: "gradientRms",
    phase: typeof value.phase === "string" ? value.phase : "pre-clip",
    aggregation: typeof value.aggregation === "string" ? value.aggregation : "per-transformer-block",
    step: intOrNull(value.step),
    sampledAt: isoOrNull(value.sampledAt),
    layers,
  };
}

export function createTelemetryState() {
  return {
    schema: TELEMETRY_SCHEMA,
    available: false,
    source: null,
    status: "unavailable",
    reason: "waiting for live training telemetry",
    jobId: null,
    mode: null,
    sessionId: null,
    version: null,
    parentVersion: null,
    step: null,
    totalSteps: null,
    trainLoss: null,
    evaluationLoss: null,
    learningRate: null,
    stepsPerSecond: null,
    stepSeconds: null,
    tokensSeen: null,
    elapsedMs: null,
    phase: null,
    note: null,
    error: null,
    seq: 0,
    startedAt: null,
    completedAt: null,
    updatedAt: null,
    receivedAt: null,
    receivedLocallyAt: null,
    lastEvent: null,
    lastCheckpoint: null,
    layerActivity: null,
    staleAfterMs: 5000,
    historyLimit: TELEMETRY_HISTORY_LIMIT,
    changeSeq: 0,
    history: { training: [], evaluation: [] },
    checkpoints: [],
    connection: "connecting",
  };
}

function cleanPoint(point) {
  const step = intOrNull(point?.step);
  const loss = finiteOrNull(point?.loss);
  if (step === null || loss === null) return null;
  return { step, loss, at: isoOrNull(point.at) };
}

function cleanPoints(points, limit) {
  const out = [];
  for (const raw of Array.isArray(points) ? points : []) {
    const point = cleanPoint(raw);
    if (!point) continue;
    const last = out[out.length - 1];
    if (last && point.step === last.step) out[out.length - 1] = point;
    else if (!last || point.step > last.step) out.push(point);
  }
  if (out.length > limit) out.splice(0, out.length - limit);
  return out;
}

function cleanCheckpoint(checkpoint) {
  if (!checkpoint || typeof checkpoint !== "object") return null;
  return {
    at: isoOrNull(checkpoint.at),
    step: intOrNull(checkpoint.step),
    version: checkpoint.version ? String(checkpoint.version) : null,
    staged: checkpoint.staged === true,
  };
}

function copyHistory(state) {
  return {
    training: state.history.training.map((point) => ({ ...point })),
    evaluation: state.history.evaluation.map((point) => ({ ...point })),
  };
}

/** Authoritative reconnect state. Invalid/unavailable input never fabricates a run. */
export function telemetryFromSnapshot(snapshot, { now = Date.now() } = {}) {
  const state = createTelemetryState();
  if (!snapshot || snapshot.schema !== TELEMETRY_SCHEMA || snapshot.available !== true) {
    state.reason = snapshot?.reason ?? "no live training telemetry";
    state.changeSeq = intOrNull(snapshot?.changeSeq) ?? 0;
    return state;
  }
  const limit = Math.max(10, intOrNull(snapshot.historyLimit) ?? TELEMETRY_HISTORY_LIMIT);
  Object.assign(state, {
    available: true,
    source: snapshot.source ?? "subprocess",
    status: snapshot.status ?? "running",
    reason: snapshot.reason ?? null,
    jobId: snapshot.jobId ?? null,
    mode: snapshot.mode ?? null,
    sessionId: snapshot.sessionId ?? null,
    version: snapshot.version ?? null,
    parentVersion: snapshot.parentVersion ?? null,
    step: intOrNull(snapshot.step),
    totalSteps: intOrNull(snapshot.totalSteps),
    trainLoss: finiteOrNull(snapshot.trainLoss),
    evaluationLoss: finiteOrNull(snapshot.evaluationLoss),
    learningRate: finiteOrNull(snapshot.learningRate),
    stepsPerSecond: finiteOrNull(snapshot.stepsPerSecond),
    stepSeconds: finiteOrNull(snapshot.stepSeconds),
    tokensSeen: intOrNull(snapshot.tokensSeen),
    elapsedMs: finiteOrNull(snapshot.elapsedMs),
    phase: snapshot.phase ?? null,
    note: snapshot.note ?? null,
    error: snapshot.error ?? null,
    seq: intOrNull(snapshot.seq) ?? 0,
    startedAt: isoOrNull(snapshot.startedAt),
    completedAt: isoOrNull(snapshot.completedAt),
    updatedAt: isoOrNull(snapshot.updatedAt),
    receivedAt: isoOrNull(snapshot.receivedAt),
    receivedLocallyAt: snapshot.receivedAt ? now : null,
    lastEvent: snapshot.lastEvent ?? null,
    lastCheckpoint: cleanCheckpoint(snapshot.lastCheckpoint),
    layerActivity: cleanLayerActivity(snapshot.layerActivity),
    staleAfterMs: Math.max(1000, intOrNull(snapshot.staleAfterMs) ?? 5000),
    historyLimit: limit,
    changeSeq: intOrNull(snapshot.changeSeq) ?? 0,
    history: {
      training: cleanPoints(snapshot.history?.training, limit),
      evaluation: cleanPoints(snapshot.history?.evaluation, limit),
    },
    checkpoints: (Array.isArray(snapshot.checkpoints) ? snapshot.checkpoints : [])
      .map(cleanCheckpoint)
      .filter(Boolean)
      .slice(-40),
  });
  return state;
}

function trimHistory(state) {
  for (const key of ["training", "evaluation"]) {
    const list = state.history[key];
    if (list.length > state.historyLimit) list.splice(0, list.length - state.historyLimit);
  }
  if (state.checkpoints.length > 40) state.checkpoints.splice(0, state.checkpoints.length - 40);
}

function appendPoint(list, point) {
  const last = list[list.length - 1];
  if (last && last.step === point.step) {
    list[list.length - 1] = point;
    return "updated";
  }
  if (last && point.step < last.step) return "ignored";
  list.push(point);
  return "appended";
}

/**
 * Apply one SSE delta. Returns metadata the UI uses to trigger a *real* event
 * acknowledgement, never a fabricated pulse.
 */
export function applyTelemetryEvent(state, event, { now = Date.now() } = {}) {
  const ignored = { accepted: false, sessionChanged: false, kind: null, point: null, checkpoint: null };
  if (!event || event.schema !== TELEMETRY_SCHEMA) return ignored;
  const sessionId = typeof event.sessionId === "string" && event.sessionId ? event.sessionId : null;
  const seq = intOrNull(event.seq);
  if (!sessionId || seq === null || seq <= 0) return ignored;

  let sessionChanged = false;
  if (state.sessionId && state.sessionId !== sessionId) {
    if (event.type !== "started") return ignored;
    state.sessionId = sessionId;
    state.seq = 0;
    state.history = { training: [], evaluation: [] };
    state.checkpoints = [];
    state.lastCheckpoint = null;
    state.layerActivity = null;
    sessionChanged = true;
  }
  if (!state.sessionId || state.sessionId === sessionId) {
    if (seq <= state.seq) return ignored;
  }
  if (!state.sessionId) {
    state.sessionId = sessionId;
    sessionChanged = true;
  }

  state.available = true;
  state.source = state.source ?? "subprocess";
  state.reason = null;
  state.seq = seq;
  state.lastEvent = event.type ?? null;
  state.receivedLocallyAt = now;
  state.updatedAt = Number.isFinite(Number(event.at)) ? new Date(Number(event.at)).toISOString() : new Date(now).toISOString();
  if (event.jobId) state.jobId = event.jobId;
  if (event.version) state.version = String(event.version);
  if (event.parentVersion) state.parentVersion = String(event.parentVersion);
  if (event.totalSteps !== undefined) state.totalSteps = intOrNull(event.totalSteps);
  if (event.learningRate !== undefined) state.learningRate = finiteOrNull(event.learningRate);
  if (event.tokensSeen !== undefined) state.tokensSeen = intOrNull(event.tokensSeen);
  if (event.elapsedMs !== undefined) state.elapsedMs = finiteOrNull(event.elapsedMs);
  if (event.stepsPerSecond !== undefined) state.stepsPerSecond = finiteOrNull(event.stepsPerSecond);

  let point = null;
  let checkpoint = null;
  if (event.type === "started") {
    state.status = "running";
    state.startedAt = state.updatedAt;
    state.step = intOrNull(event.step);
    state.trainLoss = finiteOrNull(event.initialTrainLoss);
    state.evaluationLoss = finiteOrNull(event.initialValidationLoss);
  } else if (event.type === "snapshot") {
    state.status = "running";
    state.step = intOrNull(event.step) ?? state.step;
    state.trainLoss = finiteOrNull(event.loss) ?? state.trainLoss;
    state.stepSeconds = finiteOrNull(event.stepSeconds) ?? state.stepSeconds;
    if (event.layerActivity !== undefined) {
      const layerActivity = cleanLayerActivity(event.layerActivity);
      if (layerActivity) {
        state.layerActivity = {
          ...layerActivity,
          sampledAt: layerActivity.sampledAt ?? state.updatedAt,
        };
      }
    }
    point = cleanPoint({ step: event.step, loss: event.loss, at: state.updatedAt });
    if (point) appendPoint(state.history.training, point);
  } else if (event.type === "evaluation") {
    state.evaluationLoss = finiteOrNull(event.loss);
    point = cleanPoint({ step: event.step ?? state.step, loss: event.loss, at: state.updatedAt });
    if (point) appendPoint(state.history.evaluation, point);
  } else if (event.type === "checkpoint") {
    checkpoint = cleanCheckpoint({
      at: state.updatedAt,
      step: event.step,
      version: event.version,
      staged: event.staged,
    });
    if (checkpoint) {
      state.lastCheckpoint = checkpoint;
      state.checkpoints.push(checkpoint);
    }
  } else if (event.type === "completed") {
    state.status = "completed";
    state.completedAt = state.updatedAt;
    state.trainLoss = finiteOrNull(event.finalTrainLoss) ?? state.trainLoss;
    state.evaluationLoss = finiteOrNull(event.finalValidationLoss) ?? state.evaluationLoss;
    state.step = intOrNull(event.step) ?? state.step;
  } else if (event.type === "failed") {
    state.status = "failed";
    state.completedAt = state.updatedAt;
    state.error = event.error ? String(event.error) : "training failed";
  }
  trimHistory(state);
  return { accepted: true, sessionChanged, kind: event.type, point, checkpoint };
}

/** Apply a non-training job status (started/paused/resumed/completed/stopped). */
export function applyJobStatus(state, data, { now = Date.now() } = {}) {
  if (!data || !data.jobId) return false;
  if (state.jobId && state.jobId !== data.jobId) return false;
  if (!state.jobId) state.jobId = data.jobId;
  if (!data.status) return false;
  state.status = String(data.status);
  state.phase = data.phase ?? state.phase;
  state.receivedLocallyAt = now;
  if (TERMINAL.has(state.status)) state.completedAt = new Date(now).toISOString();
  return true;
}

export function telemetryDisplayStatus(state, { now = Date.now(), connection = state.connection } = {}) {
  if (!state.available) return "unavailable";
  if (TERMINAL.has(state.status)) return state.status;
  if (connection === "disconnected") return "disconnected";
  if (connection === "connecting") return "connecting";
  if (state.receivedLocallyAt == null) return "waiting";
  if (STALE_EXPECTED.has(state.status) && now - state.receivedLocallyAt > state.staleAfterMs) return "stale";
  return state.status === "running" ? "live" : state.status;
}

export function downsamplePoints(points, maxPoints = 240) {
  if (!Array.isArray(points) || points.length <= maxPoints) return points ?? [];
  const stride = Math.ceil(points.length / maxPoints);
  const out = [];
  for (let index = 0; index < points.length; index += stride) out.push(points[index]);
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/**
 * Bounded chart geometry. Returns null when no finite loss was measured; the
 * UI must render an explicit "not measured" state rather than a fake curve.
 */
export function chartModel(state, { maxPoints = 220 } = {}) {
  const training = downsamplePoints(state.history.training, maxPoints)
    .filter((point) => Number.isFinite(point.loss));
  const evaluation = downsamplePoints(state.history.evaluation, maxPoints)
    .filter((point) => Number.isFinite(point.loss));
  const all = [...training, ...evaluation];
  if (!all.length) return null;
  const steps = all.map((point) => point.step);
  const losses = all.map((point) => point.loss);
  const xMin = Math.max(0, Math.min(...steps));
  const xMax = Math.max(state.totalSteps ?? 0, ...steps, xMin + 1);
  let yMin = Math.min(...losses);
  let yMax = Math.max(...losses);
  const pad = Math.max((yMax - yMin) * 0.12, 0.02);
  yMin = Math.max(0, yMin - pad);
  yMax = yMax + pad;
  const x = (step) => (step - xMin) / Math.max(1e-9, xMax - xMin);
  const y = (loss) => (loss - yMin) / Math.max(1e-9, yMax - yMin);
  return { training, evaluation, xMin, xMax, yMin, yMax, x, y };
}

export function formatDuration(ms) {
  if (!Number.isFinite(Number(ms)) || ms < 0) return "—";
  const total = Math.floor(Number(ms) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

export function formatLoss(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(4) : "—";
}

export function formatRate(value) {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)} step/s` : "—";
}

export function formatAge(ms) {
  if (!Number.isFinite(Number(ms)) || ms < 0) return "—";
  if (ms < 1000) return "just now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  return `${Math.round(ms / 60_000)}m ago`;
}
