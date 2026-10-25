import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TELEMETRY_PREFIX,
  TELEMETRY_SCHEMA,
  TrainingTelemetry,
  parseTelemetryLine,
} from "../src/telemetry/training-telemetry.js";
import {
  applyTelemetryEvent,
  chartModel,
  createTelemetryState,
  telemetryDisplayStatus,
  telemetryFromSnapshot,
} from "../src/admin/public/brain/telemetry.js";

const T0 = Date.parse("2026-10-25T00:00:00Z");

function event(overrides = {}) {
  return {
    schema: TELEMETRY_SCHEMA,
    sessionId: "run-1",
    version: "v002",
    parentVersion: "v001",
    seq: 1,
    at: T0,
    type: "snapshot",
    step: 1,
    totalSteps: 10,
    loss: 2.5,
    learningRate: 1e-4,
    tokensSeen: 128,
    stepsPerSecond: 3.2,
    elapsedMs: 400,
    ...overrides,
  };
}

function makeStore(overrides = {}) {
  const emitted = [];
  const store = new TrainingTelemetry({
    emit: (snapshot) => emitted.push(snapshot),
    now: () => T0,
    publishIntervalMs: 1000,
    staleAfterMs: 5000,
    maxPoints: 5,
    ...overrides,
  });
  return { store, emitted };
}

test("telemetry lines are parsed only from their explicit stderr prefix", () => {
  const payload = parseTelemetryLine(`${TELEMETRY_PREFIX}${JSON.stringify(event())}`);
  assert.equal(payload.schema, TELEMETRY_SCHEMA);
  assert.equal(payload.seq, 1);
  assert.equal(parseTelemetryLine("[sma] ordinary log line"), null);
  assert.equal(parseTelemetryLine(`${TELEMETRY_PREFIX}{broken`), null);
});

test("snapshots update the current session and keep a bounded history", () => {
  const { store } = makeStore();
  store.beginJob({ jobId: "job-1", mode: "one-shot", at: T0 });
  for (let step = 1; step <= 14; step += 1) {
    assert.equal(store.ingest(event({ seq: step, step, loss: 3 - step * 0.1 }), { jobId: "job-1" }), true);
  }
  const snapshot = store.snapshot();
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.sessionId, "run-1");
  assert.equal(snapshot.step, 14);
  assert.ok(Math.abs(snapshot.trainLoss - 1.6) < 1e-9);
  assert.equal(snapshot.history.training.length, 10, "history is capped independently of step count");
  assert.deepEqual(snapshot.history.training.map((p) => p.step), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  store.dispose();
});

test("out-of-order sequences and late events from an old session are ignored", () => {
  const { store } = makeStore();
  store.beginJob({ jobId: "job-1", at: T0 });
  store.ingest(event({ seq: 5, step: 5, type: "started" }), { jobId: "job-1" });
  assert.equal(store.ingest(event({ seq: 4, step: 4 }), { jobId: "job-1" }), false);
  assert.equal(store.ingest(event({ seq: 9, step: 9, sessionId: "old-run" }), { jobId: "job-1" }), false);
  assert.equal(store.snapshot().seq, 5);
  assert.equal(store.snapshot().sessionId, "run-1");
  store.dispose();
});

test("a started event resets history only for a genuinely new session", () => {
  const { store } = makeStore();
  store.beginJob({ jobId: "job-1", at: T0 });
  store.ingest(event({ seq: 1, type: "started", step: 0 }), { jobId: "job-1" });
  store.ingest(event({ seq: 2, step: 1 }), { jobId: "job-1" });
  assert.equal(store.snapshot().history.training.length, 1);

  store.ingest(event({ seq: 1, type: "started", sessionId: "run-2", step: 0, loss: null }), { jobId: "job-1" });
  assert.equal(store.snapshot().sessionId, "run-2");
  assert.equal(store.snapshot().history.training.length, 0);
  store.dispose();
});

test("job status is authoritative for running, pause and terminal state", () => {
  const { store, emitted } = makeStore();
  store.beginJob({ jobId: "job-1", at: T0 });
  store.ingest(event({ seq: 1, type: "started", step: 0 }), { jobId: "job-1" });
  store.noteJob({ jobId: "job-1", status: "paused", phase: "training", at: T0 + 100 });
  assert.equal(store.snapshot().status, "paused");
  store.noteJob({ jobId: "job-1", status: "completed", at: T0 + 200 });
  const snapshot = store.snapshot({ now: T0 + 10_000 });
  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.stale, false);
  assert.ok(emitted.length >= 1);
  store.dispose();
});

