import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blueprintSummary,
  describeSelection,
  highlightFor,
  validateBlueprint,
} from "../src/admin/public/brain/schema.js";
import { buildRenderPlan } from "../src/admin/public/brain/layout.js";
import { fitCamera } from "../src/admin/public/brain/framing.js";

function component(id, type, parentId, blockIndex, extra = {}) {
  return {
    id,
    name: extra.name ?? id,
    type,
    parentId,
    blockIndex,
    derived: extra.derived ?? false,
    dimensions: extra.dimensions ?? { in: 384, out: 384 },
    tensors: extra.tensors ?? [],
    parameters: extra.parameters ?? { unique: 0, elements: 0, exact: true, counted: false },
    metadata: extra.metadata ?? {},
  };
}

function syntheticBlueprint(layers = 2, options = {}) {
  const components = [
    component("model", "model", null, null, { dimensions: { hidden: 384, layers } }),
    component("model.embed_tokens", "embedding", "model", null, {
      dimensions: { in: 128256, out: 384 },
      tensors: [{ name: "model.embed_tokens.weight", shape: [128256, 384], dtype: "float32", numel: 49250304 }],
      parameters: { unique: 49250304, elements: 49250304, exact: true, counted: true },
      metadata: { tiedOutput: true },
    }),
    component("model.rotary_emb", "positional_encoding", "model", null, {
      dimensions: { headDim: 64 },
      metadata: { learned: false, ropeTheta: 5000000, noRopeLayerIndices: [3] },
    }),
  ];
  const connections = [];
  let previous = "model.embed_tokens";
  for (let index = 0; index < layers; index += 1) {
    const block = `model.layers.${index}`;
    const attn = `${block}.attn`;
    const mlp = `${block}.mlp`;
    components.push(component(block, "transformer_block", "model", index, { metadata: { usesRope: index % 4 !== 3 } }));
    components.push(component(`${block}.input_norm`, "normalization", block, index, { dimensions: { in: 384, out: 384 } }));
    components.push(component(attn, "attention", block, index, { metadata: { numHeads: 6, numKeyValueHeads: 2, headDim: 64 } }));
    for (const [suffix, out] of [["q_proj", 384], ["k_proj", 128], ["v_proj", 128], ["o_proj", 384]]) {
      components.push(component(`${attn}.${suffix}`, "linear_projection", attn, index, {
        dimensions: { in: 384, out },
        tensors: [{ name: `model.layers.${index}.self_attn.${suffix}.weight`, shape: [out, 384], dtype: "float32", numel: out * 384 }],
        parameters: { unique: out * 384, elements: out * 384, exact: true, counted: true },
      }));
    }
    components.push(component(`${block}.residual_attn`, "residual", block, index, { derived: true }));
    components.push(component(`${block}.post_norm`, "normalization", block, index));
    components.push(component(mlp, "mlp", block, index, { metadata: { hiddenAct: "silu", intermediateSize: 1024 } }));
    for (const [suffix, shape] of [
      ["gate_proj", [1024, 384]],
      ["up_proj", [1024, 384]],
      ["down_proj", [384, 1024]],
    ]) {
      components.push(component(`${mlp}.${suffix}`, "linear_projection", mlp, index, {
        dimensions: { in: shape[1], out: shape[0] },
        tensors: [{ name: `model.layers.${index}.mlp.${suffix}.weight`, shape, dtype: "float32", numel: shape[0] * shape[1] }],
        parameters: { unique: shape[0] * shape[1], elements: shape[0] * shape[1], exact: true, counted: true },
      }));
    }
    components.push(component(`${mlp}.act`, "activation", mlp, index, { derived: true }));
    components.push(component(`${mlp}.mul`, "elementwise", mlp, index, { derived: true }));
    components.push(component(`${block}.residual_mlp`, "residual", block, index, { derived: true }));

    connections.push(
      { id: `c.${index}.norm`, from: previous, to: `${block}.input_norm`, type: "dataflow", explicit: true, inferred: false, dimensions: { width: 384 }, note: null },
      { id: `c.${index}.res`, from: previous, to: `${block}.residual_attn`, type: "residual", explicit: true, inferred: false, dimensions: { width: 384 }, note: null },
    );
    for (const suffix of ["q_proj", "k_proj", "v_proj"]) {
      connections.push(
        { id: `c.${index}.${suffix}`, from: `${block}.input_norm`, to: `${attn}.${suffix}`, type: "dataflow", explicit: true, inferred: false, dimensions: { width: 384 }, note: null },
        { id: `c.${index}.${suffix}.core`, from: `${attn}.${suffix}`, to: attn, type: "dataflow", explicit: true, inferred: false, dimensions: { width: 384 }, note: null },
      );
    }
    connections.push(
      { id: `c.${index}.o`, from: attn, to: `${attn}.o_proj`, type: "dataflow", explicit: true, inferred: false, dimensions: { width: 384 }, note: null },
      { id: `c.${index}.or`, from: `${attn}.o_proj`, to: `${block}.residual_attn`, type: "dataflow", explicit: true, inferred: false, dimensions: { width: 384 }, note: null },
      { id: `c.${index}.post`, from: `${block}.residual_attn`, to: `${block}.post_norm`, type: "dataflow", explicit: true, inferred: false, dimensions: { width: 384 }, note: null },
      { id: `c.${index}.mlpres`, from: `${block}.residual_attn`, to: `${block}.residual_mlp`, type: "residual", explicit: true, inferred: false, dimensions: { width: 384 }, note: null },
      { id: `c.${index}.gate`, from: `${block}.post_norm`, to: `${mlp}.gate_proj`, type: "dataflow", explicit: true, inferred: false, dimensions: { width: 384 }, note: null },
      { id: `c.${index}.up`, from: `${block}.post_norm`, to: `${mlp}.up_proj`, type: "dataflow", explicit: true, inferred: false, dimensions: { width: 384 }, note: null },
      { id: `c.${index}.act`, from: `${mlp}.gate_proj`, to: `${mlp}.act`, type: "dataflow", explicit: true, inferred: false, dimensions: { width: 1024 }, note: null },
      { id: `c.${index}.mul1`, from: `${mlp}.act`, to: `${mlp}.mul`, type: "dataflow", explicit: true, inferred: false, dimensions: { width: 1024 }, note: null },
      { id: `c.${index}.mul2`, from: `${mlp}.up_proj`, to: `${mlp}.mul`, type: "dataflow", explicit: true, inferred: false, dimensions: { width: 1024 }, note: null },
      { id: `c.${index}.down`, from: `${mlp}.mul`, to: `${mlp}.down_proj`, type: "dataflow", explicit: true, inferred: false, dimensions: { width: 1024 }, note: null },
      { id: `c.${index}.downres`, from: `${mlp}.down_proj`, to: `${block}.residual_mlp`, type: "dataflow", explicit: true, inferred: false, dimensions: { width: 384 }, note: null },
    );
    previous = `${block}.residual_mlp`;
  }
  components.push(
    component("model.norm", "normalization", "model", null),
    component("model.lm_head", "output_head", "model", null, {
      dimensions: { in: 384, out: 128256 },
      parameters: { unique: 0, elements: 49250304, exact: true, counted: false },
      metadata: { tied: true, tiedTo: "model.embed_tokens" },
    }),
  );
  connections.push(
    { id: "c.finalnorm", from: previous, to: "model.norm", type: "dataflow", explicit: true, inferred: false, dimensions: { width: 384 }, note: null },
    { id: "c.lmhead", from: "model.norm", to: "model.lm_head", type: "dataflow", explicit: true, inferred: false, dimensions: { width: 384 }, note: null },
    { id: "c.tied", from: "model.lm_head", to: "model.embed_tokens", type: "tied_parameter", explicit: true, inferred: false, dimensions: { width: 384 }, note: null },
  );
  const total = options.totalParameters ?? 61839744;
  return {
    schema: "sma/brain-blueprint@1",
    exportedAt: "2026-10-20T00:00:00Z",
    source: {
      activePointer: "active.json",
      activeVersion: "v061",
      artifactName: "simpleminds-62m-test",
      weightFingerprint: "deadbeef0000",
      weightsInspected: options.weightsInspected ?? "safetensors-header",
      weightsLoaded: false,
      weightFiles: [],
    },
    model: {
      id: "simpleminds-62m-test",
      version: "v061",
      architecture: "SmolLM3ForCausalLM",
      configName: "small",
      initialisation: { type: "TRAINED", pretrainedWeightsUsed: false, randomInitAncestor: "v001", lineage: [] },
      architectureConfig: { numHiddenLayers: layers, hiddenSize: 384, vocabSize: 128256 },
      counts: { layers },
    },
    parameterAccounting: {
      totalParameters: total,
      uniqueTrainable: total,
      nonTrainable: 0,
      tensorElements: total + 64,
      persistedTensorElements: total,
      nonParameterBufferElements: 64,
      tiedAliases: [{ alias: "model.lm_head.weight", canonical: "model.embed_tokens.weight", elements: 49250304, counted: false }],
      verification: {
        status: options.verification ?? "verified",
        exact: true,
        independentStructuralEvidence: "safetensors-header",
        checks: [],
        discrepancies: [],
      },
    },
    components,
    connections,
    warnings: [],
    counts: { components: components.length, connections: connections.length, layers },
  };
}

