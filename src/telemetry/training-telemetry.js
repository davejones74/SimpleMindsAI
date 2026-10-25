/**
 * Bounded, observational training telemetry.
 *
 * Python emits at most one structured snapshot per configured interval over the
 * EXISTING child-process stderr pipe. This module turns that stream into a
 * small, restartable in-process state for the admin API and the existing SSE
 * change feed. It never reads weights, activations or per-parameter data, and
 * it cannot block a training step: ingestion is synchronous and publication is
 * coalesced on a timer.
 */

export const TELEMETRY_SCHEMA = "sma/training-telemetry@1";
export const TELEMETRY_PREFIX = "__SMA_TELEMETRY__ ";

export const TELEMETRY_EVENT_TYPES = Object.freeze([
  "started",
  "snapshot",
  "evaluation",
  "checkpoint",
  "completed",
  "failed",
]);

const TERMINAL = new Set(["completed", "failed", "stopped", "interrupted"]);
const STALE_EXPECTED = new Set(["running"]);

const finiteOrNull = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
const intOrNull = (value) => (Number.isInteger(Number(value)) ? Number(value) : null);
const isoNow = (now) => new Date(now).toISOString();
const MAX_LAYER_ACTIVITY_LAYERS = 128;

/**
 * Validate and bound the optional per-layer extension. Unknown or malformed
 * payloads are dropped rather than turned into invented activity. `rms: null`
 * is a legitimate "measured but unavailable" value.
 */
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
    sampledAt: typeof value.sampledAt === "string" ? value.sampledAt : null,
    layers,
  };
}

