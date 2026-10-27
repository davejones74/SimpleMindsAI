import { COMPONENT_COLORS, CONNECTION_COLORS } from "./schema.js";

export const DEFAULT_LAYOUT = {
  // Structural rendering caps. They are component/connection counts, never
  // parameter counts, so the work is the same for the 62M prototype and the
  // planned 3.075B model.
  maxNodes: 5000,
  maxEdges: 20000,
  // The illustrative web has its own fixed budget. It adds visual density, not
  // model detail, and is generated deterministically from the blueprint's
  // stable ids and a fixed seed. Phase 1.8 roughly doubles these populations.
  maxSynapticNodes: 4200,
  maxFilaments: 3800,
  // Deep-space decoration is deliberately separate from both the architecture
  // and the illustrative web. None of these entries has an architecture id or
  // contributes to any component, connection or parameter count.
  maxAmbientStars: 3600,
  maxAmbientClusters: 18,
  maxAmbientWisps: 110,
  maxAttentionArcs: 28,
  layerSpacing: 8.4,
  clusterScale: 1.0,
};

// Local, dimensionless positions inside a transformer region. Coordinates are
// [lateral, vertical, along] in the region's own basis. The slot is chosen from
// the blueprint's role metadata and parent/child structure, not from a layer
// number, so the same layout serves eight layers or thirty-six.
const LOCAL_OFFSETS = {
  input_norm: [-0.32, 0.58, -0.78],
  "attn.q_proj": [-0.86, 0.34, -0.34],
  "attn.k_proj": [-0.34, 0.92, -0.08],
  "attn.v_proj": [0.66, 0.58, 0.12],
  attn: [0.02, 0.12, 0.04],
  "attn.o_proj": [0.56, -0.32, 0.16],
  residual_attn: [0.92, 0.16, 0.48],
  post_norm: [0.34, -0.64, 0.58],
  "mlp.gate_proj": [-0.78, -0.5, 0.58],
  "mlp.up_proj": [-0.08, -0.88, 0.76],
  "mlp.act": [-0.78, -0.16, 0.92],
  "mlp.mul": [-0.26, -0.44, 1.02],
  "mlp.down_proj": [0.28, -0.92, 1.08],
  residual_mlp: [0.88, -0.56, 1.24],
};

const GROUP = {
  residual: "octa",
  activation: "octa",
  elementwise: "octa",
  positional_encoding: "octa",
  buffer: "octa",
  model: "sphere",
  embedding: "sphere",
  attention: "sphere",
  mlp: "sphere",
  linear_projection: "sphere",
  normalization: "sphere",
  output_head: "sphere",
};

const SCALE = {
  embedding: 0.62,
  positional_encoding: 0.38,
  transformer_block: 0.54,
  attention: 0.5,
  mlp: 0.46,
  linear_projection: 0.34,
  normalization: 0.24,
  residual: 0.22,
  activation: 0.27,
  elementwise: 0.27,
  output_head: 0.6,
  model: 0.54,
  buffer: 0.2,
};

const SYNAPTIC_COLORS = [
  "#67e8f9",
  "#67e8f9",
  "#67e8f9",
  "#60a5fa",
  "#60a5fa",
  "#38bdf8",
  "#38bdf8",
  "#818cf8",
  "#818cf8",
  "#a78bfa",
  "#a78bfa",
  "#fbbf24",
];

const FILAMENT_COLORS = [
  "#22d3ee",
  "#22d3ee",
  "#38bdf8",
  "#38bdf8",
  "#60a5fa",
  "#818cf8",
  "#a78bfa",
  "#a78bfa",
  "#f59e0b",
];

const REGION_TINTS = ["#38bdf8", "#6d8cff", "#a78bfa", "#c084fc"];

const AMBIENT_STAR_COLORS = [
  "#dff3ff",
  "#dff3ff",
  "#bfe8ff",
  "#bfe8ff",
  "#9ad8ff",
  "#9ad8ff",
  "#7dd3fc",
  "#a5b4fc",
  "#c4b5fd",
  "#f0abfc",
  "#fde68a",
];

const NEBULA_COLORS = [
  "#0e7490",
  "#0891b2",
  "#1d4ed8",
  "#4338ca",
  "#6d28d9",
  "#9333ea",
  "#be185d",
  "#0f766e",
];

const ATTENTION_COLORS = ["#c084fc", "#a78bfa", "#e879f9", "#818cf8", "#67e8f9"];

function mixHex(first, second, t) {
  const parse = (hex) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  const a = parse(first);
  const b = parse(second);
  return `#${a.map((value, index) => (
    Math.round(value + (b[index] - value) * t).toString(16).padStart(2, "0")
  )).join("")}`;
}

function hexToRgb(hex) {
  const value = parseInt(hex.slice(1), 16);
  return [
    ((value >> 16) & 255) / 255,
    ((value >> 8) & 255) / 255,
    (value & 255) / 255,
  ];
}