test("validates a representative small blueprint", () => {
  const blueprint = syntheticBlueprint(2);
  const result = validateBlueprint(blueprint);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("rejects missing required fields, duplicate ids, and dangling edges", () => {
  const missing = syntheticBlueprint(1);
  delete missing.parameterAccounting;
  assert.equal(validateBlueprint(missing).ok, false);

  const duplicate = syntheticBlueprint(1);
  duplicate.components.push({ ...duplicate.components[1] });
  duplicate.counts.components = duplicate.components.length;
  assert.match(validateBlueprint(duplicate).errors.join("\n"), /duplicate component id/);

  const dangling = syntheticBlueprint(1);
  dangling.connections[0].to = "model.missing";
  assert.match(validateBlueprint(dangling).errors.join("\n"), /missing destination/);
});

test("layout is deterministic and architecture-driven", () => {
  const blueprint = syntheticBlueprint(2);
  const first = buildRenderPlan(blueprint);
  const second = buildRenderPlan(blueprint);
  assert.deepEqual(first, second);
  assert.equal(first.counts.layers, 2);
  assert.ok(first.nodes.length > 20);
  assert.ok(first.bounds.radius > 0);
  for (const node of first.nodes) {
    assert.ok(node.position.every((value) => Number.isFinite(value)));
  }
});

test("a synthetic 36-layer 3B-scale blueprint stays bounded", () => {
  const blueprint = syntheticBlueprint(36, { totalParameters: 3075098624 });
  const plan = buildRenderPlan(blueprint);
  assert.equal(plan.counts.layers, 36);
  assert.ok(plan.nodes.length < 1000);
  assert.ok(plan.edges.length < 2000);
  assert.equal(plan.counts.nodes, plan.counts.totalNodes);
  assert.equal(plan.counts.edges, plan.counts.totalEdges);
  assert.ok(plan.bounds.radius > 50);
  const blockRows = new Set(plan.blocks.filter((block) => block.blockIndex != null).map((block) => block.position[1]));
  assert.ok(blockRows.size > 1, "a long model should fold into multiple rows");
  assert.ok(plan.blocks.every((block) => block.size[0] > 0 && block.size[1] > 0 && block.size[2] > 0));
  assert.equal(validateBlueprint(blueprint).ok, true);
});

test("camera framing fits both the small and synthetic 36-layer architecture", () => {
  const smallPlan = buildRenderPlan(syntheticBlueprint(2));
  const largePlan = buildRenderPlan(syntheticBlueprint(36, { totalParameters: 3075098624 }));
  const small = fitCamera(smallPlan.bounds, { aspect: 1408 / 718 });
  const large = fitCamera(largePlan.bounds, { aspect: 1408 / 718 });
  for (const fit of [small, large]) {
    assert.ok(fit.distance > 0 && Number.isFinite(fit.distance));
    assert.ok(fit.position.every(Number.isFinite));
    assert.ok(fit.center.every(Number.isFinite));
    assert.ok(fit.near > 0 && fit.near < fit.far);
    assert.ok(fit.projected.halfWidth > 0 && fit.projected.halfHeight > 0);
  }
  assert.ok(large.distance > small.distance);
  const portrait = fitCamera(smallPlan.bounds, { aspect: 0.6 });
  assert.ok(portrait.distance > small.distance, "a narrow viewport must back the camera up");
});

test("render safeguards cap a pathologically large blueprint", () => {
  const blueprint = syntheticBlueprint(3);
  const plan = buildRenderPlan(blueprint, { maxNodes: 12, maxEdges: 1 });
  assert.ok(plan.nodes.length <= 12);
  assert.ok(plan.edges.length <= 1);
  assert.ok(plan.warnings.some((warning) => warning.includes("components")));
  assert.ok(plan.counts.totalEdges >= plan.edges.length);
});

test("selection describes the component, its block, tensors, parameters and edges", () => {
  const blueprint = syntheticBlueprint(2);
  const detail = describeSelection(blueprint, "model.layers.1.attn.q_proj");
  assert.ok(detail);
  assert.equal(detail.component.type, "linear_projection");
  assert.equal(detail.blockIndex, 1);
  assert.equal(detail.block.id, "model.layers.1");
  assert.equal(detail.dimensions.in, 384);
  assert.equal(detail.tensors.length, 1);
  assert.equal(detail.tensors[0].shape[0], 384);
  assert.equal(detail.parameters.unique, 384 * 384);
  assert.ok(detail.incoming.some((edge) => edge.otherId === "model.layers.1.input_norm"));
  assert.ok(detail.outgoing.some((edge) => edge.otherId === "model.layers.1.attn"));
});

test("selecting a block reports aggregate structure and contained tensors", () => {
  const blueprint = syntheticBlueprint(2);
  const detail = describeSelection(blueprint, "model.layers.0");
  assert.ok(detail.aggregate.components > 0);
  assert.ok(detail.aggregate.parametersUnique > 0);
  assert.ok(detail.aggregate.tensorElements > 0);
  assert.ok(detail.descendantTensors.length > 0);
  assert.ok(detail.descendantTensors.every((tensor) => tensor.componentId));
});

test("selecting a block highlights its children and crossing edges", () => {
  const blueprint = syntheticBlueprint(2);
  const highlight = highlightFor(blueprint, "model.layers.0");
  assert.ok(highlight.componentIds.has("model.layers.0"));
  assert.ok(highlight.componentIds.has("model.layers.0.attn.q_proj"));
  assert.ok(highlight.connectionIds.has("c.0.norm"));
  assert.ok(highlight.connectionIds.has("c.0.downres"));
  assert.equal(highlightFor(blueprint, "missing").componentIds.size, 0);
});

test("containers report boundary and internal connections rather than zero", () => {
  const blueprint = syntheticBlueprint(2);

  const block = describeSelection(blueprint, "model.layers.0");
  assert.equal(block.isContainer, true);
  assert.ok(block.containedComponents > 0);
  assert.equal(block.incoming.length, 0, "the block itself has no directly attached edges");
  assert.equal(block.outgoing.length, 0);
  assert.ok(block.internal.length > 0, "a block has internal connections between its children");
  assert.ok(block.interfaceIncoming.length > 0, "a block has boundary incoming connections");
  assert.ok(block.interfaceOutgoing.length > 0, "a block has boundary outgoing connections");
  assert.ok(block.internal.every((edge) => edge.otherId !== "model.layers.0"));

  const mlp = describeSelection(blueprint, "model.layers.0.mlp");
  assert.equal(mlp.isContainer, true);
  assert.ok(mlp.internal.length > 0, "the MLP has child-to-child edges (gate->act, up->mul, ...)");
  assert.ok(mlp.interfaceIncoming.length > 0);
  assert.ok(mlp.interfaceOutgoing.length > 0);

  const attn = describeSelection(blueprint, "model.layers.0.attn");
  assert.equal(attn.isContainer, true);
  assert.ok(attn.incoming.length > 0, "the attention core has direct incoming projections");
  assert.ok(attn.outgoing.length > 0, "the attention core has a direct outgoing projection");

  const leaf = describeSelection(blueprint, "model.layers.0.attn.q_proj");
  assert.equal(leaf.isContainer, false);
  assert.equal(leaf.internal.length, 0);
  assert.equal(leaf.containedComponents, 0);
  assert.ok(leaf.incoming.length > 0);
  assert.ok(leaf.outgoing.length > 0);
});

test("tied and unverified metadata is surfaced, not hidden", () => {
  const blueprint = syntheticBlueprint(1, { verification: "unverified" });
  const summary = blueprintSummary(blueprint);
  assert.equal(summary.verification, "unverified");
  assert.equal(summary.layers, 1);
  const detail = describeSelection(blueprint, "model.lm_head");
  assert.equal(detail.labels.tied, true);
  assert.equal(detail.parameters.counted, false);
  assert.equal(detail.parameters.elements, 49250304);
});

test("malformed renderer input is handled without throwing", () => {
  const plan = buildRenderPlan(null);
  assert.deepEqual(plan.nodes, []);
  assert.deepEqual(plan.edges, []);
  assert.equal(describeSelection(null, "anything"), null);
});
