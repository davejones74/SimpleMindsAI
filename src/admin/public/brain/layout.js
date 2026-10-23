import { COMPONENT_COLORS, CONNECTION_COLORS } from "./schema.js";

export const DEFAULT_LAYOUT = {
  blockSpacing: 8.0,
  rowSpacing: 13.5,
  depthCurve: 8.0,
  blockScale: 1.0,
  enclosurePad: 1.35,
  targetAspect: 1.45,
  maxNodes: 5000,
  maxEdges: 20000,
};

// Local offsets for the mini-architecture inside a single transformer block,
// keyed by structural slot rather than by hard-coded layer index. The slot is
// derived from the blueprint's own parent/child relationships and `role`
// metadata, so the layout follows the exporter rather than re-encoding names.
// Coordinates: x right, y up, z toward the viewer (card depth).
const LOCAL_OFFSETS = {
  input_norm: [0.0, 4.2, 0.0],
  "attn.q_proj": [-2.2, 3.0, 0.6],
  "attn.k_proj": [0.0, 3.3, -0.2],
  "attn.v_proj": [2.2, 3.0, 0.6],
  attn: [0.0, 1.9, 0.0],
  "attn.o_proj": [0.0, 0.8, -0.4],
  residual_attn: [2.4, -0.1, 0.0],
  post_norm: [0.4, -1.1, 0.0],
  "mlp.gate_proj": [-2.2, -2.2, 0.5],
  "mlp.up_proj": [0.2, -2.2, -0.5],
  "mlp.act": [-2.2, -3.2, 0.4],
  "mlp.mul": [-0.7, -3.2, 0.0],
  "mlp.down_proj": [-0.7, -4.2, -0.4],
  residual_mlp: [2.4, -4.6, 0.0],
};

const GROUP = {
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
  embedding: 1.0,
  positional_encoding: 0.62,
  attention: 0.78,
  mlp: 0.72,
  linear_projection: 0.55,
  normalization: 0.38,
  residual: 0.34,
  activation: 0.44,
  elementwise: 0.44,
  output_head: 0.92,
  model: 0.8,
  buffer: 0.32,
};

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// Map a component to a structural slot inside a transformer block. Unknown
// components fall back to a deterministic ring so they never stack on the
// block origin, but real components land in their semantic position.
function localSlot(component) {
  const role = component.metadata?.role;
  if (role === "query") return "attn.q_proj";
  if (role === "key") return "attn.k_proj";
  if (role === "value") return "attn.v_proj";
  if (role === "attention-output") return "attn.o_proj";
  if (role === "mlp-gate") return "mlp.gate_proj";
  if (role === "mlp-up") return "mlp.up_proj";
  if (role === "mlp-down") return "mlp.down_proj";
  if (component.type === "attention") return "attn";
  if (component.type === "mlp") return "mlp";
  if (component.type === "activation") return "mlp.act";
  if (component.type === "elementwise") return "mlp.mul";
  if (component.type === "normalization") {
    return /input/.test(component.id) ? "input_norm" : "post_norm";
  }
  if (component.type === "residual") {
    return /attn/.test(component.id) ? "residual_attn" : "residual_mlp";
  }
  return null;
}

function localOffset(component, indexWithinBlock) {
  const slot = localSlot(component);
  if (slot && LOCAL_OFFSETS[slot]) return LOCAL_OFFSETS[slot];
  const angle = (hashString(component.id ?? "") % 360) * (Math.PI / 180);
  const ring = 3.4 + ((indexWithinBlock % 3) * 0.55);
  return [Math.cos(angle) * ring, Math.sin(angle) * ring * 0.7, 0];
}

