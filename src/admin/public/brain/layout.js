import { COMPONENT_COLORS, CONNECTION_COLORS } from "./schema.js";

export const DEFAULT_LAYOUT = {
  blockSpacing: 8.6,
  blockRadius: 6.6,
  maxNodes: 5000,
  maxEdges: 20000,
};

const LOCAL_OFFSETS = {
  input_norm: [0, 4.0, 0],
  "attn.q_proj": [-2.2, 3.0, 0.8],
  "attn.k_proj": [0, 3.4, 0],
  "attn.v_proj": [2.2, 3.0, -0.8],
  attn: [0, 4.9, 0],
  "attn.o_proj": [0, 5.9, 0],
  residual_attn: [0, 2.0, 0],
  post_norm: [0, 1.0, 0],
  "mlp.gate_proj": [-1.7, 0.0, 0.5],
  "mlp.up_proj": [1.7, 0.0, -0.5],
  "mlp.act": [0, -0.9, 0],
  "mlp.mul": [0, -1.8, 0],
  "mlp.down_proj": [0, -2.8, 0],
  residual_mlp: [0, -3.8, 0],
};

const GROUP = {
  transformer_block: "ring",
  residual: "octa",
  activation: "octa",
  elementwise: "octa",
  attention: "box",
  mlp: "box",
  model: "box",
  embedding: "sphere",
  positional_encoding: "octa",
  linear_projection: "sphere",
  normalization: "sphere",
  output_head: "sphere",
  buffer: "octa",
};

const SCALE = {
  transformer_block: 1,
  embedding: 0.9,
  positional_encoding: 0.55,
  attention: 0.7,
  mlp: 0.65,
  linear_projection: 0.42,
  normalization: 0.3,
  residual: 0.3,
  activation: 0.34,
  elementwise: 0.34,
  output_head: 0.8,
  model: 0.8,
  buffer: 0.28,
};

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function localOffset(component, indexWithinBlock) {
  const id = String(component.id ?? "");
  for (const [suffix, offset] of Object.entries(LOCAL_OFFSETS)) {
    if (id.endsWith(`.${suffix}`)) return offset;
  }
  const angle = (hashString(id) % 360) * (Math.PI / 180);
  const ring = 2.1 + ((indexWithinBlock % 3) * 0.55);
  return [Math.cos(angle) * ring, Math.sin(angle) * ring, 0];
}

function globalPosition(component, layerCount, minZ, maxZ, config) {
  const zGap = config.blockSpacing;
  switch (component.id) {
    case "model.embed_tokens":
      return [0, 0.8, minZ - zGap * 1.15];
    case "model.rotary_emb":
      return [-3.4, 2.0, minZ - zGap * 0.48];
    case "model.norm":
      return [0, 0, maxZ + zGap * 0.6];
    case "model.lm_head":
      return [0, 0, maxZ + zGap * 1.12];
    default:
      break;
  }
  if (!layerCount) return [0, 0, 0];
  const angle = (hashString(String(component.id ?? "")) % 360) * (Math.PI / 180);
  return [Math.cos(angle) * 3.2, Math.sin(angle) * 3.2, maxZ + zGap * 1.5];
}

function componentScale(component) {
  return SCALE[component.type] ?? 0.38;
}

function edgeEndpoints(connection) {
  return [connection.from, connection.to];
}

