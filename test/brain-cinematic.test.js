import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  DEFAULT_EFFECT_SETTINGS,
  activityVisualSpec,
  effectSummary,
  effectVisibility,
  effectiveMotion,
  normalizeEffectSettings,
  telemetryMood,
} from "../src/admin/public/brain/cinematic.js";
import { buildRenderPlan, DEFAULT_LAYOUT } from "../src/admin/public/brain/layout.js";
import {
  TELEMETRY_SCHEMA,
  telemetryDisplayStatus,
  telemetryFromSnapshot,
} from "../src/admin/public/brain/telemetry.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function component(id, type, parentId, blockIndex, extra = {}) {
  return {
    id,
    name: id,
    type,
    parentId,
    blockIndex,
    derived: extra.derived ?? false,
    dimensions: { in: 384, out: 384 },
    tensors: [],
    parameters: { unique: 0, elements: 0, exact: true, counted: false },
    metadata: {},
  };
}

function syntheticBlueprint(layers) {
  const components = [
    component("model", "model", null, null),
    component("model.embed_tokens", "embedding", "model", null),
    component("model.rotary_emb", "positional_encoding", "model", null),
  ];
  const connections = [];
  for (let index = 0; index < layers; index += 1) {
    const block = `model.layers.${index}`;
    components.push(
      component(block, "transformer_block", "model", index),
      component(`${block}.input_norm`, "normalization", block, index),
      component(`${block}.attn`, "attention", block, index),
      component(`${block}.attn.q_proj`, "linear_projection", `${block}.attn`, index),
      component(`${block}.mlp`, "mlp", block, index),
      component(`${block}.mlp.gate_proj`, "linear_projection", `${block}.mlp`, index),
      component(`${block}.residual_mlp`, "residual", block, index, { derived: true }),
    );
    const previous = index === 0 ? "model.embed_tokens" : `model.layers.${index - 1}.residual_mlp`;
    connections.push(
      { id: `c.${index}.in`, from: previous, to: `${block}.input_norm`, type: "dataflow", explicit: true, inferred: false, dimensions: { width: 384 } },
      { id: `c.${index}.q`, from: `${block}.input_norm`, to: `${block}.attn.q_proj`, type: "dataflow", explicit: true, inferred: false, dimensions: { width: 384 } },
      { id: `c.${index}.out`, from: `${block}.attn`, to: `${block}.residual_mlp`, type: "residual", explicit: true, inferred: false, dimensions: { width: 384 } },
      { id: `c.${index}.gate`, from: `${block}.input_norm`, to: `${block}.mlp.gate_proj`, type: "dataflow", explicit: true, inferred: false, dimensions: { width: 384 } },
    );
  }
  components.push(component("model.norm", "normalization", "model", null));
  components.push(component("model.lm_head", "output_head", "model", null));
  return {
    schema: "sma/brain-blueprint@1",
    exportedAt: "2026-10-20T00:00:00Z",
    source: {
      activeVersion: "v061",
      artifactName: "synthetic",
      weightsInspected: "safetensors-header",
      weightsLoaded: false,
    },
    model: {
      version: "v061",
      architecture: "SmolLM3ForCausalLM",
      counts: { layers },
    },
    parameterAccounting: {
      totalParameters: 61839744,
      uniqueTrainable: 61839744,
      tensorElements: 61839808,
      verification: { status: "verified", exact: true, checks: [], discrepancies: [] },
    },
    components,
    connections,
    warnings: [],
    counts: { components: components.length, connections: connections.length, layers },
  };
}

test("effect settings are clamped and reduced motion is the default when requested", () => {
  const normalized = normalizeEffectSettings({
    cinematic: false,
    ambientDensity: 9,
    intensity: -2,
    speed: 100,
    signals: false,
    attention: false,
  }, { prefersReducedMotion: true });
  assert.equal(normalized.cinematic, false);
  assert.equal(normalized.ambientDensity, 1.6);
  assert.equal(normalized.intensity, 0.3);
  assert.equal(normalized.speed, 2.5);
  assert.equal(normalized.reducedMotion, true);
  assert.equal(normalized.signals, false);
  assert.equal(normalized.attention, false);

  const explicit = normalizeEffectSettings({ reducedMotion: false }, { prefersReducedMotion: true });
  assert.equal(explicit.reducedMotion, false, "an explicit user choice overrides the system default");
  assert.equal(normalizeEffectSettings().ambientDensity, DEFAULT_EFFECT_SETTINGS.ambientDensity);
});