// Grid positions for the transformer-block sequence. The main flow runs along
// X and folds into a serpentine of rows so long models stay balanced instead
// of collapsing into a thin strip. A gentle depth arc curves the grid toward
// the viewer to give the silhouette genuine three-dimensionality.
function blockGrid(layerCount, config) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(layerCount * config.targetAspect)));
  const rows = Math.max(1, Math.ceil(layerCount / cols));
  const xHalf = Math.max((cols - 1) * config.blockSpacing * 0.5, 1);
  const yHalf = Math.max((rows - 1) * config.rowSpacing * 0.5, 1);
  const positions = [];
  for (let index = 0; index < layerCount; index += 1) {
    const row = Math.floor(index / cols);
    let col = index % cols;
    if (row % 2 === 1) col = cols - 1 - col;
    const x = (col - (cols - 1) / 2) * config.blockSpacing;
    const y = (yHalf - row * config.rowSpacing);
    const nx = x / xHalf;
    const ny = y / yHalf;
    const dome = Math.max(0, 1 - (nx * nx + ny * ny) * 0.85);
    const z = config.depthCurve * dome;
    positions.push([x, y, z]);
  }
  return { positions, cols, rows, xHalf, yHalf };
}

function componentScale(component) {
  return SCALE[component.type] ?? 0.38;
}

function edgeEndpoints(connection) {
  return [connection.from, connection.to];
}