export function buildRenderPlan(blueprint, options = {}) {
  const config = { ...DEFAULT_LAYOUT, ...options };
  const warnings = [];
  const components = Array.isArray(blueprint?.components) ? blueprint.components : [];
  const connections = Array.isArray(blueprint?.connections) ? blueprint.connections : [];
  const blocks = components
    .filter((component) => component.type === "transformer_block" && Number.isInteger(component.blockIndex))
    .sort((a, b) => a.blockIndex - b.blockIndex);
  const layerCount = blocks.length
    || Number(blueprint?.model?.counts?.layers)
    || Number(blueprint?.counts?.layers)
    || 0;
  const zForLayer = (index) => (index - (layerCount - 1) / 2) * config.blockSpacing;
  const minZ = layerCount ? zForLayer(0) : 0;
  const maxZ = layerCount ? zForLayer(layerCount - 1) : 0;

  const blockIndexById = new Map(blocks.map((block) => [block.id, block.blockIndex]));
  const componentsByBlock = new Map();
  for (const block of blocks) componentsByBlock.set(block.blockIndex, []);
  for (const component of components) {
    if (Number.isInteger(component.blockIndex) && componentsByBlock.has(component.blockIndex)) {
      componentsByBlock.get(component.blockIndex).push(component);
    }
  }

  const nodes = [];
  const positions = new Map();
  for (const component of components) {
    if (component.id === "model") continue;
    let position;
    if (component.type === "transformer_block" && Number.isInteger(component.blockIndex)) {
      position = [0, 0, zForLayer(component.blockIndex)];
    } else if (Number.isInteger(component.blockIndex) && componentsByBlock.has(component.blockIndex)) {
      const siblings = componentsByBlock.get(component.blockIndex);
      const offset = localOffset(component, siblings.indexOf(component));
      const block = blocks.find((item) => item.blockIndex === component.blockIndex);
      const anchor = block ? blockIndexById.get(block.id) : component.blockIndex;
      position = [offset[0], offset[1], zForLayer(anchor) + offset[2]];
    } else {
      position = globalPosition(component, layerCount, minZ, maxZ, config);
    }
    const x = Number.isFinite(position[0]) ? position[0] : 0;
    const y = Number.isFinite(position[1]) ? position[1] : 0;
    const z = Number.isFinite(position[2]) ? position[2] : 0;
    positions.set(component.id, [x, y, z]);
    const scale = component.type === "transformer_block" ? config.blockRadius : componentScale(component);
    nodes.push({
      id: component.id,
      componentId: component.id,
      name: component.name,
      type: component.type,
      blockIndex: component.blockIndex ?? null,
      derived: component.derived === true,
      position: [x, y, z],
      scale,
      scale3: component.type === "transformer_block" ? [scale, scale, 0.38] : [scale, scale, scale],
      color: COMPONENT_COLORS[component.type] ?? COMPONENT_COLORS.buffer,
      group: GROUP[component.type] ?? "sphere",
    });
  }

  nodes.sort((a, b) => a.id.localeCompare(b.id));
  const limitedNodes = nodes.length > config.maxNodes
    ? nodes
      .filter((_, index) => index % Math.ceil(nodes.length / config.maxNodes) === 0)
      .slice(0, config.maxNodes)
    : nodes;
  if (limitedNodes.length !== nodes.length) {
    warnings.push(`render plan shows ${limitedNodes.length} of ${nodes.length} components`);
  }

  const visibleNodeIds = new Set(limitedNodes.map((node) => node.id));
  const allEdges = [];
  for (const connection of connections) {
    const [from, to] = edgeEndpoints(connection);
    if (!visibleNodeIds.has(from) || !visibleNodeIds.has(to)) continue;
    allEdges.push({
      id: connection.id,
      from,
      to,
      type: connection.type,
      explicit: connection.explicit !== false,
      inferred: connection.inferred === true,
      color: CONNECTION_COLORS[connection.type] ?? CONNECTION_COLORS.dataflow,
      points: [positions.get(from), positions.get(to)],
    });
  }
  const edgeStride = allEdges.length > config.maxEdges
    ? Math.ceil(allEdges.length / config.maxEdges)
    : 1;
  const edges = edgeStride > 1
    ? allEdges.filter((_, index) => index % edgeStride === 0).slice(0, config.maxEdges)
    : allEdges;
  if (edges.length !== allEdges.length) {
    warnings.push(`render plan shows ${edges.length} of ${allEdges.length} connections`);
  }

  let minX = Infinity;
  let minY = Infinity;
  let minZBound = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZBound = -Infinity;
  for (const node of limitedNodes) {
    minX = Math.min(minX, node.position[0]);
    minY = Math.min(minY, node.position[1]);
    minZBound = Math.min(minZBound, node.position[2]);
    maxX = Math.max(maxX, node.position[0]);
    maxY = Math.max(maxY, node.position[1]);
    maxZBound = Math.max(maxZBound, node.position[2]);
  }
  if (!Number.isFinite(minX)) {
    minX = minY = minZBound = -1;
    maxX = maxY = maxZBound = 1;
  }
  const center = [(minX + maxX) / 2, (minY + maxY) / 2, (minZBound + maxZBound) / 2];
  let radius = 0;
  for (const node of limitedNodes) {
    const dx = node.position[0] - center[0];
    const dy = node.position[1] - center[1];
    const dz = node.position[2] - center[2];
    radius = Math.max(radius, Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  radius = Math.max(radius, config.blockRadius) + 2.5;

  return {
    nodes: limitedNodes,
    edges,
    layerRings: blocks.map((block) => ({
      id: block.id,
      blockIndex: block.blockIndex,
      position: positions.get(block.id) ?? [0, 0, zForLayer(block.blockIndex)],
      radius: config.blockRadius,
      color: COMPONENT_COLORS.transformer_block,
    })),
    bounds: { center, radius, min: [minX, minY, minZBound], max: [maxX, maxY, maxZBound] },
    counts: {
      nodes: limitedNodes.length,
      edges: edges.length,
      totalNodes: nodes.length,
      totalEdges: allEdges.length,
      layers: layerCount,
    },
    warnings,
  };
}