function regionTint(index, count) {
  if (count <= 1) return REGION_TINTS[0];
  const scaled = (index / (count - 1)) * (REGION_TINTS.length - 1);
  const lower = Math.min(REGION_TINTS.length - 2, Math.floor(scaled));
  return mixHex(REGION_TINTS[lower], REGION_TINTS[lower + 1], scaled - lower);
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = Math.imul(value ^ (value >>> 15), 1 | value);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scaleVector = (a, scalar) => [a[0] * scalar, a[1] * scalar, a[2] * scalar];
const length = (a) => Math.hypot(a[0], a[1], a[2]);
const normalize = (a) => {
  const magnitude = length(a) || 1;
  return [a[0] / magnitude, a[1] / magnitude, a[2] / magnitude];
};
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const lerp = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

function slotFor(component) {
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

function localOffset(component, indexWithinRegion, randomForId) {
  const slot = slotFor(component);
  const base = (slot && LOCAL_OFFSETS[slot]) || null;
  if (base) return base;
  const angle = randomForId() * Math.PI * 2;
  const ring = 0.55 + (indexWithinRegion % 4) * 0.14;
  return [Math.cos(angle) * ring, Math.sin(angle) * ring * 0.7, (randomForId() - 0.5) * 1.5];
}

// A spherical spiral rather than a flat horseshoe. The transformer sequence
// still runs from the first region to the last, but it winds over an ellipsoidal
// shell so the stack reads as one coherent neural volume. Longer models add
// turns instead of becoming a long cable; illustrative core and satellite
// clusters fill the interior and the gaps.
function regionSpine(layerCount, config) {
  const count = Math.max(1, layerCount);
  const turns = count <= 1
    ? 0
    : count <= 8
      ? 1.7
      : Math.min(4.6, 1.7 + (count - 8) * 0.105);
  const radiusX = count <= 1 ? 0 : count <= 8 ? 20.0 : 23.0;
  const radiusY = count <= 1 ? 0 : count <= 8 ? 16.0 : 20.0;
  const radiusZ = count <= 1 ? 0 : count <= 8 ? 16.0 : 21.0;
  const positions = [];
  for (let index = 0; index < count; index += 1) {
    const u = count === 1 ? 0.5 : index / (count - 1);
    const phi = Math.acos(Math.max(-1, Math.min(1, 1 - 2 * u)));
    const theta = u * turns * Math.PI * 2 + 0.55;
    const modulation = 1 + 0.035 * Math.sin(theta * 2.2);
    const x = Math.sin(phi) * Math.cos(theta) * radiusX * modulation;
    const y = Math.cos(phi) * radiusY;
    const z = Math.sin(phi) * Math.sin(theta) * radiusZ * modulation;
    positions.push([x, y, z]);
  }
  return { positions, turns, radius: Math.max(radiusX, radiusY, radiusZ) };
}

function basisAt(positions, index) {
  const previous = positions[Math.max(0, index - 1)] ?? positions[index] ?? [0, 0, 0];
  const next = positions[Math.min(positions.length - 1, index + 1)] ?? positions[index] ?? [0, 0, 0];
  let tangent = sub(next, previous);
  if (length(tangent) < 1e-6) tangent = [1, 0, 0];
  tangent = normalize(tangent);
  let up = [0, 1, 0];
  if (Math.abs(tangent[1]) > 0.94) up = [0, 0, 1];
  const side = normalize(cross(tangent, up));
  const normal = normalize(cross(side, tangent));
  return { tangent, side, normal };
}

function componentScale(component, layerCount) {
  const base = SCALE[component.type] ?? 0.34;
  const parameters = Number(component.parameters?.unique) || 0;
  const mass = 1 + Math.min(0.42, Math.log10(1 + parameters) / 14);
  const growth = 1 + Math.min(0.28, Math.max(0, layerCount - 8) * 0.008);
  return base * mass * growth;
}

// The renderer uses this to keep a coherent material hierarchy: weight-bearing
// and container nodes read as polished glass/metal, while derived structural
// nodes stay matte and subdued.
function materialClassFor(component) {
  if (["embedding", "output_head", "attention", "mlp"].includes(component.type)) return "glass";
  if (component.type === "linear_projection") return "metal";
  return "matte";
}

function regionOf(component, blocksByIndex) {
  if (!Number.isInteger(component.blockIndex)) return null;
  return blocksByIndex.get(component.blockIndex) ?? null;
}

function globalPosition(component, start, end, startBasis, endBasis, config, seed) {
  const spacing = config.layerSpacing;
  switch (component.id) {
    case "model.embed_tokens":
      return add(
        add(start, scaleVector(startBasis.tangent, -spacing * 1.46)),
        add(scaleVector(startBasis.side, spacing * 0.3), scaleVector(startBasis.normal, -spacing * 0.14)),
      );
    case "model.rotary_emb":
      return add(
        add(start, scaleVector(startBasis.tangent, -spacing * 0.92)),
        add(scaleVector(startBasis.side, -spacing * 0.34), scaleVector(startBasis.normal, spacing * 0.3)),
      );
    case "model.norm":
      return add(
        add(end, scaleVector(endBasis.tangent, spacing * 0.72)),
        add(scaleVector(endBasis.side, spacing * 0.15), scaleVector(endBasis.normal, spacing * 0.14)),
      );
    case "model.lm_head":
      return add(
        add(end, scaleVector(endBasis.tangent, spacing * 1.34)),
        add(scaleVector(endBasis.side, -spacing * 0.18), scaleVector(endBasis.normal, spacing * 0.04)),
      );
    default: {
      const random = seededRandom(seed);
      const angle = random() * Math.PI * 2;
      const ring = spacing * (0.42 + random() * 0.5);
      return add(
        add(end, scaleVector(endBasis.tangent, spacing * (0.6 + random() * 0.8))),
        add(
          scaleVector(endBasis.side, Math.cos(angle) * ring),
          scaleVector(endBasis.normal, Math.sin(angle) * ring * 0.8),
        ),
      );
    }
  }
}

function perpendicularTo(vector, seed) {
  const random = seededRandom(seed);
  let reference = [0, 1, 0];
  if (Math.abs(normalize(vector)[1]) > 0.9) reference = [0, 0, 1];
  let perpendicular = normalize(cross(vector, reference));
  if (length(perpendicular) < 1e-5) perpendicular = [0, 0, 1];
  // Rotate the perpendicular around the edge once, deterministically, so the
  // bundle of real connections does not all bow in the same direction.
  const mix = random();
  return normalize([
    perpendicular[0] + reference[0] * (mix - 0.5) * 0.6,
    perpendicular[1] + reference[1] * (mix - 0.5) * 0.6,
    perpendicular[2] + reference[2] * (mix - 0.5) * 0.6,
  ]);
}

function curveBetween(from, to, connection) {
  const delta = sub(to, from);
  const distance = length(delta);
  const seed = hashString(connection.id ?? `${connection.from}->${connection.to}`);
  const random = seededRandom(seed);
  const bowDirection = perpendicularTo(delta, seed ^ 0x9e3779b9);
  const bowScale = connection.type === "residual" ? 0.2 : connection.type === "tied_parameter" ? 0.26 : 0.14;
  const bow = Math.min(distance * bowScale, connection.type === "tied_parameter" ? 9 : 3.2)
    * (0.65 + random() * 0.7);
  const offset = scaleVector(bowDirection, bow);
  const c1 = add(lerp(from, to, 0.33), offset);
  const c2 = add(lerp(from, to, 0.66), scaleVector(offset, 0.72));
  const segments = Math.max(4, Math.min(18, Math.round(distance / 2.8)));
  const points = [];
  for (let index = 0; index <= segments; index += 1) {
    const t = index / segments;
    const oneMinus = 1 - t;
    points.push([
      oneMinus ** 3 * from[0] + 3 * oneMinus ** 2 * t * c1[0] + 3 * oneMinus * t ** 2 * c2[0] + t ** 3 * to[0],
      oneMinus ** 3 * from[1] + 3 * oneMinus ** 2 * t * c1[1] + 3 * oneMinus * t ** 2 * c2[1] + t ** 3 * to[1],
      oneMinus ** 3 * from[2] + 3 * oneMinus ** 2 * t * c1[2] + 3 * oneMinus * t ** 2 * c2[2] + t ** 3 * to[2],
    ]);
  }
  return points;
}

function unitVector(random) {
  const theta = random() * Math.PI * 2;
  const z = random() * 2 - 1;
  const radial = Math.sqrt(Math.max(0, 1 - z * z));
  return [radial * Math.cos(theta), radial * Math.sin(theta), z];
}

function pickColor(random, palette) {
  return palette[Math.floor(random() * palette.length)] ?? palette[0];
}

function buildSynapticWeb({ nodes, regions, baseBounds, config, seed, layerCount }) {
  const regionCount = regions.length;
  const budget = Math.max(
    960,
    Math.min(config.maxSynapticNodes, Math.round(regionCount * 122 + 760)),
  );
  const random = seededRandom(seed ^ 0x51a1f00d);
  const regionShare = Math.floor(budget * 0.6);
  const bridgeShare = Math.floor(budget * 0.25);
  const fieldShare = Math.max(0, budget - regionShare - bridgeShare);
  const sizeGrowth = 1 + Math.min(0.22, Math.max(0, layerCount - 8) * 0.006);
  const clusterRadius = config.clusterScale * (layerCount <= 10 ? 6.0 : layerCount > 20 ? 4.9 : 5.4);
  const synapticNodes = [];
  const regionPools = regions.map(() => []);

  let assigned = 0;
  for (let regionIndex = 0; regionIndex < regionCount; regionIndex += 1) {
    const region = regions[regionIndex];
    const count = regionIndex === regionCount - 1
      ? Math.max(0, regionShare - assigned)
      : Math.floor(regionShare / Math.max(1, regionCount));
    assigned += count;
    for (let index = 0; index < count; index += 1) {
      const spread = clusterRadius * (0.35 + random() ** 0.62 * 1.7);
      const direction = unitVector(random);
      const curl = (random() - 0.5) * clusterRadius * 0.55;
      const position = add(
        add(region.position, scaleVector(region.side, direction[0] * spread * 0.85 + curl * 0.35)),
        add(
          scaleVector(region.normal, direction[1] * spread * 0.64),
          scaleVector(region.tangent, direction[2] * spread * 1.08 + curl),
        ),
      );
      const node = {
        id: `synapse.${region.blockIndex ?? regionIndex}.${index}`,
        kind: "illustrative",
        role: "synapse",
        regionId: region.id,
        regionIndex,
        position,
        scale: (0.09 + random() ** 2 * 0.24) * sizeGrowth,
        color: pickColor(random, SYNAPTIC_COLORS),
      };
      synapticNodes.push(node);
      regionPools[regionIndex].push(node);
    }
  }

  // Bridge points inhabit the gaps between regions. They keep the composition
  // continuous without inventing a second, denser architectural layer.
  for (let index = 0; index < bridgeShare; index += 1) {
    const regionIndex = regionCount > 1
      ? Math.min(regionCount - 2, Math.floor(random() * (regionCount - 1)))
      : 0;
    const first = regions[regionIndex];
    const second = regions[regionIndex + 1] ?? first;
    const base = first && second ? lerp(first.position, second.position, 0.16 + random() * 0.68) : [0, 0, 0];
    const spread = clusterRadius * (0.14 + random() * 0.52);
    const direction = unitVector(random);
    const basis = first ?? {
      side: [1, 0, 0],
      normal: [0, 1, 0],
      tangent: [0, 0, 1],
    };
    const position = add(
      add(base, scaleVector(basis.side, direction[0] * spread)),
      add(
        scaleVector(basis.normal, direction[1] * spread * 0.8),
        scaleVector(basis.tangent, direction[2] * spread * 1.8),
      ),
    );
    const node = {
      id: `synapse.bridge.${index}`,
      kind: "illustrative",
      role: "bridge",
      regionId: first?.id ?? null,
      regionIndex,
      position,
      scale: (0.08 + random() ** 2 * 0.2) * sizeGrowth,
      color: pickColor(random, SYNAPTIC_COLORS),
    };
    synapticNodes.push(node);
    if (regionPools[regionIndex]) regionPools[regionIndex].push(node);
  }

  const center = baseBounds.center;
  const fieldRadius = Math.max(baseBounds.radius, 1);
  const fieldNodes = [];
  const shellClusterCount = Math.max(12, Math.min(36, 12 + Math.floor(regionCount * 0.8)));
  const coreClusterCount = Math.max(6, Math.min(14, 6 + Math.floor(regionCount * 0.3)));
  const fieldClusters = [];

  for (let index = 0; index < shellClusterCount; index += 1) {
    const regionIndex = regionCount ? Math.floor(random() * regionCount) : null;
    const region = regionIndex != null ? regions[regionIndex] : null;
    const direction = unitVector(random);
    // Most satellite clusters sit just outside a region; every fifth cluster is
    // allowed to drift further out to create a background layer. They still
    // orbit the same shell, so the web reads as one volume rather than islands.
    const outer = index % 5 === 0;
    const reach = clusterRadius * (outer ? 2.4 + random() * 1.7 : 0.9 + random() * 1.7);
    const offset = region
      ? add(
        scaleVector(region.side, direction[0] * reach),
        add(
          scaleVector(region.normal, direction[1] * reach * 0.75),
          scaleVector(region.tangent, direction[2] * reach * 0.95),
        ),
      )
      : scaleVector(direction, fieldRadius * 0.7);
    fieldClusters.push({
      kind: "shell",
      nodes: [],
      regionIndex,
      center: add(region?.position ?? center, offset),
      connect: !outer || random() < 0.55,
    });
  }

  for (let index = 0; index < coreClusterCount; index += 1) {
    const direction = unitVector(random);
    const distance = fieldRadius * (0.12 + random() * 0.5);
    const clusterCenter = add(center, scaleVector(direction, distance));
    let nearestRegion = null;
    let nearestDistance = Infinity;
    for (let regionIndex = 0; regionIndex < regionCount; regionIndex += 1) {
      const regionDistance = length(sub(clusterCenter, regions[regionIndex].position));
      if (regionDistance < nearestDistance) {
        nearestDistance = regionDistance;
        nearestRegion = regionIndex;
      }
    }
    fieldClusters.push({
      kind: "core",
      nodes: [],
      regionIndex: nearestRegion,
      center: clusterCenter,
      connect: regionCount > 0 && random() < 0.4,
    });
  }

  const basePerCluster = Math.floor(fieldShare / Math.max(1, fieldClusters.length));
  let clusterRemainder = fieldShare - basePerCluster * fieldClusters.length;
  for (let clusterIndex = 0; clusterIndex < fieldClusters.length; clusterIndex += 1) {
    const cluster = fieldClusters[clusterIndex];
    const count = basePerCluster + (clusterRemainder > 0 ? 1 : 0);
    if (clusterRemainder > 0) clusterRemainder -= 1;
    for (let index = 0; index < count; index += 1) {
      const direction = unitVector(random);
      const spread = clusterRadius * (cluster.kind === "core" ? 0.1 + random() * 0.28 : 0.14 + random() * 0.34);
      const position = add(cluster.center, scaleVector(direction, spread));
      const node = {
        id: `synapse.field.${fieldNodes.length}`,
        kind: "illustrative",
        role: cluster.kind === "core" ? "core" : "field",
        fieldLayer: cluster.kind,
        regionId: cluster.regionIndex != null ? regions[cluster.regionIndex]?.id ?? null : null,
        regionIndex: cluster.regionIndex,
        fieldCluster: clusterIndex,
        position,
        scale: (cluster.kind === "core" ? 0.045 + random() ** 2 * 0.12 : 0.06 + random() ** 2 * 0.16) * sizeGrowth,
        color: pickColor(random, SYNAPTIC_COLORS),
      };
      synapticNodes.push(node);
      fieldNodes.push(node);
      cluster.nodes.push(node);
    }
  }

  const structuralByRegion = regions.map(() => []);
  for (const node of nodes) {
    if (!Number.isInteger(node.blockIndex)) continue;
    const regionIndex = regions.findIndex((region) => region.blockIndex === node.blockIndex);
    if (regionIndex >= 0) structuralByRegion[regionIndex].push(node);
  }

  const filamentBudget = Math.max(
    420,
    Math.min(config.maxFilaments, Math.round(synapticNodes.length * 0.84)),
  );
  const fieldFilamentBudget = Math.min(320, Math.floor(filamentBudget * 0.2));
  const primaryFilamentBudget = Math.max(1, filamentBudget - fieldFilamentBudget);
  const filaments = [];
  const rootFallback = (regionIndex) => (
    structuralByRegion[regionIndex]?.[0]?.position
    ?? regions[regionIndex]?.position
    ?? baseBounds.center
  );

  let guard = 0;
  while (filaments.length < primaryFilamentBudget && guard < primaryFilamentBudget * 4 && regionCount > 0) {
    guard += 1;
    const regionIndex = Math.floor(random() * regionCount);
    const region = regions[regionIndex];
    const pool = regionPools[regionIndex];
    if (!pool?.length) continue;
    const roots = structuralByRegion[regionIndex];
    const root = roots?.length
      ? roots[Math.floor(random() * roots.length)]
      : null;
    const start = root?.position ?? region.position;
    const crossRegion = random() < 0.12 && regionIndex < regionCount - 1;
    const targetRegionIndex = crossRegion ? regionIndex + 1 : regionIndex;
    const targetPool = regionPools[targetRegionIndex] ?? pool;
    const targetNode = targetPool[Math.floor(random() * targetPool.length)];
    const target = targetNode?.position ?? rootFallback(targetRegionIndex);
    if (length(sub(target, start)) < 0.7) continue;
    const separation = length(sub(target, start));
    const direction = perpendicularTo(sub(target, start), hashString(`filament.${regionIndex}.${filaments.length}`));
    const bow = scaleVector(direction, Math.min(4.5, separation * 0.22) * (0.55 + random() * 0.9) * (crossRegion ? 1.35 : 1));
    const controlA = add(lerp(start, target, 0.32), bow);
    const controlB = add(lerp(start, target, 0.68), scaleVector(bow, 0.55));
    const points = [];
    const segments = 5 + Math.floor(random() * 3);
    for (let step = 0; step <= segments; step += 1) {
      const t = step / segments;
      const inverse = 1 - t;
      points.push([
        inverse ** 3 * start[0] + 3 * inverse ** 2 * t * controlA[0] + 3 * inverse * t ** 2 * controlB[0] + t ** 3 * target[0],
        inverse ** 3 * start[1] + 3 * inverse ** 2 * t * controlA[1] + 3 * inverse * t ** 2 * controlB[1] + t ** 3 * target[1],
        inverse ** 3 * start[2] + 3 * inverse ** 2 * t * controlA[2] + 3 * inverse * t ** 2 * controlB[2] + t ** 3 * target[2],
      ]);
    }
    const color = pickColor(random, FILAMENT_COLORS);
    filaments.push({
      id: `filament.${filaments.length}`,
      kind: "illustrative",
      role: crossRegion ? "bridge-branch" : "branch",
      regionId: region.id,
      regionIndex,
      points,
      color,
      intensity: 0.52 + random() * 0.4,
    });

    if (filaments.length < primaryFilamentBudget && random() < 0.55) {
      const branchStart = points[Math.min(points.length - 1, 2 + Math.floor(random() * 2))];
      const branchNode = pool[Math.floor(random() * pool.length)];
      if (branchNode && length(sub(branchNode.position, branchStart)) > 0.6) {
        const branchDirection = perpendicularTo(sub(branchNode.position, branchStart), hashString(`branch.${filaments.length}`));
        const branchSeparation = length(sub(branchNode.position, branchStart));
        const branchBow = scaleVector(branchDirection, Math.min(2.6, branchSeparation * 0.28) * (0.5 + random() * 0.8));
        const branchTarget = branchNode.position;
        const branchPoints = [];
        const branchSegments = 4 + Math.floor(random() * 2);
        for (let step = 0; step <= branchSegments; step += 1) {
          const t = step / branchSegments;
          const inverse = 1 - t;
          const control = add(lerp(branchStart, branchTarget, 0.5), branchBow);
          branchPoints.push([
            inverse ** 2 * branchStart[0] + 2 * inverse * t * control[0] + t ** 2 * branchTarget[0],
            inverse ** 2 * branchStart[1] + 2 * inverse * t * control[1] + t ** 2 * branchTarget[1],
            inverse ** 2 * branchStart[2] + 2 * inverse * t * control[2] + t ** 2 * branchTarget[2],
          ]);
        }
        filaments.push({
          id: `filament.${filaments.length}`,
          kind: "illustrative",
          role: "sub-branch",
          regionId: region.id,
          regionIndex,
          points: branchPoints,
          color,
          intensity: 0.4 + random() * 0.34,
        });
      }
    }
  }

  // Background field filaments connect nearby far-field synapses. They are
  // short, curved and local to the field, so the visual density expands into
  // depth without drawing long arbitrary edges across the architecture.
  let fieldGuard = 0;
  while (filaments.length < filamentBudget && fieldNodes.length > 3 && fieldGuard < fieldFilamentBudget * 8) {
    fieldGuard += 1;
    const cluster = fieldClusters[Math.floor(random() * fieldClusters.length)];
    if (cluster.nodes.length < 2) continue;
    const startNode = cluster.nodes[Math.floor(random() * cluster.nodes.length)];
    const regionPool = cluster.regionIndex != null ? regionPools[cluster.regionIndex] : null;
    const bridgeToRegion = cluster.connect && regionPool?.length && random() < 0.34;
    let best = null;
    let bestDistance = Infinity;
    if (bridgeToRegion) {
      best = regionPool[Math.floor(random() * regionPool.length)];
      bestDistance = length(sub(best.position, startNode.position));
    } else {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const candidate = cluster.nodes[Math.floor(random() * cluster.nodes.length)];
        if (!candidate || candidate === startNode) continue;
        const distance = length(sub(candidate.position, startNode.position));
        if (distance > 0.35 && distance < bestDistance) {
          best = candidate;
          bestDistance = distance;
        }
      }
    }
    if (!best) continue;
    const start = startNode.position;
    const target = best.position;
    const direction = perpendicularTo(sub(target, start), hashString(`field.${startNode.id}.${best.id}`));
    const bow = scaleVector(direction, Math.min(3.4, bestDistance * 0.3) * (0.5 + random() * 0.8));
    const controlA = add(lerp(start, target, 0.34), bow);
    const controlB = add(lerp(start, target, 0.66), scaleVector(bow, 0.62));
    const points = [];
    const segments = 4 + Math.floor(random() * 3);
    for (let step = 0; step <= segments; step += 1) {
      const t = step / segments;
      const inverse = 1 - t;
      points.push([
        inverse ** 3 * start[0] + 3 * inverse ** 2 * t * controlA[0] + 3 * inverse * t ** 2 * controlB[0] + t ** 3 * target[0],
        inverse ** 3 * start[1] + 3 * inverse ** 2 * t * controlA[1] + 3 * inverse * t ** 2 * controlB[1] + t ** 3 * target[1],
        inverse ** 3 * start[2] + 3 * inverse ** 2 * t * controlA[2] + 3 * inverse * t ** 2 * controlB[2] + t ** 3 * target[2],
      ]);
    }
    filaments.push({
      id: `filament.${filaments.length}`,
      kind: "illustrative",
      role: bridgeToRegion ? "field-bridge" : "field-web",
      regionId: cluster.regionIndex != null ? regions[cluster.regionIndex]?.id ?? null : null,
      regionIndex: cluster.regionIndex,
      points,
      color: pickColor(random, FILAMENT_COLORS),
      intensity: bridgeToRegion ? 0.34 + random() * 0.32 : 0.3 + random() * 0.4,
    });
  }

  return { nodes: synapticNodes, filaments };
}

// Deep-space decoration. Stars, nebula centres and far cosmic wisps form three
// depth layers around the brain. They are deterministic, budgeted and carry no
// architectural ids, so density can grow without silently adding model detail.
function buildAmbientField({ baseBounds, config, seed, layerCount }) {
  const random = seededRandom(seed ^ 0x0a3f19c7);
  const center = baseBounds.center;
  const radius = Math.max(baseBounds.radius, 1);
  const starCount = Math.max(
    1400,
    Math.min(config.maxAmbientStars, Math.round(3200 + layerCount * 50)),
  );
  const positions = new Float32Array(starCount * 3);
  const colors = new Float32Array(starCount * 3);
  const sizes = new Float32Array(starCount);
  const phases = new Float32Array(starCount);

  for (let index = 0; index < starCount; index += 1) {
    const direction = unitVector(random);
    // A slightly flattened shell gives the surrounding universe a galactic
    // plane rather than a perfectly uniform bubble of noise.
    const distance = radius * (1.28 + random() ** 0.72 * 4.9);
    positions[index * 3] = center[0] + direction[0] * distance;
    positions[index * 3 + 1] = center[1] + direction[1] * distance * 0.82;
    positions[index * 3 + 2] = center[2] + direction[2] * distance;
    const rgb = hexToRgb(pickColor(random, AMBIENT_STAR_COLORS));
    const brightness = 0.28 + random() ** 1.4 * 0.72;
    colors[index * 3] = rgb[0] * brightness;
    colors[index * 3 + 1] = rgb[1] * brightness;
    colors[index * 3 + 2] = rgb[2] * brightness;
    sizes[index] = 0.4 + random() ** 2.6 * 1.7;
    phases[index] = random();
  }

  const cloudCount = Math.min(
    config.maxAmbientClusters,
    Math.max(10, Math.round(10 + layerCount * 0.5)),
  );
  const clouds = [];
  for (let index = 0; index < cloudCount; index += 1) {
    const direction = unitVector(random);
    const distance = radius * (1.65 + random() * 2.9);
    const position = [
      center[0] + direction[0] * distance,
      center[1] + direction[1] * distance * 0.74,
      center[2] + direction[2] * distance,
    ];
    clouds.push({
      id: `ambient.cloud.${index}`,
      kind: "ambient",
      position,
      size: radius * (0.5 + random() * 1.25),
      color: pickColor(random, NEBULA_COLORS),
      opacity: 0.055 + random() * 0.105,
      phase: random() * Math.PI * 2,
      drift: [(random() - 0.5) * 0.55, (random() - 0.5) * 0.34, (random() - 0.5) * 0.55],
    });
  }

  const wispCount = Math.min(
    config.maxAmbientWisps,
    Math.max(56, Math.round(56 + layerCount * 1.5)),
  );
  const wisps = [];
  let wispGuard = 0;
  while (wisps.length < wispCount && wispGuard < wispCount * 24) {
    wispGuard += 1;
    const firstDirection = unitVector(random);
    const secondDirection = unitVector(random);
    const firstDistance = radius * (1.5 + random() * 2.7);
    const secondDistance = radius * (1.5 + random() * 2.8);
    const start = [
      center[0] + firstDirection[0] * firstDistance,
      center[1] + firstDirection[1] * firstDistance * 0.78,
      center[2] + firstDirection[2] * firstDistance,
    ];
    const target = [
      center[0] + secondDirection[0] * secondDistance,
      center[1] + secondDirection[1] * secondDistance * 0.78,
      center[2] + secondDirection[2] * secondDistance,
    ];
    const separation = length(sub(target, start));
    if (separation < radius * 0.3) continue;
    const index = wisps.length;
    const direction = perpendicularTo(sub(target, start), hashString(`ambient.wisp.${index}`));
    const bow = scaleVector(direction, separation * (0.08 + random() * 0.16));
    const controlA = add(lerp(start, target, 0.33), bow);
    const controlB = add(lerp(start, target, 0.67), scaleVector(bow, 0.7));
    const points = [];
    const segments = 6 + Math.floor(random() * 4);
    for (let step = 0; step <= segments; step += 1) {
      const t = step / segments;
      const inverse = 1 - t;
      points.push([
        inverse ** 3 * start[0] + 3 * inverse ** 2 * t * controlA[0] + 3 * inverse * t ** 2 * controlB[0] + t ** 3 * target[0],
        inverse ** 3 * start[1] + 3 * inverse ** 2 * t * controlA[1] + 3 * inverse * t ** 2 * controlB[1] + t ** 3 * target[1],
        inverse ** 3 * start[2] + 3 * inverse ** 2 * t * controlA[2] + 3 * inverse * t ** 2 * controlB[2] + t ** 3 * target[2],
      ]);
    }
    wisps.push({
      id: `ambient.wisp.${index}`,
      kind: "ambient",
      points,
      color: pickColor(random, index % 7 === 0 ? NEBULA_COLORS : AMBIENT_STAR_COLORS),
      intensity: 0.12 + random() * 0.22,
    });
  }

  return {
    stars: { count: starCount, positions, colors, sizes, phases },
    clouds,
    wisps,
  };
}

// Speculative, attention-inspired arcs. They deliberately connect distant
// regions without claiming to be measured attention. The ids and kind make the
// distinction explicit, and they never enter the structural graph.
function buildAttentionArcs({ regions, baseBounds, config, seed }) {
  const regionCount = regions.length;
  if (regionCount < 2) return [];
  const random = seededRandom(seed ^ 0x5eeda77e);
  const arcCount = Math.min(config.maxAttentionArcs, Math.max(6, regionCount * 2));
  const center = baseBounds.center;
  const radius = Math.max(baseBounds.radius, 1);
  const arcs = [];
  const used = new Set();
  let guard = 0;
  while (arcs.length < arcCount && guard < arcCount * 12) {
    guard += 1;
    const firstIndex = Math.floor(random() * regionCount);
    const gap = 2 + Math.floor(random() * Math.max(1, regionCount - 3));
    const secondIndex = (firstIndex + gap) % regionCount;
    if (firstIndex === secondIndex) continue;
    const pair = [firstIndex, secondIndex].sort((a, b) => a - b).join(":");
    if (used.has(pair)) continue;
    used.add(pair);
    const first = regions[firstIndex];
    const second = regions[secondIndex];
    const start = first.position;
    const target = second.position;
    const separation = length(sub(target, start));
    if (separation < 1e-3) continue;
    const middle = lerp(start, target, 0.5);
    const outwardRaw = sub(middle, center);
    const outward = length(outwardRaw) > 1e-4 ? normalize(outwardRaw) : unitVector(random);
    const perpendicular = perpendicularTo(sub(target, start), hashString(`attention.${pair}`));
    const bowDirection = normalize(add(outward, scaleVector(perpendicular, (random() - 0.5) * 1.6)));
    const bow = radius * (0.12 + random() * 0.2);
    const controlA = add(lerp(start, target, 0.28), scaleVector(bowDirection, bow * (0.7 + random() * 0.7)));
    const controlB = add(lerp(start, target, 0.72), scaleVector(bowDirection, bow * (0.5 + random() * 0.7)));
    const points = [];
    const segments = 20;
    for (let step = 0; step <= segments; step += 1) {
      const t = step / segments;
      const inverse = 1 - t;
      points.push([
        inverse ** 3 * start[0] + 3 * inverse ** 2 * t * controlA[0] + 3 * inverse * t ** 2 * controlB[0] + t ** 3 * target[0],
        inverse ** 3 * start[1] + 3 * inverse ** 2 * t * controlA[1] + 3 * inverse * t ** 2 * controlB[1] + t ** 3 * target[1],
        inverse ** 3 * start[2] + 3 * inverse ** 2 * t * controlA[2] + 3 * inverse * t ** 2 * controlB[2] + t ** 3 * target[2],
      ]);
    }
    arcs.push({
      id: `attention.${arcs.length}`,
      kind: "speculative",
      fromRegionId: first.id,
      toRegionId: second.id,
      fromBlockIndex: first.blockIndex,
      toBlockIndex: second.blockIndex,
      points,
      color: pickColor(random, ATTENTION_COLORS),
      intensity: 0.22 + random() * 0.28,
      phase: random(),
      speed: 0.085 + random() * 0.12,
    });
  }
  return arcs;
}

function boundsOver(points, extraRadius = 0) {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point[0] - extraRadius);
    minY = Math.min(minY, point[1] - extraRadius);
    minZ = Math.min(minZ, point[2] - extraRadius);
    maxX = Math.max(maxX, point[0] + extraRadius);
    maxY = Math.max(maxY, point[1] + extraRadius);
    maxZ = Math.max(maxZ, point[2] + extraRadius);
  }
  if (!Number.isFinite(minX)) return null;
  const center = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ], center };
}