function localExtent() {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const offset of Object.values(LOCAL_OFFSETS)) {
    minX = Math.min(minX, offset[0]);
    minY = Math.min(minY, offset[1]);
    minZ = Math.min(minZ, offset[2]);
    maxX = Math.max(maxX, offset[0]);
    maxY = Math.max(maxY, offset[1]);
    maxZ = Math.max(maxZ, offset[2]);
  }
  return {
    width: maxX - minX,
    height: maxY - minY,
    depth: Math.max(maxZ - minZ, 0.6),
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  };
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

  const grid = blockGrid(layerCount, config);
  const extent = localExtent();
  const blockSize = [
    (extent.width + config.enclosurePad * 2) * config.blockScale,
    (extent.height + config.enclosurePad * 2) * config.blockScale,
    (extent.depth + config.enclosurePad * 2) * config.blockScale,
  ];

  const blockByIndex = new Map(blocks.map((block) => [block.blockIndex, block]));
  const componentsByBlock = new Map();
  for (const block of blocks) componentsByBlock.set(block.blockIndex, []);
  for (const component of components) {
    if (Number.isInteger(component.blockIndex) && componentsByBlock.has(component.blockIndex)) {
      componentsByBlock.get(component.blockIndex).push(component);
    }
  }

  const positions = new Map();
  const blockRecords = [];

  // Transformer blocks: an enclosure centred on the grid position plus a
  // record of its size for grouping geometry and picking.
  for (const block of blocks) {
    const gridPos = grid.positions[block.blockIndex] ?? [0, 0, 0];
    const x = Number.isFinite(gridPos[0]) ? gridPos[0] : 0;
    const y = Number.isFinite(gridPos[1]) ? gridPos[1] : 0;
    const z = Number.isFinite(gridPos[2]) ? gridPos[2] : 0;
    positions.set(block.id, [x, y, z]);
    blockRecords.push({
      id: block.id,
      blockIndex: block.blockIndex,
      position: [x, y, z],
      size: blockSize,
      color: COMPONENT_COLORS.transformer_block,
    });
  }

  const nodes = [];
  for (const component of components) {
    if (component.id === "model") continue;
    if (component.type === "transformer_block") continue;
    let position;
    if (Number.isInteger(component.blockIndex) && componentsByBlock.has(component.blockIndex)) {
      const anchor = positions.get(blockByIndex.get(component.blockIndex)?.id)
        ?? grid.positions[component.blockIndex]
        ?? [0, 0, 0];
      const siblings = componentsByBlock.get(component.blockIndex);
      const offset = localOffset(component, siblings.indexOf(component));
      position = [
        anchor[0] + offset[0] * config.blockScale,
        anchor[1] + offset[1] * config.blockScale,
        anchor[2] + offset[2] * config.blockScale,
      ];
    } else {
      position = globalPosition(component, grid, config);
    }
    const x = Number.isFinite(position[0]) ? position[0] : 0;
    const y = Number.isFinite(position[1]) ? position[1] : 0;
    const z = Number.isFinite(position[2]) ? position[2] : 0;
    positions.set(component.id, [x, y, z]);
    const scale = componentScale(component);
    nodes.push({
      id: component.id,
      componentId: component.id,
      name: component.name,
      type: component.type,
      blockIndex: component.blockIndex ?? null,
      derived: component.derived === true,
      position: [x, y, z],
      scale,
      scale3: [scale, scale, scale],
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
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const node of limitedNodes) {
    minX = Math.min(minX, node.position[0]);
    minY = Math.min(minY, node.position[1]);
    minZ = Math.min(minZ, node.position[2]);
    maxX = Math.max(maxX, node.position[0]);
    maxY = Math.max(maxY, node.position[1]);
    maxZ = Math.max(maxZ, node.position[2]);
  }
  for (const block of blockRecords) {
    const halfX = block.size[0] / 2;
    const halfY = block.size[1] / 2;
    const halfZ = block.size[2] / 2;
    minX = Math.min(minX, block.position[0] - halfX);
    minY = Math.min(minY, block.position[1] - halfY);
    minZ = Math.min(minZ, block.position[2] - halfZ);
    maxX = Math.max(maxX, block.position[0] + halfX);
    maxY = Math.max(maxY, block.position[1] + halfY);
    maxZ = Math.max(maxZ, block.position[2] + halfZ);
  }
  if (!Number.isFinite(minX)) {
    minX = minY = minZ = -1;
    maxX = maxY = maxZ = 1;
  }
  const center = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  let radius = 0;
  for (const node of limitedNodes) {
    const dx = node.position[0] - center[0];
    const dy = node.position[1] - center[1];
    const dz = node.position[2] - center[2];
    radius = Math.max(radius, Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  for (const block of blockRecords) {
    const dx = block.position[0] - center[0];
    const dy = block.position[1] - center[1];
    const dz = block.position[2] - center[2];
    radius = Math.max(radius, Math.sqrt(dx * dx + dy * dy + dz * dz) + Math.hypot(...block.size) / 2);
  }
  radius = Math.max(radius, 1) + 2.5;

  return {
    nodes: limitedNodes,
    edges,
    blocks: blockRecords,
    bounds: { center, radius, min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
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

// Placement for components that sit outside the transformer blocks (embedding,
// rotary encoding, final norm and output head). These are the two ends of the
// main axis, plus the rotary encoding clustered beside the input.
function globalPosition(component, grid, config) {
  const layerCount = grid.positions.length;
  const start = grid.positions[0] ?? [0, 0, 0];
  const end = grid.positions[layerCount - 1] ?? start;
  const cols = Math.max(1, Math.ceil(Math.sqrt(layerCount * config.targetAspect)));
  const lastRow = layerCount ? Math.floor((layerCount - 1) / cols) : 0;
  const flow = lastRow % 2 === 1 ? -1 : 1;

  switch (component.id) {
    case "model.embed_tokens":
      return [start[0] - config.blockSpacing * 1.05, start[1] + config.rowSpacing * 0.25, 0];
    case "model.rotary_emb":
      return [start[0] - config.blockSpacing * 1.1, start[1] - config.rowSpacing * 0.35, config.depthCurve * 0.4];
    case "model.norm":
      return [end[0] + flow * config.blockSpacing * 0.6, end[1] - config.rowSpacing * 0.2, 0];
    case "model.lm_head":
      return [end[0] + flow * config.blockSpacing * 1.25, end[1] - config.rowSpacing * 0.4, 0];
    default: {
      const angle = (hashString(String(component.id ?? "")) % 360) * (Math.PI / 180);
      return [
        Math.cos(angle) * config.blockSpacing * 1.6,
        end[1] + Math.sin(angle) * config.blockSpacing * 1.6,
        config.depthCurve,
      ];
    }
  }
}