test("stale live telemetry is reported as stale, not as a current measurement", () => {
  const { store } = makeStore();
  store.beginJob({ jobId: "job-1", at: T0 });
  store.ingest(event({ seq: 1, type: "started", step: 0 }), { jobId: "job-1" });
  const snapshot = store.snapshot({ now: T0 + 6000 });
  assert.equal(snapshot.stale, true);
  assert.ok(snapshot.ageMs >= 5000);
  store.dispose();
});

test("publication is coalesced rather than one event per step", async () => {
  const { store, emitted } = makeStore({ publishIntervalMs: 20 });
  store.beginJob({ jobId: "job-1", at: T0 });
  for (let step = 1; step <= 5; step += 1) {
    store.ingest(event({ seq: step, step }), { jobId: "job-1" });
  }
  await new Promise((resolve) => setTimeout(resolve, 160));
  assert.ok(emitted.length <= 3, `expected coalesced publication, got ${emitted.length}`);
  assert.ok(store.snapshot().counters.coalesced >= 1);
  assert.equal(store.snapshot().counters.published, emitted.length);
  assert.equal(emitted[0].type, "snapshot", "the delta keeps its event type for the browser reducer");
  assert.equal(emitted[0].schema, TELEMETRY_SCHEMA);
  store.dispose();
});

test("evaluation and checkpoint deltas are not lost to snapshot coalescing", () => {
  const { store, emitted } = makeStore({ publishIntervalMs: 10_000 });
  store.beginJob({ jobId: "job-1", at: T0 });
  store.ingest(event({ seq: 1, type: "started", step: 0 }), { jobId: "job-1" });
  store.ingest(event({ seq: 2, type: "snapshot", step: 1 }), { jobId: "job-1" });
  store.ingest(event({ seq: 3, type: "evaluation", step: 1, loss: 2.1 }), { jobId: "job-1" });
  store.ingest(event({ seq: 4, type: "checkpoint", step: 1, version: "v002", staged: true }), { jobId: "job-1" });
  const kinds = emitted.map((item) => item.type);
  assert.deepEqual(kinds, ["started", "snapshot", "evaluation", "checkpoint"]);
  store.dispose();
});

test("browser reducer ignores duplicate and stale-session events and keeps real points", () => {
  let state = createTelemetryState();
  const started = applyTelemetryEvent(state, event({ seq: 1, type: "started", step: 0 }), { now: T0 });
  assert.equal(started.accepted, true);
  assert.equal(applyTelemetryEvent(state, event({ seq: 1, type: "snapshot", step: 1 }), { now: T0 }).accepted, false);
  const live = applyTelemetryEvent(state, event({ seq: 2, type: "snapshot", step: 1, loss: 2.4 }), { now: T0 + 1000 });
  assert.equal(live.accepted, true);
  assert.equal(live.point.step, 1);
  assert.equal(state.history.training.length, 1);
  assert.equal(applyTelemetryEvent(state, event({ seq: 3, sessionId: "other", step: 2 }), { now: T0 + 2000 }).accepted, false);
  assert.equal(state.sessionId, "run-1");
});

test("reconnect snapshots are authoritative; unavailable snapshots never fabricate a curve", () => {
  const snapshot = telemetryFromSnapshot({
    schema: TELEMETRY_SCHEMA,
    available: true,
    status: "running",
    sessionId: "run-1",
    jobId: "job-1",
    step: 4,
    totalSteps: 10,
    trainLoss: 1.9,
    evaluationLoss: 2.0,
    receivedAt: new Date(T0).toISOString(),
    historyLimit: 600,
    staleAfterMs: 5000,
    history: {
      training: [{ step: 1, loss: 2.5 }, { step: 4, loss: 1.9 }],
      evaluation: [{ step: 4, loss: 2.0 }],
    },
  }, { now: T0 });
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.history.training.length, 2);

  const missing = telemetryFromSnapshot({ schema: TELEMETRY_SCHEMA, available: false, reason: "no live run" }, { now: T0 });
  assert.equal(missing.available, false);
  assert.equal(chartModel(missing), null);
  assert.equal(telemetryDisplayStatus(missing, { now: T0 }), "unavailable");
});

test("chart model distinguishes training and evaluation losses without inventing continuity", () => {
  const state = createTelemetryState();
  state.available = true;
  state.status = "running";
  state.totalSteps = 20;
  state.history.training = [{ step: 1, loss: 2.5 }, { step: 10, loss: 2.0 }];
  state.history.evaluation = [{ step: 10, loss: 1.8 }];
  const model = chartModel(state);
  assert.ok(model);
  assert.equal(model.training.length, 2);
  assert.equal(model.evaluation.length, 1);
  assert.ok(model.xMax >= 20);
  assert.ok(model.yMax > model.yMin);
});