test("reduced motion suppresses travelling pulses but keeps gentle ambient motion", () => {
  const full = effectiveMotion(normalizeEffectSettings({ reducedMotion: false }));
  const reduced = effectiveMotion(normalizeEffectSettings({ reducedMotion: true }));
  assert.equal(full.signals, true);
  assert.equal(full.attention, true);
  assert.equal(reduced.signals, false);
  assert.equal(reduced.attention, false);
  assert.equal(reduced.rotate, false);
  assert.ok(reduced.speed < full.speed);
  assert.ok(reduced.amplitude < full.amplitude);
  assert.ok(reduced.drift > 0, "ambient drift remains, only at a much lower rate");
  assert.equal(full.bursts, true);
  assert.equal(full.strobe, true);
});

test("effect visibility keeps independent toggles independent and hides art in Architecture", () => {
  const settings = normalizeEffectSettings({ reducedMotion: false, signals: false });
  const brain = effectVisibility(settings, "brain", { layerActivity: true });
  assert.equal(brain.ambient, true);
  assert.equal(brain.synaptic, true);
  assert.equal(brain.signals, false, "signals can be off while ambient remains on");
  assert.equal(brain.attention, true);
  assert.equal(brain.layerActivity, true);
  assert.equal(brain.activity, true);

  const noAmbient = effectVisibility({ ...settings, ambientDensity: 0 }, "brain");
  assert.equal(noAmbient.decorative, false);
  assert.equal(noAmbient.layerActivity, false);

  const architecture = effectVisibility(settings, "architecture", { layerActivity: true });
  assert.equal(architecture.ambient, false);
  assert.equal(architecture.synaptic, false);
  assert.equal(architecture.signals, false);
  assert.equal(architecture.attention, false);
  assert.equal(architecture.layerActivity, false);
});

test("telemetry moods are honest, distinct and never claim a measurement for stale data", () => {
  const live = telemetryMood("live");
  assert.equal(live.key, "live");
  assert.ok(live.energy > telemetryMood("stale").energy);
  assert.equal(telemetryMood("stale").label, "Telemetry stale");
  assert.equal(telemetryMood("failed").key, "failed");
  assert.equal(telemetryMood("failed").allowStrobe, false);
  assert.equal(telemetryMood("unavailable").key, "ambient");
  assert.equal(telemetryMood("paused").key, "paused");
  assert.match(effectSummary(normalizeEffectSettings({ reducedMotion: true })), /Reduced/);
});

test("ambient motion is defined for unavailable, stale and reconnected telemetry", () => {
  const settings = normalizeEffectSettings({ reducedMotion: false });
  const unavailable = telemetryFromSnapshot(
    { schema: TELEMETRY_SCHEMA, available: false, reason: "no run" },
    { now: 0 },
  );
  const unavailableStatus = telemetryDisplayStatus(unavailable, { now: 0 });
  assert.equal(unavailableStatus, "unavailable");
  assert.equal(telemetryMood(unavailableStatus).key, "ambient");
  const ambient = effectVisibility(settings, "brain");
  assert.equal(ambient.signals, true, "illustrative motion continues with no telemetry");
  assert.equal(ambient.ambient, true);

  const stale = telemetryFromSnapshot({
    schema: TELEMETRY_SCHEMA,
    available: true,
    status: "running",
    sessionId: "run-1",
    receivedAt: new Date(0).toISOString(),
    staleAfterMs: 5000,
  }, { now: 0 });
  const staleStatus = telemetryDisplayStatus(stale, { now: 6000, connection: "live" });
  assert.equal(staleStatus, "stale");
  assert.equal(telemetryMood(staleStatus).key, "stale");
  assert.equal(effectVisibility(settings, "brain").signals, true, "stale telemetry must not freeze the universe");

  const reconnected = telemetryFromSnapshot({
    schema: TELEMETRY_SCHEMA,
    available: true,
    status: "running",
    sessionId: "run-1",
    receivedAt: new Date(7000).toISOString(),
    staleAfterMs: 5000,
  }, { now: 7000 });
  const reconnectedStatus = telemetryDisplayStatus(reconnected, { now: 7100, connection: "live" });
  assert.equal(reconnectedStatus, "live");
  assert.equal(telemetryMood(reconnectedStatus).key, "live");
});

test("event visual signatures are distinct for step, checkpoint, evaluation, failure and recovery", () => {
  const step = activityVisualSpec("step");
  const checkpoint = activityVisualSpec("checkpoint");
  const evaluation = activityVisualSpec("evaluation");
  const failure = activityVisualSpec("failure");
  const recovery = activityVisualSpec("recovery");
  assert.equal(step.kind, "step");
  assert.equal(checkpoint.kind, "checkpoint");
  assert.ok(checkpoint.rings > step.rings);
  assert.ok(checkpoint.duration > step.duration);
  assert.notEqual(checkpoint.color, evaluation.color);
  assert.notEqual(failure.color, recovery.color);
  assert.ok(recovery.energy > failure.energy);
});