function radiusFromBounds(bounds, points, extraRadius = 0) {
  let radius = 0;
  for (const point of points) {
    const dx = point[0] - bounds.center[0];
    const dy = point[1] - bounds.center[1];
    const dz = point[2] - bounds.center[2];
    radius = Math.max(radius, Math.hypot(dx, dy, dz) + extraRadius);
  }
  return radius;
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

  const spine = regionSpine(layerCount, config);
  const bases = spine.positions.map((_, index) => basisAt(spine.positions, index));
  const clusterRadius = config.clusterScale * (layerCount <= 10 ? 6.0 : layerCount > 20 ? 4.9 : 5.4);
  const blocksByIndex = new Map(blocks.map((block) => [block.blockIndex, block]));
  const componentsByBlock = new Map();
  for (const block of blocks) componentsByBlock.set(block.blockIndex, []);
  for (const component of components) {
    if (Number.isInteger(component.blockIndex) && componentsByBlock.has(component.blockIndex)) {
      componentsByBlock.get(component.blockIndex).push(component);
    }
  }

  const positions = new Map();
  const regions = blocks.map((block, index) => {
    const position = spine.positions[index] ?? [0, 0, 0];
    const basis = bases[index] ?? {
      tangent: [1, 0, 0],
      side: [0, 0, 1],
      normal: [0, 1, 0],
    };
    const record = {
      id: block.id,
      kind: "architecture",
      blockIndex: block.blockIndex,
      position,
      radius: clusterRadius * 1.55,
      size: [clusterRadius * 3.1, clusterRadius * 3.1, clusterRadius * 3.1],
      color: regionTint(index, blocks.length),
      tangent: basis.tangent,
      side: basis.side,
      normal: basis.normal,
    };
    positions.set(block.id, position);
    return record;
  });
  const blockRegion = new Map(regions.map((region) => [region.blockIndex, region]));

  const start = spine.positions[0] ?? [0, 0, 0];
  const end = spine.positions[spine.positions.length - 1] ?? start;
  const startBasis = bases[0] ?? { tangent: [1, 0, 0], side: [0, 0, 1], normal: [0, 1, 0] };
  const endBasis = bases[bases.length - 1] ?? startBasis;

  const nodes = [];
  for (const component of components) {
    if (component.id === "model") continue;
    if (component.type === "transformer_block") continue;
    const region = regionOf(component, blockRegion);
    let position;
    let regionIndex = null;
    if (region) {
      const siblings = componentsByBlock.get(component.blockIndex) ?? [];
      regionIndex = regions.indexOf(region);
      const randomForId = seededRandom(hashString(component.id ?? ""));
      const offset = localOffset(component, siblings.indexOf(component), randomForId);
      const jitter = [
        (randomForId() - 0.5) * 0.42,
        (randomForId() - 0.5) * 0.42,
        (randomForId() - 0.5) * 0.42,
      ];
      position = add(
        add(region.position, scaleVector(region.side, (offset[0] + jitter[0]) * clusterRadius)),
        add(
          scaleVector(region.normal, (offset[1] + jitter[1]) * clusterRadius),
          scaleVector(region.tangent, (offset[2] + jitter[2]) * clusterRadius),
        ),
      );
    } else {
      const seed = hashString(component.id ?? "");
      position = globalPosition(component, start, end, startBasis, endBasis, config, seed);
    }
    const x = Number.isFinite(position[0]) ? position[0] : 0;
    const y = Number.isFinite(position[1]) ? position[1] : 0;
    const z = Number.isFinite(position[2]) ? position[2] : 0;
    const point = [x, y, z];
    positions.set(component.id, point);
    const nodeScale = componentScale(component, layerCount);
    nodes.push({
      id: component.id,
      componentId: component.id,
      name: component.name,
      type: component.type,
      parentId: component.parentId ?? null,
      blockIndex: component.blockIndex ?? null,
      regionId: region?.id ?? null,
      regionIndex,
      derived: component.derived === true,
      kind: "architecture",
      position: point,
      scale: nodeScale,
      scale3: [nodeScale, nodeScale, nodeScale],
      color: COMPONENT_COLORS[component.type] ?? COMPONENT_COLORS.buffer,
      group: GROUP[component.type] ?? "sphere",
      materialClass: materialClassFor(component),
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
  const edges = [];
  const allEdges = [];
  for (const connection of connections) {
    const [from, to] = [connection.from, connection.to];
    if (!visibleNodeIds.has(from) || !visibleNodeIds.has(to)) continue;
    const fromPosition = positions.get(from);
    const toPosition = positions.get(to);
    if (!fromPosition || !toPosition) continue;
    const edge = {
      id: connection.id,
      kind: "architecture",
      from,
      to,
      type: connection.type,
      explicit: connection.explicit !== false,
      inferred: connection.inferred === true,
      color: CONNECTION_COLORS[connection.type] ?? CONNECTION_COLORS.dataflow,
      overview: connection.type !== "positional_encoding" && connection.type !== "tied_parameter",
      points: curveBetween(fromPosition, toPosition, connection),
    };
    allEdges.push(edge);
  }
  const edgeStride = allEdges.length > config.maxEdges
    ? Math.ceil(allEdges.length / config.maxEdges)
    : 1;
  for (let index = 0; index < allEdges.length; index += edgeStride) {
    if (edges.length >= config.maxEdges) break;
    edges.push(allEdges[index]);
  }
  if (edges.length !== allEdges.length) {
    warnings.push(`render plan shows ${edges.length} of ${allEdges.length} connections`);
  }

  const structuralPoints = [
    ...limitedNodes.map((node) => node.position),
    ...regions.map((region) => region.position),
  ];
  const baseBounds = boundsOver(structuralPoints, 0)
    ?? { min: [-1, -1, -1], max: [1, 1, 1], center: [0, 0, 0] };
  const baseRadius = Math.max(
    radiusFromBounds(baseBounds, structuralPoints),
    clusterRadius * 2,
  );
  baseBounds.radius = baseRadius;

  const seed = hashString([
    blueprint?.source?.activeVersion ?? "blueprint",
    blueprint?.model?.version ?? "",
    layerCount,
    limitedNodes.length,
    edges.length,
  ].join("|"));
  const synaptic = buildSynapticWeb({
    nodes: limitedNodes,
    regions,
    baseBounds,
    config,
    seed,
    layerCount,
  });
  const ambient = buildAmbientField({
    baseBounds,
    config,
    seed,
    layerCount,
  });
  const attention = buildAttentionArcs({
    regions,
    baseBounds,
    config,
    seed,
  });

  // Camera framing follows the architecture and the near-field web. The
  // far-field synaptic clusters, deep-space field and speculative arcs are
  // atmosphere; they may drift beyond the frame just as ambient dust does, but
  // they never pull the camera off the model.
  const framingPoints = [
    ...structuralPoints,
    ...synaptic.nodes.filter((node) => node.role !== "field").map((node) => node.position),
    ...synaptic.filaments
      .filter((filament) => filament.role !== "field-web")
      .flatMap((filament) => filament.points),
  ];
  const bounds = boundsOver(framingPoints, clusterRadius * 0.7)
    ?? { min: [-1, -1, -1], max: [1, 1, 1], center: [0, 0, 0] };
  let radius = radiusFromBounds(bounds, framingPoints);
  radius = Math.max(radius, 1) + Math.max(2.5, radius * 0.035);
  bounds.radius = radius;

  return {
    nodes: limitedNodes,
    edges,
    regions,
    // `blocks` is retained as the region-record alias used by older callers and
    // diagnostics. No rectangular enclosure is rendered from it any more.
    blocks: regions,
    synaptic,
    ambient,
    attention,
    bounds,
    counts: {
      nodes: limitedNodes.length,
      edges: edges.length,
      totalNodes: nodes.length,
      totalEdges: allEdges.length,
      layers: layerCount,
      regions: regions.length,
      synapticNodes: synaptic.nodes.length,
      filaments: synaptic.filaments.length,
      illustrativeNodes: synaptic.nodes.length,
      illustrativeFilaments: synaptic.filaments.length,
      attentionArcs: attention.length,
      ambientStars: ambient.stars.count,
      ambientClusters: ambient.clouds.length,
      ambientWisps: ambient.wisps.length,
      decorativeObjects: synaptic.nodes.length
        + synaptic.filaments.length
        + attention.length
        + ambient.stars.count
        + ambient.clouds.length
        + ambient.wisps.length,
    },
    warnings,
  };
}