/** Parse one stderr line from the Python telemetry channel. */
export function parseTelemetryLine(line) {
  const text = String(line ?? "");
  if (!text.startsWith(TELEMETRY_PREFIX)) return null;
  try {
    const parsed = JSON.parse(text.slice(TELEMETRY_PREFIX.length));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function pushPoint(list, point, limit) {
  const last = list[list.length - 1];
  if (last && last.step === point.step) {
    list[list.length - 1] = point;
  } else {
    if (last && point.step < last.step) return false;
    list.push(point);
  }
  if (list.length > limit) list.splice(0, list.length - limit);
  return true;
}

export class TrainingTelemetry {
  constructor({
    emit = () => {},
    now = () => Date.now(),
    maxPoints = 600,
    publishIntervalMs = 1000,
    staleAfterMs = 5000,
    maxCheckpoints = 40,
  } = {}) {
    const finiteInt = (value, fallback) => (
      Number.isFinite(Number(value)) ? Math.floor(Number(value)) : fallback
    );
    this.emit = emit;
    this.now = now;
    this.maxPoints = Math.max(10, finiteInt(maxPoints, 600));
    this.publishIntervalMs = Math.max(100, finiteInt(publishIntervalMs, 1000));
    this.staleAfterMs = Math.max(this.publishIntervalMs, finiteInt(staleAfterMs, 5000));
    this.maxCheckpoints = Math.max(1, finiteInt(maxCheckpoints, 40));
    this.timer = null;
    this.pending = [];
    this.pendingLimit = 8;
    this.disposed = false;
    this.state = this.#emptyState();
  }

  #emptyState() {
    return {
      schema: TELEMETRY_SCHEMA,
      available: false,
      source: null,
      status: "unavailable",
      reason: "no live training telemetry for this server session",
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
      lastEvent: null,
      lastCheckpoint: null,
      layerActivity: null,
      history: { training: [], evaluation: [] },
      checkpoints: [],
      counters: { received: 0, accepted: 0, ignored: 0, coalesced: 0, published: 0, dropped: 0 },
    };
  }

  get currentJobId() {
    return this.state.jobId;
  }

  /** A new managed training job starts: discard the previous run's history. */
  beginJob({ jobId, mode = null, at = this.now() } = {}) {
    if (!jobId) return false;
    if (this.state.jobId === jobId && !TERMINAL.has(this.state.status)) return true;
    const counters = this.state.counters;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = [];
    this.state = {
      ...this.#emptyState(),
      available: true,
      source: "subprocess",
      status: "running",
      reason: null,
      jobId,
      mode,
      startedAt: isoNow(at),
      updatedAt: isoNow(at),
      receivedAt: isoNow(at),
      counters: { ...counters },
    };
    return true;
  }

  /**
   * Ingest one Python event. Stale sessions and out-of-order sequences are
   * ignored rather than allowed to overwrite the current run.
   */
  ingest(event, { jobId = null, now = this.now() } = {}) {
    if (this.disposed) return false;
    if (!event || event.schema !== TELEMETRY_SCHEMA) return this.#ignore();
    if (!TELEMETRY_EVENT_TYPES.includes(event.type)) return this.#ignore();
    if (jobId && this.state.jobId && jobId !== this.state.jobId) return this.#ignore();

    const sessionId = typeof event.sessionId === "string" && event.sessionId ? event.sessionId : null;
    const seq = intOrNull(event.seq);
    if (!sessionId || seq === null || seq <= 0) return this.#ignore();

    if (this.state.sessionId && sessionId !== this.state.sessionId) {
      // A late event from a previous subprocess can never replace the current
      // session. Only an explicit `started` begins a new one.
      if (event.type !== "started") return this.#ignore();
      this.state.history = { training: [], evaluation: [] };
      this.state.checkpoints = [];
      this.state.lastCheckpoint = null;
      this.state.layerActivity = null;
      this.state.sessionId = sessionId;
      this.state.seq = 0;
    }

    if (this.state.sessionId === sessionId && seq <= this.state.seq) return this.#ignore();
    if (!this.state.sessionId) this.state.sessionId = sessionId;

    this.state.counters.received += 1;
    this.state.seq = seq;
    this.state.available = true;
    this.state.source = "subprocess";
    this.state.reason = null;
    this.state.lastEvent = event.type;
    this.state.receivedAt = isoNow(now);
    this.state.updatedAt = Number.isFinite(Number(event.at)) ? isoNow(Number(event.at)) : this.state.receivedAt;
    if (jobId) this.state.jobId = jobId;
    if (event.version) this.state.version = String(event.version);
    if (event.parentVersion) this.state.parentVersion = String(event.parentVersion);

    if (event.type === "started") {
      this.state.status = "running";
      this.state.startedAt = this.state.updatedAt;
    }

    if (event.type === "snapshot") {
      const step = intOrNull(event.step);
      const loss = finiteOrNull(event.loss);
      if (step !== null) this.state.step = step;
      if (Number.isInteger(Number(event.totalSteps))) this.state.totalSteps = Number(event.totalSteps);
      if (loss !== null) this.state.trainLoss = loss;
      const learningRate = finiteOrNull(event.learningRate);
      if (learningRate !== null) this.state.learningRate = learningRate;
      const stepsPerSecond = finiteOrNull(event.stepsPerSecond);
      if (stepsPerSecond !== null) this.state.stepsPerSecond = stepsPerSecond;
      const stepSeconds = finiteOrNull(event.stepSeconds);
      if (stepSeconds !== null) this.state.stepSeconds = stepSeconds;
      const tokensSeen = intOrNull(event.tokensSeen);
      if (tokensSeen !== null) this.state.tokensSeen = tokensSeen;
      const elapsedMs = finiteOrNull(event.elapsedMs);
      if (elapsedMs !== null) this.state.elapsedMs = elapsedMs;
      if (step !== null && loss !== null) {
        pushPoint(this.state.history.training, { step, loss, at: this.state.updatedAt }, this.maxPoints);
      }
      if (event.layerActivity !== undefined) {
        const layerActivity = cleanLayerActivity(event.layerActivity);
        if (layerActivity) {
          layerActivity.sampledAt = this.state.updatedAt;
          this.state.layerActivity = layerActivity;
        }
      }
      this.state.status = "running";
    } else if (event.type === "evaluation") {
      const step = intOrNull(event.step) ?? this.state.step;
      const loss = finiteOrNull(event.loss);
      if (loss !== null) {
        this.state.evaluationLoss = loss;
        if (step !== null) pushPoint(this.state.history.evaluation, { step, loss, at: this.state.updatedAt }, this.maxPoints);
      }
    } else if (event.type === "checkpoint") {
      const checkpoint = {
        at: this.state.updatedAt,
        step: intOrNull(event.step) ?? this.state.step,
        version: event.version ? String(event.version) : this.state.version,
        staged: event.staged === true,
      };
      this.state.lastCheckpoint = checkpoint;
      this.state.checkpoints.push(checkpoint);
      if (this.state.checkpoints.length > this.maxCheckpoints) {
        this.state.checkpoints.splice(0, this.state.checkpoints.length - this.maxCheckpoints);
      }
    } else if (event.type === "completed") {
      this.state.status = "completed";
      this.state.completedAt = this.state.updatedAt;
      const trainLoss = finiteOrNull(event.finalTrainLoss);
      if (trainLoss !== null) this.state.trainLoss = trainLoss;
      const evaluationLoss = finiteOrNull(event.finalValidationLoss);
      if (evaluationLoss !== null) this.state.evaluationLoss = evaluationLoss;
      if (Number.isInteger(Number(event.step))) this.state.step = Number(event.step);
    } else if (event.type === "failed") {
      this.state.status = "failed";
      this.state.completedAt = this.state.updatedAt;
      this.state.error = event.error ? String(event.error).slice(0, 500) : "training failed";
    }

    this.state.counters.accepted += 1;
    this.#enqueue(event, jobId);
    if (event.type === "snapshot" && !TERMINAL.has(this.state.status)) {
      this.#schedule(false);
    } else {
      // Evaluation, checkpoint and terminal events are not redundant and must
      // not be lost to snapshot coalescing.
      this.#flush();
    }
    return true;
  }

  /** Job lifecycle status (started/paused/resumed/completed/failed/stopped). */
  noteJob({ jobId, status = null, phase = null, note = null, at = this.now() } = {}) {
    if (this.disposed || !jobId) return false;
    if (!this.state.jobId) this.beginJob({ jobId, at });
    if (this.state.jobId !== jobId) return false;
    if (!status && !phase && !note) return false;
    const changed = !status || status !== this.state.status || phase !== this.state.phase || note !== this.state.note;
    if (!changed) return false;
    if (status) this.state.status = String(status);
    if (phase !== null) this.state.phase = phase ? String(phase) : null;
    if (note !== null) this.state.note = note ? String(note) : null;
    this.state.updatedAt = isoNow(at);
    this.state.receivedAt = isoNow(at);
    if (TERMINAL.has(this.state.status)) {
      this.state.completedAt = this.state.updatedAt;
      this.#flush();
    }
    return true;
  }

  snapshot({ includeHistory = true, now = this.now() } = {}) {
    const state = this.state;
    const reference = state.receivedAt ?? state.updatedAt ?? state.startedAt;
    const ageMs = reference ? Math.max(0, now - Date.parse(reference)) : null;
    const stale = Boolean(
      STALE_EXPECTED.has(state.status)
      && ageMs !== null
      && ageMs > this.staleAfterMs,
    );
    return {
      schema: TELEMETRY_SCHEMA,
      available: state.available,
      source: state.source,
      status: state.status,
      reason: state.reason,
      jobId: state.jobId,
      mode: state.mode,
      sessionId: state.sessionId,
      version: state.version,
      parentVersion: state.parentVersion,
      step: state.step,
      totalSteps: state.totalSteps,
      trainLoss: state.trainLoss,
      evaluationLoss: state.evaluationLoss,
      learningRate: state.learningRate,
      stepsPerSecond: state.stepsPerSecond,
      stepSeconds: state.stepSeconds,
      tokensSeen: state.tokensSeen,
      elapsedMs: state.elapsedMs,
      phase: state.phase,
      note: state.note,
      error: state.error,
      seq: state.seq,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
      updatedAt: state.updatedAt,
      receivedAt: state.receivedAt,
      lastEvent: state.lastEvent,
      lastCheckpoint: state.lastCheckpoint ? { ...state.lastCheckpoint } : null,
      layerActivity: state.layerActivity
        ? {
            ...state.layerActivity,
            layers: state.layerActivity.layers.map((layer) => ({ ...layer })),
          }
        : null,
      stale,
      ageMs,
      staleAfterMs: this.staleAfterMs,
      publishIntervalMs: this.publishIntervalMs,
      historyLimit: this.maxPoints,
      counters: { ...state.counters },
      ...(includeHistory
        ? {
            history: {
              training: state.history.training.map((point) => ({ ...point })),
              evaluation: state.history.evaluation.map((point) => ({ ...point })),
            },
            checkpoints: state.checkpoints.map((checkpoint) => ({ ...checkpoint })),
          }
        : {}),
    };
  }

  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  #ignore() {
    this.state.counters.ignored += 1;
    return false;
  }

  #enqueue(event, jobId) {
    const delta = {
      ...event,
      schema: TELEMETRY_SCHEMA,
      jobId: jobId ?? this.state.jobId,
    };
    const last = this.pending[this.pending.length - 1];
    if (event.type === "snapshot" && last?.type === "snapshot") {
      this.pending[this.pending.length - 1] = delta;
      this.state.counters.coalesced += 1;
      return;
    }
    this.pending.push(delta);
    if (this.pending.length > this.pendingLimit) {
      this.pending.shift();
      this.state.counters.dropped += 1;
    }
  }

  #schedule(immediate) {
    if (this.disposed) return;
    if (immediate) {
      this.#flush();
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.#flush();
    }, this.publishIntervalMs);
    this.timer.unref?.();
  }

  #flush() {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    while (this.pending.length) {
      const delta = this.pending.shift();
      this.state.counters.published += 1;
      try {
        this.emit(delta);
      } catch {
        // A dead consumer must never affect training or later publication.
      }
    }
  }
}