test("the deep-space and speculative layers are deterministic and never architecture", () => {
  const blueprint = syntheticBlueprint(8);
  const first = buildRenderPlan(blueprint);
  const second = buildRenderPlan(blueprint);
  assert.deepEqual(first, second, "the whole cinematic plan is deterministic");

  assert.ok(first.ambient.stars.count >= 3600);
  assert.equal(first.ambient.stars.positions.length, first.ambient.stars.count * 3);
  assert.ok(first.ambient.clouds.length >= 12);
  assert.ok(first.ambient.wisps.length >= 56);
  assert.ok(first.attention.length >= 6);

  const componentIds = new Set(blueprint.components.map((entry) => entry.id));
  const connectionIds = new Set(blueprint.connections.map((entry) => entry.id));
  for (const cloud of first.ambient.clouds) {
    assert.match(cloud.id, /^ambient\.cloud\./);
    assert.equal(cloud.kind, "ambient");
    assert.ok(!componentIds.has(cloud.id));
  }
  for (const wisp of first.ambient.wisps) {
    assert.match(wisp.id, /^ambient\.wisp\./);
    assert.equal(wisp.kind, "ambient");
    assert.ok(wisp.points.length > 2);
  }
  for (const arc of first.attention) {
    assert.match(arc.id, /^attention\./);
    assert.equal(arc.kind, "speculative");
    assert.ok(!componentIds.has(arc.id));
    assert.ok(!connectionIds.has(arc.id));
    assert.ok(arc.points.length > 5);
  }
  assert.equal(first.counts.nodes, first.counts.totalNodes);
  assert.equal(first.counts.edges, first.counts.totalEdges);
  assert.ok(first.counts.decorativeObjects > first.counts.nodes + first.counts.edges);
});

test("a 36-layer ambient/attention plan stays within its own budgets", () => {
  const plan = buildRenderPlan(syntheticBlueprint(36));
  assert.equal(plan.counts.layers, 36);
  assert.ok(plan.counts.synapticNodes <= DEFAULT_LAYOUT.maxSynapticNodes);
  assert.ok(plan.counts.filaments <= DEFAULT_LAYOUT.maxFilaments);
  assert.ok(plan.counts.ambientStars <= DEFAULT_LAYOUT.maxAmbientStars);
  assert.ok(plan.counts.ambientClusters <= DEFAULT_LAYOUT.maxAmbientClusters);
  assert.ok(plan.counts.ambientWisps <= DEFAULT_LAYOUT.maxAmbientWisps);
  assert.ok(plan.counts.attentionArcs <= DEFAULT_LAYOUT.maxAttentionArcs);
  assert.equal(plan.counts.attentionArcs, DEFAULT_LAYOUT.maxAttentionArcs, "a longer model still gets the full attention field");
  assert.ok(plan.counts.synapticNodes > 2400, "the Phase 1.8 web is materially denser");
  assert.ok(plan.counts.filaments > 2000, "the Phase 1.8 web is materially denser");
});

test("decorative planning does not mutate the blueprint or its parameter accounting", () => {
  const blueprint = syntheticBlueprint(8);
  const before = JSON.stringify(blueprint);
  const plan = buildRenderPlan(blueprint);
  assert.equal(JSON.stringify(blueprint), before);
  assert.equal(blueprint.parameterAccounting.totalParameters, 61839744);
  assert.equal(plan.counts.layers, 8);
  assert.notEqual(plan.counts.decorativeObjects, blueprint.parameterAccounting.totalParameters);
});

test("the living controls and honest visual legend are present in the standalone page", () => {
  const html = readFileSync(path.join(HERE, "..", "src", "admin", "public", "brain", "index.html"), "utf8");
  for (const id of [
    "livingToggle",
    "livingPanel",
    "cinematicToggle",
    "signalsToggle",
    "attentionToggle",
    "ambientDensity",
    "animationIntensity",
    "animationSpeed",
    "reducedMotionToggle",
    "livingReset",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing ${id}`);
  }
  assert.match(html, /Speculative attention/i);
  assert.match(html, /Illustrative signals/i);
  assert.match(html, /Reduced motion/i);
});

test("the browser module wires telemetry to the cinematic status and never enables gradients by default", () => {
  const source = readFileSync(path.join(HERE, "..", "src", "admin", "public", "brain", "brain.js"), "utf8");
  assert.match(source, /setTelemetryStatus/);
  assert.match(source, /setEffectSettings/);
  assert.match(source, /prefers-reduced-motion/);
  const gradient = readFileSync(path.join(HERE, "..", "src", "admin", "public", "brain", "brain.js"), "utf8");
  assert.match(gradient, /sma\.brain\.layerActivity"\) === "on"/);
});
