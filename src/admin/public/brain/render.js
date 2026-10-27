import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { highlightFor } from "./schema.js";
import { buildRenderPlan } from "./layout.js";
import { fitCamera } from "./framing.js";
import {
  activityVisualSpec,
  effectiveMotion,
  effectVisibility,
  normalizeEffectSettings,
  telemetryMood,
} from "./cinematic.js";

const MODES = new Set(["brain", "architecture"]);

const GEOMETRY_BUILDERS = {
  sphere: () => new THREE.IcosahedronGeometry(1, 1),
  octa: () => new THREE.OctahedronGeometry(1, 1),
};

/**
 * A tiny procedural equirectangular studio, generated once. It gives the
 * metallic and glass materials a plausible reflection without loading an HDR
 * file or adding a second render pass. The highlights are deliberately cool,
 * violet and cyan so reflections reinforce the existing palette.
 */
function makeEnvironmentTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 512;
  const context = canvas.getContext("2d");

  const base = context.createLinearGradient(0, 0, 0, 512);
  base.addColorStop(0, "#14263c");
  base.addColorStop(0.42, "#0a1523");
  base.addColorStop(0.62, "#060b13");
  base.addColorStop(1, "#020407");
  context.fillStyle = base;
  context.fillRect(0, 0, 1024, 512);

  const glow = (x, y, radius, inner, outer) => {
    const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, inner);
    gradient.addColorStop(0.55, outer);
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 1024, 512);
  };
  glow(742, 132, 340, "rgba(206,229,255,0.95)", "rgba(92,146,224,0.3)");
  glow(176, 258, 310, "rgba(151,124,255,0.6)", "rgba(88,58,180,0.18)");
  glow(286, 418, 230, "rgba(58,205,224,0.22)", "rgba(18,78,110,0.08)");
  glow(930, 300, 180, "rgba(88,120,190,0.24)", "rgba(20,40,80,0.06)");

  const texture = new THREE.CanvasTexture(canvas);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeGlowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.18, "rgba(255,255,255,0.78)");
  gradient.addColorStop(0.48, "rgba(255,255,255,0.2)");
  gradient.addColorStop(0.76, "rgba(255,255,255,0.045)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Soft, deterministic nebula cloud. White-ish blobs tinted by the sprite's
 * colour; no image load and no render pass. Three variants are enough to keep
 * the deep field from looking stamped.
 */
function makeNebulaTexture(seed) {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  const random = seededRandom(seed);
  context.clearRect(0, 0, size, size);
  context.globalCompositeOperation = "lighter";
  for (let index = 0; index < 10; index += 1) {
    const x = size * (0.24 + random() * 0.52);
    const y = size * (0.26 + random() * 0.48);
    const radius = size * (0.16 + random() * 0.34);
    const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
    const alpha = 0.08 + random() * 0.16;
    gradient.addColorStop(0, `rgba(255,255,255,${alpha})`);
    gradient.addColorStop(0.45, `rgba(226,240,255,${alpha * 0.45})`);
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeRingTexture() {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  const gradient = context.createRadialGradient(64, 64, 30, 64, 64, 62);
  gradient.addColorStop(0, "rgba(255,255,255,0)");
  gradient.addColorStop(0.56, "rgba(255,255,255,0)");
  gradient.addColorStop(0.74, "rgba(255,255,255,0.75)");
  gradient.addColorStop(0.84, "rgba(255,255,255,0.36)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeLabelTexture(text, options = {}) {
  const width = options.width ?? 256;
  const height = options.height ?? 96;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, width, height);
  context.font = options.font ?? "600 40px system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = options.color ?? "rgba(210, 236, 255, 0.94)";
  context.shadowColor = options.shadowColor ?? "rgba(56, 189, 248, 0.55)";
  context.shadowBlur = options.shadowBlur ?? 14;
  context.fillText(String(text), width / 2, height / 2 + 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = Math.imul(value ^ (value >>> 15), 1 | value);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function colorToRgb(hex) {
  const color = new THREE.Color(hex);
  return [color.r, color.g, color.b];
}

function randomUnitVector(random) {
  const theta = random() * Math.PI * 2;
  const z = random() * 2 - 1;
  const radial = Math.sqrt(Math.max(0, 1 - z * z));
  return [radial * Math.cos(theta), radial * Math.sin(theta), z];
}

function disposeObject(root, seen = new Set()) {
  root.traverse((object) => {
    if (object.geometry && !seen.has(object.geometry)) {
      seen.add(object.geometry);
      object.geometry.dispose();
    }
    const materials = Array.isArray(object.material)
      ? object.material
      : object.material ? [object.material] : [];
    for (const material of materials) {
      if (seen.has(material)) continue;
      seen.add(material);
      for (const value of Object.values(material)) {
        if (value && value.isTexture && !seen.has(value)) {
          seen.add(value);
          value.dispose();
        }
      }
      material.dispose();
    }
  });
}

function prepareSignalLanes(lanes) {
  const prepared = [];
  for (const lane of lanes) {
    const points = lane?.points;
    if (!Array.isArray(points) || points.length < 2) continue;
    const lengths = new Float32Array(points.length);
    let total = 0;
    for (let index = 1; index < points.length; index += 1) {
      const dx = points[index][0] - points[index - 1][0];
      const dy = points[index][1] - points[index - 1][1];
      const dz = points[index][2] - points[index - 1][2];
      total += Math.hypot(dx, dy, dz);
      lengths[index] = total;
    }
    if (total < 1e-4) continue;
    prepared.push({ lane, points, lengths, total });
  }
  return prepared;
}

function samplePreparedLane(lane, t) {
  const distance = ((t % 1) + 1) % 1 * lane.total;
  let segment = 1;
  while (segment < lane.lengths.length - 1 && lane.lengths[segment] < distance) segment += 1;
  const previous = lane.lengths[segment - 1] ?? 0;
  const span = Math.max(1e-6, lane.lengths[segment] - previous);
  const local = Math.min(1, Math.max(0, (distance - previous) / span));
  const from = lane.points[segment - 1];
  const to = lane.points[segment] ?? from;
  return [
    from[0] + (to[0] - from[0]) * local,
    from[1] + (to[1] - from[1]) * local,
    from[2] + (to[2] - from[2]) * local,
  ];
}

/**
 * A bounded field of luminous motes travelling along prepared polylines. The
 * geometry is allocated once; each frame only writes positions. A pulse is
 * illustrative motion along an illustrative lane, never a measured signal.
 */
function createPulseField(lanes, count, options = {}) {
  const prepared = prepareSignalLanes(lanes);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const state = [];
  if (!prepared.length || count <= 0) {
    return {
      points: null,
      material: null,
      update() {},
      setPaused() {},
    };
  }
  const random = seededRandom(options.seed ?? 0x51a1f00d);
  const minSpeed = options.minSpeed ?? 0.055;
  const maxSpeed = options.maxSpeed ?? 0.16;
  for (let index = 0; index < count; index += 1) {
    const lane = prepared[Math.floor(random() * prepared.length)];
    const rgb = colorToRgb(lane.lane.color ?? "#67e8f9");
    const brightness = 0.72 + random() * 0.55;
    colors[index * 3] = Math.min(1, rgb[0] * brightness);
    colors[index * 3 + 1] = Math.min(1, rgb[1] * brightness);
    colors[index * 3 + 2] = Math.min(1, rgb[2] * brightness);
    state.push({
      lane,
      t: random(),
      speed: lane.lane.speed ?? (minSpeed + random() * (maxSpeed - minSpeed)),
      phase: random() * Math.PI * 2,
    });
    const position = samplePreparedLane(lane, state[index].t);
    positions[index * 3] = position[0];
    positions[index * 3 + 1] = position[1];
    positions[index * 3 + 2] = position[2];
  }
  const geometry = new THREE.BufferGeometry();
  const positionAttribute = new THREE.BufferAttribute(positions, 3);
  positionAttribute.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", positionAttribute);
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({
    size: options.size ?? 0.55,
    map: options.texture,
    transparent: true,
    opacity: options.opacity ?? 0.8,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
    toneMapped: false,
    fog: false,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = options.renderOrder ?? 4;

  let visible = true;
  function update(dt, speedScale = 1, gain = 1) {
    if (!visible) return;
    for (let index = 0; index < state.length; index += 1) {
      const pulse = state[index];
      pulse.t += dt * pulse.speed * speedScale;
      if (pulse.t > 1) pulse.t -= Math.floor(pulse.t);
      const position = samplePreparedLane(pulse.lane, pulse.t);
      positions[index * 3] = position[0];
      positions[index * 3 + 1] = position[1];
      positions[index * 3 + 2] = position[2];
    }
    positionAttribute.needsUpdate = true;
    material.opacity = (options.opacity ?? 0.8) * gain;
    material.size = (options.size ?? 0.55) * (0.85 + 0.3 * Math.min(1.4, gain));
  }

  return {
    points,
    material,
    geometry,
    update,
    setVisible(next) {
      visible = next === true;
      points.visible = visible;
    },
    get visible() {
      return visible;
    },
  };
}

export function createBrainScene(container, blueprint, options = {}) {
  if (!window.WebGLRenderingContext) throw new Error("WebGL is not available in this browser");
  const plan = buildRenderPlan(blueprint, options);
  const initialMode = MODES.has(options.initialMode) ? options.initialMode : "brain";
  let effectSettings = normalizeEffectSettings(options.effects ?? {}, {
    prefersReducedMotion: options.prefersReducedMotion === true,
  });
  let telemetryStatus = options.telemetryStatus ?? "unavailable";
  let telemetryVisual = telemetryMood(telemetryStatus);
  let telemetryEnergy = telemetryVisual.energy;
  let highlightDim = 1;
  const motion = effectiveMotion(effectSettings);
  console.info("[brain] render plan", {
    nodes: plan.counts.nodes,
    edges: plan.counts.edges,
    layers: plan.counts.layers,
    regions: plan.regions.length,
    synapticNodes: plan.counts.synapticNodes,
    filaments: plan.counts.filaments,
    attentionArcs: plan.counts.attentionArcs,
    ambientStars: plan.counts.ambientStars,
    ambientClusters: plan.counts.ambientClusters,
    bounds: plan.bounds,
    warnings: plan.warnings,
  });

  const scene = new THREE.Scene();
  scene.background = null;
  const fogDensity = 0.15 / Math.max(plan.bounds.radius, 1);
  scene.fog = new THREE.FogExp2(0x040711, fogDensity);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 20000);
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  container.appendChild(renderer.domElement);

  const environmentSource = makeEnvironmentTexture();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environmentTarget = pmrem.fromEquirectangular(environmentSource);
  pmrem.dispose();
  environmentSource.dispose();
  scene.environment = environmentTarget.texture;
  scene.environmentIntensity = 0.55;

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.screenSpacePanning = true;
  controls.rotateSpeed = 0.58;
  controls.zoomSpeed = 0.82;
  controls.panSpeed = 0.72;
  controls.minDistance = Math.max(1.5, plan.bounds.radius * 0.05);
  controls.maxDistance = Math.max(100, plan.bounds.radius * 8);
  controls.target.set(...plan.bounds.center);

  const overviewDirection = new THREE.Vector3(0.72, 0.3, 0.95).normalize();
  const overviewPosition = new THREE.Vector3();
  let overviewDistance = plan.bounds.radius * 2.15;
  let userInteracted = false;

  function frameOverview() {
    const brain = mode === "brain";
    const fit = fitCamera(plan.bounds, {
      direction: overviewDirection.toArray(),
      fovDeg: camera.fov,
      aspect: camera.aspect,
      margin: brain ? 0.7 : 0.78,
      depthFactor: brain ? 0.4 : 0.4,
    });
    overviewDistance = fit.distance;
    overviewPosition.set(...fit.position);
    camera.position.copy(overviewPosition);
    camera.near = fit.near;
    camera.far = fit.far;
    camera.updateProjectionMatrix();
    controls.target.set(...fit.center);
    controls.minDistance = Math.max(1, overviewDistance * 0.045);
    controls.maxDistance = Math.max(100, overviewDistance * 6);
    controls.update();
  }

  const ambient = new THREE.HemisphereLight(0xd7ecff, 0x04060b, 1.05);
  scene.add(ambient);
  const key = new THREE.DirectionalLight(0xe4f4ff, 3.1);
  key.position.set(2.6, 3.4, 2.8);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x38bdf8, 1.2);
  fill.position.set(-2.8, 0.8, 1.6);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0x8b5cf6, 1.85);
  rim.position.set(-1.8, 1.5, -3.2);
  scene.add(rim);
  const under = new THREE.DirectionalLight(0x2563eb, 0.65);
  under.position.set(0.8, -2.6, -1.2);
  scene.add(under);
  const innerLight = new THREE.PointLight(0x22d3ee, 140, plan.bounds.radius * 2.6, 2);
  innerLight.position.set(...plan.bounds.center);
  scene.add(innerLight);

  const root = new THREE.Group();
  scene.add(root);
  const glowTexture = makeGlowTexture();
  const ringTexture = makeRingTexture();
  const nebulaTextures = [
    makeNebulaTexture(0x4b1d3a),
    makeNebulaTexture(0x91c0ffee),
    makeNebulaTexture(0x1badb002),
  ];

  // Large, very faint camera-facing glows sit behind the structure. They give
  // the volume an atmospheric gradient without a full-screen post effect.
  const atmosphereGroup = new THREE.Group();
  root.add(atmosphereGroup);
  const atmosphereSpecs = [
    { color: 0x1d4ed8, opacity: 0.06, scale: plan.bounds.radius * 2.8, offset: [0, 0, -plan.bounds.radius * 0.58], phase: 0.2 },
    { color: 0x6d28d9, opacity: 0.045, scale: plan.bounds.radius * 2.25, offset: [-plan.bounds.radius * 0.48, plan.bounds.radius * 0.2, plan.bounds.radius * 0.36], phase: 1.7 },
    { color: 0x0891b2, opacity: 0.052, scale: plan.bounds.radius * 2.0, offset: [plan.bounds.radius * 0.44, -plan.bounds.radius * 0.16, -plan.bounds.radius * 0.26], phase: 3.1 },
    { color: 0x67e8f9, opacity: 0.036, scale: plan.bounds.radius * 1.2, offset: [0, 0, 0], phase: 2.4 },
    { color: 0xbe185d, opacity: 0.026, scale: plan.bounds.radius * 1.7, offset: [plan.bounds.radius * 0.18, plan.bounds.radius * 0.4, plan.bounds.radius * 0.3], phase: 4.6 },
    { color: 0x0f766e, opacity: 0.032, scale: plan.bounds.radius * 1.55, offset: [-plan.bounds.radius * 0.22, -plan.bounds.radius * 0.38, -plan.bounds.radius * 0.24], phase: 5.3 },
  ];
  const atmosphereSprites = [];
  for (const spec of atmosphereSpecs) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture,
      color: spec.color,
      transparent: true,
      opacity: spec.opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
      fog: false,
    }));
    sprite.position.set(
      plan.bounds.center[0] + spec.offset[0],
      plan.bounds.center[1] + spec.offset[1],
      plan.bounds.center[2] + spec.offset[2],
    );
    sprite.scale.set(spec.scale, spec.scale, 1);
    sprite.renderOrder = 0;
    atmosphereGroup.add(sprite);
    atmosphereSprites.push({ sprite, baseOpacity: spec.opacity, phase: spec.phase });
  }

  // ------------------------------------------------------- structural nodes
  // Three deliberate material families establish hierarchy without making every
  // component equally glossy. Weight-bearing/container nodes are glassy or
  // metallic; derived structural nodes stay matte and subdued.
  const structuralMaterials = {
    glass: new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.16,
      metalness: 0.08,
      clearcoat: 1,
      clearcoatRoughness: 0.1,
      sheen: 0.35,
      sheenColor: new THREE.Color(0x7dd3fc),
      sheenRoughness: 0.7,
      emissive: new THREE.Color(0x0b2a44),
      emissiveIntensity: 0.5,
      transparent: true,
      opacity: 0.9,
    }),
    metal: new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.3,
      metalness: 0.5,
      clearcoat: 0.45,
      clearcoatRoughness: 0.28,
      emissive: new THREE.Color(0x071c33),
      emissiveIntensity: 0.48,
      transparent: true,
      opacity: 0.96,
    }),
    matte: new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.72,
      metalness: 0.12,
      emissive: new THREE.Color(0x071625),
      emissiveIntensity: 0.82,
      transparent: true,
      opacity: 0.94,
    }),
  };

  const nodesByVariant = new Map();
  for (const node of plan.nodes) {
    const key = `${node.group}:${node.materialClass ?? "matte"}`;
    if (!nodesByVariant.has(key)) nodesByVariant.set(key, []);
    nodesByVariant.get(key).push(node);
  }

  const dummy = new THREE.Object3D();
  const scratchColor = new THREE.Color();
  const nodeInstances = [];
  const nodeMeshes = [];
  for (const [variant, nodes] of nodesByVariant) {
    const [geometryName, materialClass] = variant.split(":");
    const geometry = (GEOMETRY_BUILDERS[geometryName] ?? GEOMETRY_BUILDERS.sphere)();
    const material = structuralMaterials[materialClass] ?? structuralMaterials.matte;
    const mesh = new THREE.InstancedMesh(geometry, material, nodes.length);
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    mesh.userData.componentIds = nodes.map((node) => node.id);
    mesh.userData.pickKind = "node";
    mesh.userData.geometryName = geometryName;
    mesh.userData.materialClass = materialClass;
    nodes.forEach((node, index) => {
      dummy.position.set(node.position[0], node.position[1], node.position[2]);
      dummy.scale.set(node.scale, node.scale, node.scale);
      const rotationSeed = node.id.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0);
      dummy.rotation.set(rotationSeed * 0.11, rotationSeed * 0.07, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
      const rgb = colorToRgb(node.color);
      mesh.setColorAt(index, scratchColor.setRGB(rgb[0], rgb[1], rgb[2]));
      nodeInstances.push({ node, mesh, index, base: rgb });
    });
    mesh.instanceColor.needsUpdate = true;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.renderOrder = 4;
    root.add(mesh);
    nodeMeshes.push(mesh);
  }

  // --------------------------------------------------- structural edge glow
  const glowPositions = new Float32Array(plan.nodes.length * 3);
  const glowColors = new Float32Array(plan.nodes.length * 3);
  const glowBaseColors = [];
  plan.nodes.forEach((node, index) => {
    glowPositions[index * 3] = node.position[0];
    glowPositions[index * 3 + 1] = node.position[1];
    glowPositions[index * 3 + 2] = node.position[2];
    const rgb = colorToRgb(node.color);
    glowBaseColors.push(rgb);
    glowColors[index * 3] = rgb[0];
    glowColors[index * 3 + 1] = rgb[1];
    glowColors[index * 3 + 2] = rgb[2];
  });
  const glowGeometry = new THREE.BufferGeometry();
  glowGeometry.setAttribute("position", new THREE.BufferAttribute(glowPositions, 3));
  glowGeometry.setAttribute("color", new THREE.BufferAttribute(glowColors, 3));
  const glowMaterial = new THREE.PointsMaterial({
    size: Math.max(0.7, Math.min(2.6, plan.bounds.radius * 0.045)),
    map: glowTexture,
    transparent: true,
    opacity: 0.42,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
    toneMapped: false,
    fog: false,
  });
  const structuralGlow = new THREE.Points(glowGeometry, glowMaterial);
  structuralGlow.renderOrder = 5;
  root.add(structuralGlow);

  // ------------------------------------------------------ structural lines
  const edgePositions = [];
  const edgeColors = [];
  const edgeRanges = [];
  for (const edge of plan.edges) {
    const start = edgePositions.length / 6;
    const rgb = colorToRgb(edge.color);
    for (let index = 0; index < edge.points.length - 1; index += 1) {
      const from = edge.points[index];
      const to = edge.points[index + 1];
      edgePositions.push(from[0], from[1], from[2], to[0], to[1], to[2]);
      edgeColors.push(rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2]);
    }
    edgeRanges.push({
      edge,
      start,
      count: edgePositions.length / 6 - start,
      base: rgb,
    });
  }

  let structuralLineGeometry = null;
  let structuralLineMaterial = null;
  let structuralLines = null;
  if (edgePositions.length) {
    structuralLineGeometry = new LineSegmentsGeometry();
    structuralLineGeometry.setPositions(new Float32Array(edgePositions));
    structuralLineGeometry.setColors(new Float32Array(edgeColors));
    structuralLineMaterial = new LineMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.46,
      linewidth: 1.25,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      worldUnits: false,
      toneMapped: false,
      fog: true,
    });
    structuralLines = new LineSegments2(structuralLineGeometry, structuralLineMaterial);
    structuralLines.renderOrder = 3;
    root.add(structuralLines);
  }

  // ------------------------------------------------------------ region auras
  const regionHaloPositions = new Float32Array(plan.regions.length * 3);
  const regionHaloColors = new Float32Array(plan.regions.length * 3);
  const regionBaseRgb = [];
  plan.regions.forEach((region, index) => {
    regionHaloPositions[index * 3] = region.position[0];
    regionHaloPositions[index * 3 + 1] = region.position[1];
    regionHaloPositions[index * 3 + 2] = region.position[2];
    const rgb = colorToRgb(region.color);
    regionBaseRgb.push(rgb);
    regionHaloColors[index * 3] = rgb[0] * 0.75;
    regionHaloColors[index * 3 + 1] = rgb[1] * 0.75;
    regionHaloColors[index * 3 + 2] = rgb[2] * 0.75;
  });
  const regionHaloGeometry = new THREE.BufferGeometry();
  regionHaloGeometry.setAttribute("position", new THREE.BufferAttribute(regionHaloPositions, 3));
  const regionHaloColorAttribute = new THREE.BufferAttribute(regionHaloColors, 3);
  regionHaloGeometry.setAttribute("color", regionHaloColorAttribute);
  const averageRegionRadius = plan.regions.length
    ? plan.regions.reduce((total, region) => total + region.radius, 0) / plan.regions.length
    : 4;
  const regionHaloMaterial = new THREE.PointsMaterial({
    size: Math.max(5, Math.min(18, averageRegionRadius * 1.65)),
    map: glowTexture,
    transparent: true,
    opacity: 0.17,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
    toneMapped: false,
    fog: false,
  });
  const regionHalo = new THREE.Points(regionHaloGeometry, regionHaloMaterial);
  regionHalo.renderOrder = 1;
  root.add(regionHalo);

  // --------------------------------------------- observed layer activity
  // One batched point per existing layer region. The overlay is deliberately
  // separate from the resting-state region aura and from the illustrative web.
  // It is driven only by measured per-block gradient RMS, never by a global
  // step event.
  const layerActivityPositions = new Float32Array(plan.regions.length * 3);
  const layerActivityColors = new Float32Array(plan.regions.length * 3);
  plan.regions.forEach((region, index) => {
    layerActivityPositions[index * 3] = region.position[0];
    layerActivityPositions[index * 3 + 1] = region.position[1];
    layerActivityPositions[index * 3 + 2] = region.position[2];
  });
  const layerActivityGeometry = new THREE.BufferGeometry();
  layerActivityGeometry.setAttribute("position", new THREE.BufferAttribute(layerActivityPositions, 3));
  layerActivityGeometry.setAttribute("color", new THREE.BufferAttribute(layerActivityColors, 3));
  const layerActivityMaterial = new THREE.PointsMaterial({
    size: Math.max(5, Math.min(22, averageRegionRadius * 2.05)),
    map: glowTexture,
    transparent: true,
    opacity: 0.58,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
    toneMapped: false,
    fog: false,
  });
  const layerActivityPoints = new THREE.Points(layerActivityGeometry, layerActivityMaterial);
  layerActivityPoints.visible = false;
  layerActivityPoints.renderOrder = 2;
  layerActivityPoints.frustumCulled = false;
  root.add(layerActivityPoints);
  let layerActivityEnabled = options.layerActivityEnabled === true;
  let layerActivityData = null;

  const LAYER_ACTIVITY_LOW = new THREE.Color(0x38bdf8);
  const LAYER_ACTIVITY_HIGH = new THREE.Color(0xa78bfa);
  const layerActivityScratch = new THREE.Color();
  const layerActivityColor = new THREE.Color();

  function updateLayerActivityColors() {
    const layers = layerActivityData?.layers ?? [];
    const values = layers
      .map((layer) => layer.rms)
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b);
    if (!values.length) {
      layerActivityPoints.visible = false;
      return;
    }
    const reference = values[Math.min(values.length - 1, Math.floor((values.length - 1) * 0.9))] || values[values.length - 1] || 1;
    const byIndex = new Map(layers.map((layer) => [layer.index, layer]));
    const byId = new Map(layers.map((layer) => [layer.componentId, layer]));
    let any = false;
    for (let index = 0; index < plan.regions.length; index += 1) {
      const region = plan.regions[index];
      const layer = byId.get(region.id) ?? byIndex.get(region.blockIndex);
      const value = layer?.rms;
      if (!Number.isFinite(value)) {
        layerActivityColors[index * 3] = 0;
        layerActivityColors[index * 3 + 1] = 0;
        layerActivityColors[index * 3 + 2] = 0;
        continue;
      }
      any = true;
      const intensity = Math.min(1, Math.sqrt(Math.max(0, value / Math.max(reference, 1e-9))));
      layerActivityColor.copy(LAYER_ACTIVITY_LOW).lerp(LAYER_ACTIVITY_HIGH, intensity);
      const gain = 0.22 + 0.78 * intensity;
      layerActivityScratch.copy(layerActivityColor).multiplyScalar(gain);
      layerActivityColors[index * 3] = layerActivityScratch.r;
      layerActivityColors[index * 3 + 1] = layerActivityScratch.g;
      layerActivityColors[index * 3 + 2] = layerActivityScratch.b;
    }
    layerActivityGeometry.getAttribute("color").needsUpdate = true;
    layerActivityPoints.visible = layerActivityEnabled && mode === "brain" && any;
  }

  function setLayerActivityEnabled(enabled) {
    layerActivityEnabled = enabled === true;
    if (!layerActivityEnabled) layerActivityPoints.visible = false;
    else updateLayerActivityColors();
    return layerActivityEnabled;
  }

  function setLayerActivity(activity) {
    layerActivityData = activity && typeof activity === "object" ? activity : null;
    if (!layerActivityEnabled || !layerActivityData || mode !== "brain") {
      layerActivityPoints.visible = false;
      return;
    }
    updateLayerActivityColors();
  }

  // -------------------------------------------------------- region pickers
  const regionPickMaterial = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
    colorWrite: false,
  });
  const regionPickGeometry = new THREE.IcosahedronGeometry(1, 1);
  const regionPickMesh = new THREE.InstancedMesh(
    regionPickGeometry,
    regionPickMaterial,
    Math.max(1, plan.regions.length),
  );
  regionPickMesh.userData.componentIds = plan.regions.map((region) => region.id);
  regionPickMesh.userData.pickKind = "region";
  plan.regions.forEach((region, index) => {
    dummy.position.set(region.position[0], region.position[1], region.position[2]);
    dummy.scale.set(region.radius, region.radius, region.radius);
    dummy.rotation.set(0, 0, 0);
    dummy.updateMatrix();
    regionPickMesh.setMatrixAt(index, dummy.matrix);
  });
  regionPickMesh.instanceMatrix.needsUpdate = true;
  regionPickMesh.renderOrder = -1;
  root.add(regionPickMesh);

  // -------------------------------------------- architecture-only annotation
  const architectureGroup = new THREE.Group();
  architectureGroup.visible = false;
  root.add(architectureGroup);
  const labelTextures = [];
  let regionRingMaterial = null;
  let regionRings = null;

  if (plan.regions.length) {
    const ringPositions = [];
    const ringColors = [];
    const ringSegments = 56;
    for (const region of plan.regions) {
      const rgb = colorToRgb(region.color);
      const radius = region.radius * 0.9;
      for (let index = 0; index < ringSegments; index += 1) {
        const a = (index / ringSegments) * Math.PI * 2;
        const b = ((index + 1) / ringSegments) * Math.PI * 2;
        const first = [
          region.position[0] + region.side[0] * Math.cos(a) * radius + region.normal[0] * Math.sin(a) * radius,
          region.position[1] + region.side[1] * Math.cos(a) * radius + region.normal[1] * Math.sin(a) * radius,
          region.position[2] + region.side[2] * Math.cos(a) * radius + region.normal[2] * Math.sin(a) * radius,
        ];
        const second = [
          region.position[0] + region.side[0] * Math.cos(b) * radius + region.normal[0] * Math.sin(b) * radius,
          region.position[1] + region.side[1] * Math.cos(b) * radius + region.normal[1] * Math.sin(b) * radius,
          region.position[2] + region.side[2] * Math.cos(b) * radius + region.normal[2] * Math.sin(b) * radius,
        ];
        ringPositions.push(...first, ...second);
        ringColors.push(rgb[0] * 0.7, rgb[1] * 0.7, rgb[2] * 0.7, rgb[0] * 0.7, rgb[1] * 0.7, rgb[2] * 0.7);
      }
    }
    const ringGeometry = new THREE.BufferGeometry();
    ringGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(ringPositions), 3));
    ringGeometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(ringColors), 3));
    regionRingMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.55,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    regionRings = new THREE.LineSegments(ringGeometry, regionRingMaterial);
    regionRings.renderOrder = 2;
    root.add(regionRings);
  }

  const labelStride = plan.counts.layers > 24 ? 2 : 1;
  for (const region of plan.regions) {
    if (labelStride > 1 && region.blockIndex % labelStride !== 0) continue;
    const texture = makeLabelTexture(region.blockIndex ?? "region", {
      font: "600 42px system-ui, sans-serif",
      color: "rgba(196, 228, 255, 0.88)",
      shadowBlur: 12,
    });
    labelTextures.push(texture);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 0.84,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    }));
    sprite.position.set(
      region.position[0] + region.normal[0] * region.radius * 0.98,
      region.position[1] + region.normal[1] * region.radius * 0.98,
      region.position[2] + region.normal[2] * region.radius * 0.98,
    );
    sprite.scale.set(region.radius * 0.95, region.radius * 0.36, 1);
    sprite.renderOrder = 8;
    architectureGroup.add(sprite);
  }

  const globalLabels = {
    "model.embed_tokens": "Embedding",
    "model.rotary_emb": "RoPE",
    "model.norm": "Final norm",
    "model.lm_head": "LM head",
  };
  for (const node of plan.nodes) {
    const label = globalLabels[node.id];
    if (!label) continue;
    const texture = makeLabelTexture(label, {
      width: 320,
      font: "600 34px system-ui, sans-serif",
      color: "rgba(206, 236, 255, 0.9)",
      shadowBlur: 12,
    });
    labelTextures.push(texture);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 0.8,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    }));
    sprite.position.set(
      node.position[0],
      node.position[1] + node.scale * 2.4 + 1.2,
      node.position[2],
    );
    sprite.scale.set(Math.max(4.2, node.scale * 6), Math.max(1.45, node.scale * 2.05), 1);
    sprite.renderOrder = 8;
    architectureGroup.add(sprite);
  }

  // ------------------------------------------------------- illustrative web
  const synapticGroup = new THREE.Group();
  root.add(synapticGroup);
  const synapticMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.5,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
  const synapticNodes = plan.synaptic.nodes;
  if (synapticNodes.length) {
    const geometry = new THREE.IcosahedronGeometry(1, 0);
    const mesh = new THREE.InstancedMesh(geometry, synapticMaterial, synapticNodes.length);
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    synapticNodes.forEach((node, index) => {
      dummy.position.set(node.position[0], node.position[1], node.position[2]);
      dummy.scale.set(node.scale, node.scale, node.scale);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
      const rgb = colorToRgb(node.color);
      mesh.setColorAt(index, scratchColor.setRGB(rgb[0], rgb[1], rgb[2]));
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    mesh.renderOrder = 4;
    synapticGroup.add(mesh);
  }

  const synapticGlowPositions = new Float32Array(synapticNodes.length * 3);
  const synapticGlowColors = new Float32Array(synapticNodes.length * 3);
  synapticNodes.forEach((node, index) => {
    synapticGlowPositions[index * 3] = node.position[0];
    synapticGlowPositions[index * 3 + 1] = node.position[1];
    synapticGlowPositions[index * 3 + 2] = node.position[2];
    const rgb = colorToRgb(node.color);
    synapticGlowColors[index * 3] = rgb[0] * 0.8;
    synapticGlowColors[index * 3 + 1] = rgb[1] * 0.8;
    synapticGlowColors[index * 3 + 2] = rgb[2] * 0.8;
  });
  const synapticGlowGeometry = new THREE.BufferGeometry();
  synapticGlowGeometry.setAttribute("position", new THREE.BufferAttribute(synapticGlowPositions, 3));
  synapticGlowGeometry.setAttribute("color", new THREE.BufferAttribute(synapticGlowColors, 3));
  const synapticGlowMaterial = new THREE.PointsMaterial({
    size: Math.max(0.35, Math.min(1.4, plan.bounds.radius * 0.03)),
    map: glowTexture,
    transparent: true,
    opacity: 0.22,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
    toneMapped: false,
    fog: false,
  });
  const synapticGlow = new THREE.Points(synapticGlowGeometry, synapticGlowMaterial);
  synapticGlow.renderOrder = 4;
  synapticGroup.add(synapticGlow);

  const filamentPositions = [];
  const filamentColors = [];
  for (const filament of plan.synaptic.filaments) {
    const rgb = colorToRgb(filament.color);
    const intensity = filament.intensity ?? 1;
    const pointCount = filament.points.length;
    for (let index = 0; index < pointCount - 1; index += 1) {
      const from = filament.points[index];
      const to = filament.points[index + 1];
      // Branches are brightest at the structural root and fade toward their
      // tips. Field webs stay uniformly faint. The taper gives the web a
      // natural direction and keeps long foreground strands from dominating.
      const taper = filament.role === "field-web"
        ? 0.62
        : 1 - 0.58 * (index / Math.max(1, pointCount - 2));
      filamentPositions.push(from[0], from[1], from[2], to[0], to[1], to[2]);
      const r = Math.min(1, rgb[0] * intensity * taper);
      const g = Math.min(1, rgb[1] * intensity * taper);
      const b = Math.min(1, rgb[2] * intensity * taper);
      filamentColors.push(r, g, b, r, g, b);
    }
  }

  let filamentLineGeometry = null;
  let filamentLineMaterial = null;
  let filamentLines = null;
  if (filamentPositions.length) {
    filamentLineGeometry = new LineSegmentsGeometry();
    filamentLineGeometry.setPositions(new Float32Array(filamentPositions));
    filamentLineGeometry.setColors(new Float32Array(filamentColors));
    const dashSize = Math.max(0.16, plan.bounds.radius * 0.012);
    filamentLineMaterial = new LineMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.36,
      linewidth: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      worldUnits: false,
      toneMapped: false,
      fog: true,
      dashed: true,
      dashSize,
      gapSize: dashSize * 0.72,
    });
    filamentLineMaterial.dashed = true;
    filamentLines = new LineSegments2(filamentLineGeometry, filamentLineMaterial);
    filamentLines.computeLineDistances();
    filamentLines.renderOrder = 2;
    synapticGroup.add(filamentLines);
  }

  // ---------------------------------------------------- illustrative signals
  // Travelling motes make the web feel computationally active. They follow
  // illustrative filaments only; the legend says so explicitly.
  const signalsGroup = new THREE.Group();
  signalsGroup.visible = false;
  root.add(signalsGroup);
  const signalField = createPulseField(
    plan.synaptic.filaments,
    Math.min(340, Math.max(96, Math.round(132 + plan.counts.layers * 6))),
    {
      seed: 0x51a1f00d,
      texture: glowTexture,
      size: Math.max(0.34, plan.bounds.radius * 0.014),
      opacity: 0.78,
      minSpeed: 0.05,
      maxSpeed: 0.17,
      renderOrder: 5,
    },
  );
  if (signalField.points) signalsGroup.add(signalField.points);

  // ------------------------------------------ speculative attention field
  // Long violet arcs connect distant regions. They are intentionally distinct
  // from measured data and from the structural graph, and can be switched off.
  const attentionGroup = new THREE.Group();
  attentionGroup.visible = false;
  root.add(attentionGroup);
  let attentionLineMaterial = null;
  let attentionPulses = null;
  if (plan.attention.length) {
    const attentionPositions = [];
    const attentionColors = [];
    for (const arc of plan.attention) {
      const rgb = colorToRgb(arc.color);
      const intensity = arc.intensity ?? 0.3;
      for (let index = 0; index < arc.points.length - 1; index += 1) {
        const from = arc.points[index];
        const to = arc.points[index + 1];
        const taper = 0.55 + 0.45 * Math.sin(((index + 1) / arc.points.length) * Math.PI);
        attentionPositions.push(from[0], from[1], from[2], to[0], to[1], to[2]);
        const r = Math.min(1, rgb[0] * intensity * taper);
        const g = Math.min(1, rgb[1] * intensity * taper);
        const b = Math.min(1, rgb[2] * intensity * taper);
        attentionColors.push(r, g, b, r, g, b);
      }
    }
    const attentionGeometry = new LineSegmentsGeometry();
    attentionGeometry.setPositions(new Float32Array(attentionPositions));
    attentionGeometry.setColors(new Float32Array(attentionColors));
    const dashSize = Math.max(0.2, plan.bounds.radius * 0.011);
    attentionLineMaterial = new LineMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.34,
      linewidth: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      worldUnits: false,
      toneMapped: false,
      fog: false,
      dashed: true,
      dashSize,
      gapSize: dashSize * 0.9,
    });
    const attentionLines = new LineSegments2(attentionGeometry, attentionLineMaterial);
    attentionLines.computeLineDistances();
    attentionLines.renderOrder = 3;
    attentionGroup.add(attentionLines);
    attentionPulses = createPulseField(
      plan.attention,
      Math.min(64, Math.max(18, plan.attention.length * 2)),
      {
        seed: 0x5eeda77e,
        texture: glowTexture,
        size: Math.max(0.4, plan.bounds.radius * 0.016),
        opacity: 0.86,
        minSpeed: 0.035,
        maxSpeed: 0.11,
        renderOrder: 5,
      },
    );
    if (attentionPulses.points) attentionGroup.add(attentionPulses.points);
  }

  // ---------------------------------------------------------- ambient dust
  // Roughly doubled from the Phase 1.5 scene. Positions are generated once and
  // never allocated per frame.
  const dustCount = 2700;
  const dustPositions = new Float32Array(dustCount * 3);
  const dustColors = new Float32Array(dustCount * 3);
  const dustRandom = seededRandom(0x0d0577);
  for (let index = 0; index < dustCount; index += 1) {
    const theta = dustRandom() * Math.PI * 2;
    const phi = Math.acos(2 * dustRandom() - 1);
    const radius = plan.bounds.radius * (0.92 + dustRandom() * 2.15);
    dustPositions[index * 3] = plan.bounds.center[0] + radius * Math.sin(phi) * Math.cos(theta);
    dustPositions[index * 3 + 1] = plan.bounds.center[1] + radius * Math.cos(phi);
    dustPositions[index * 3 + 2] = plan.bounds.center[2] + radius * Math.sin(phi) * Math.sin(theta);
    const tint = 0.08 + dustRandom() * 0.2;
    dustColors[index * 3] = tint * (0.4 + dustRandom() * 0.35);
    dustColors[index * 3 + 1] = tint * (0.7 + dustRandom() * 0.3);
    dustColors[index * 3 + 2] = tint;
  }
  const dustGeometry = new THREE.BufferGeometry();
  dustGeometry.setAttribute("position", new THREE.BufferAttribute(dustPositions, 3));
  dustGeometry.setAttribute("color", new THREE.BufferAttribute(dustColors, 3));
  const dustMaterial = new THREE.PointsMaterial({
    size: Math.max(0.035, plan.bounds.radius * 0.0034),
    transparent: true,
    opacity: 0.44,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
    toneMapped: false,
    fog: false,
  });
  const dust = new THREE.Points(dustGeometry, dustMaterial);
  dust.frustumCulled = false;
  root.add(dust);

  // ---------------------------------------------------------- deep-space field
  // Three bounded layers give the brain a universe: a twinkling stellar shell,
  // luminous nebula masses and faint far-field wisps. Their counts come from the
  // layout plan and are never derived from parameters or tensor counts.
  const deepGroup = new THREE.Group();
  deepGroup.visible = false;
  root.add(deepGroup);

  const starData = plan.ambient.stars;
  const starGeometry = new THREE.BufferGeometry();
  const starPositionAttribute = new THREE.BufferAttribute(starData.positions, 3);
  const starColorAttribute = new THREE.BufferAttribute(starData.colors, 3);
  starGeometry.setAttribute("position", starPositionAttribute);
  starGeometry.setAttribute("aColor", starColorAttribute);
  starGeometry.setAttribute("aSize", new THREE.BufferAttribute(starData.sizes, 1));
  starGeometry.setAttribute("aPhase", new THREE.BufferAttribute(starData.phases, 1));
  const starMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: renderer.getPixelRatio() },
      uScale: { value: Math.max(6, plan.bounds.radius * 1.65) },
      uDensity: { value: 1 },
      uIntensity: { value: 0.9 },
    },
    vertexShader: `
      uniform float uTime;
      uniform float uPixelRatio;
      uniform float uScale;
      uniform float uDensity;
      attribute vec3 aColor;
      attribute float aSize;
      attribute float aPhase;
      varying vec3 vColor;
      varying float vTwinkle;
      void main() {
        vec3 p = position;
        float angle = uTime * (0.0015 + aPhase * 0.0035);
        float c = cos(angle);
        float s = sin(angle);
        p.xz = mat2(c, -s, s, c) * p.xz;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float dist = max(-mv.z, 0.001);
        float scaled = aSize * uScale * uDensity / dist;
        gl_PointSize = clamp(scaled * uPixelRatio, 0.55, 9.0);
        vColor = aColor;
        vTwinkle = 0.55 + 0.45 * sin(uTime * 0.7 + aPhase * 6.28318);
      }
    `,
    fragmentShader: `
      uniform float uIntensity;
      varying vec3 vColor;
      varying float vTwinkle;
      void main() {
        vec2 offset = gl_PointCoord - vec2(0.5);
        float distanceToCentre = length(offset);
        float core = smoothstep(0.5, 0.05, distanceToCentre);
        float halo = smoothstep(0.5, 0.0, distanceToCentre) * 0.32;
        float alpha = (core + halo) * vTwinkle * uIntensity;
        gl_FragColor = vec4(vColor, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const starField = new THREE.Points(starGeometry, starMaterial);
  starField.frustumCulled = false;
  starField.renderOrder = -4;
  deepGroup.add(starField);

  const nebulaSprites = [];
  plan.ambient.clouds.forEach((cloud, index) => {
    const texture = nebulaTextures[index % nebulaTextures.length];
    const material = new THREE.SpriteMaterial({
      map: texture,
      color: cloud.color,
      transparent: true,
      opacity: cloud.opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
      fog: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.position.set(cloud.position[0], cloud.position[1], cloud.position[2]);
    sprite.scale.set(cloud.size, cloud.size * 0.72, 1);
    sprite.renderOrder = -3;
    deepGroup.add(sprite);
    nebulaSprites.push({
      sprite,
      cloud,
      baseOpacity: cloud.opacity,
      baseScale: cloud.size,
    });
  });

  const wispPositions = [];
  const wispColors = [];
  for (const wisp of plan.ambient.wisps) {
    const rgb = colorToRgb(wisp.color);
    const intensity = wisp.intensity ?? 0.2;
    for (let index = 0; index < wisp.points.length - 1; index += 1) {
      const from = wisp.points[index];
      const to = wisp.points[index + 1];
      const taper = 0.45 + 0.55 * (1 - index / Math.max(1, wisp.points.length - 2));
      wispPositions.push(from[0], from[1], from[2], to[0], to[1], to[2]);
      const r = Math.min(1, rgb[0] * intensity * taper);
      const g = Math.min(1, rgb[1] * intensity * taper);
      const b = Math.min(1, rgb[2] * intensity * taper);
      wispColors.push(r, g, b, r, g, b);
    }
  }
  let wispLineMaterial = null;
  if (wispPositions.length) {
    const wispGeometry = new LineSegmentsGeometry();
    wispGeometry.setPositions(new Float32Array(wispPositions));
    wispGeometry.setColors(new Float32Array(wispColors));
    wispLineMaterial = new LineMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.22,
      linewidth: 0.75,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      worldUnits: false,
      toneMapped: false,
      fog: false,
    });
    const wispLines = new LineSegments2(wispGeometry, wispLineMaterial);
    wispLines.renderOrder = -2;
    deepGroup.add(wispLines);
  }

  // -------------------------------------------------------------- selection
  const selectionHalo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture,
    color: 0xd8f4ff,
    transparent: true,
    opacity: 0.8,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  }));
  selectionHalo.visible = false;
  selectionHalo.renderOrder = 9;
  scene.add(selectionHalo);

  const selectionShellGeometry = new THREE.IcosahedronGeometry(1, 2);
  const selectionShellMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x9be8ff,
    roughness: 0.06,
    metalness: 0.02,
    clearcoat: 1,
    clearcoatRoughness: 0.06,
    emissive: new THREE.Color(0x2aa7d8),
    emissiveIntensity: 0.32,
    transparent: true,
    opacity: 0.2,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const selectionShell = new THREE.Mesh(selectionShellGeometry, selectionShellMaterial);
  selectionShell.visible = false;
  selectionShell.renderOrder = 6;
  selectionShell.frustumCulled = false;
  scene.add(selectionShell);

  // ------------------------------------------------------- observed activity
  // Fixed-size pools acknowledge genuine telemetry events. They are separate
  // from structural nodes, blueprint edges and the illustrative web, and never
  // claim per-layer activity. No effect is scheduled by a timer, so an idle
  // brain emits nothing here.
  const activityGroup = new THREE.Group();
  activityGroup.visible = false;
  scene.add(activityGroup);
  const activityAnchor = new THREE.Vector3(
    plan.bounds.center[0],
    plan.bounds.center[1] + plan.bounds.radius * 0.92,
    plan.bounds.center[2],
  );
  const ACTIVITY_POOL_SIZE = 6;
  const activityEffects = [];
  for (let index = 0; index < ACTIVITY_POOL_SIZE; index += 1) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture,
      color: 0x67e8f9,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    }));
    sprite.position.copy(activityAnchor);
    sprite.visible = false;
    sprite.renderOrder = 9;
    activityGroup.add(sprite);
    activityEffects.push({ sprite, startedAt: 0, duration: 0, baseScale: 1 });
  }

  const BURST_POOL_SIZE = 190;
  const burstPositions = new Float32Array(BURST_POOL_SIZE * 3);
  const burstColors = new Float32Array(BURST_POOL_SIZE * 3);
  const burstParticles = [];
  for (let index = 0; index < BURST_POOL_SIZE; index += 1) {
    burstParticles.push({
      active: false,
      age: 0,
      life: 1,
      position: [0, 0, 0],
      velocity: [0, 0, 0],
      color: [0, 0, 0],
    });
  }
  const burstGeometry = new THREE.BufferGeometry();
  const burstPositionAttribute = new THREE.BufferAttribute(burstPositions, 3);
  burstPositionAttribute.setUsage(THREE.DynamicDrawUsage);
  const burstColorAttribute = new THREE.BufferAttribute(burstColors, 3);
  burstColorAttribute.setUsage(THREE.DynamicDrawUsage);
  burstGeometry.setAttribute("position", burstPositionAttribute);
  burstGeometry.setAttribute("color", burstColorAttribute);
  const burstMaterial = new THREE.PointsMaterial({
    size: Math.max(0.55, plan.bounds.radius * 0.022),
    map: glowTexture,
    transparent: true,
    opacity: 0.9,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
    toneMapped: false,
    fog: false,
  });
  const burstPoints = new THREE.Points(burstGeometry, burstMaterial);
  burstPoints.frustumCulled = false;
  burstPoints.renderOrder = 9;
  burstPoints.visible = false;
  activityGroup.add(burstPoints);

  const RING_POOL_SIZE = 6;
  const ringEffects = [];
  for (let index = 0; index < RING_POOL_SIZE; index += 1) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: ringTexture,
      color: 0xfbbf24,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    }));
    sprite.position.copy(activityAnchor);
    sprite.visible = false;
    sprite.renderOrder = 9;
    activityGroup.add(sprite);
    ringEffects.push({ sprite, active: false, age: 0, delay: 0, duration: 1, baseScale: 1, peak: 0.8 });
  }

  const burstRandom = seededRandom(0x9e3779b9);
  let burstCursor = 0;
  let ringCursor = 0;
  let activityEnabled = options.activityEnabled !== false;
  let lastStepAckAt = -Infinity;
  let lastEvaluationAckAt = -Infinity;
  let eventFlare = { strength: 0, color: new THREE.Color(0x67e8f9) };
  const syncFlares = [];
  let nextSyncAt = 6;

  function clearActivity() {
    for (const effect of activityEffects) {
      effect.sprite.visible = false;
      effect.sprite.material.opacity = 0;
    }
    for (const particle of burstParticles) {
      particle.active = false;
      particle.color = [0, 0, 0];
    }
    for (const ring of ringEffects) {
      ring.active = false;
      ring.sprite.visible = false;
      ring.sprite.material.opacity = 0;
    }
    syncFlares.length = 0;
    eventFlare.strength = 0;
    burstPoints.visible = false;
    activityGroup.visible = false;
  }

  function setActivityEnabled(enabled) {
    activityEnabled = enabled === true;
    if (!activityEnabled) clearActivity();
    return activityEnabled;
  }

  function spawnBurst(origin, spec) {
    const rgb = colorToRgb(spec.color);
    const reduced = effectSettings.reducedMotion === true;
    const count = reduced ? Math.min(18, spec.particles) : spec.particles;
    for (let index = 0; index < count; index += 1) {
      const particle = burstParticles[burstCursor % BURST_POOL_SIZE];
      burstCursor += 1;
      const direction = randomUnitVector(burstRandom);
      const speed = plan.bounds.radius * (0.035 + burstRandom() * 0.075) * (reduced ? 0.35 : 1);
      particle.active = true;
      particle.age = 0;
      particle.life = 0.75 + burstRandom() * 0.85;
      const jitter = plan.bounds.radius * 0.012;
      particle.position = [
        origin.x + (burstRandom() - 0.5) * jitter,
        origin.y + (burstRandom() - 0.5) * jitter,
        origin.z + (burstRandom() - 0.5) * jitter,
      ];
      particle.velocity = [
        direction[0] * speed,
        direction[1] * speed,
        direction[2] * speed,
      ];
      const brightness = 0.55 + burstRandom() * 0.45;
      particle.color = [rgb[0] * brightness, rgb[1] * brightness, rgb[2] * brightness];
    }
    burstPoints.visible = true;
  }

  function spawnRings(origin, spec) {
    if (effectSettings.reducedMotion === true) return;
    for (let index = 0; index < spec.rings; index += 1) {
      const ring = ringEffects[ringCursor % RING_POOL_SIZE];
      ringCursor += 1;
      ring.active = true;
      ring.age = 0;
      ring.delay = index * 0.18;
      ring.duration = (spec.duration / 1000) * (0.7 + index * 0.16);
      ring.baseScale = plan.bounds.radius * (0.34 + index * 0.12);
      ring.peak = 0.62 - index * 0.12;
      ring.sprite.material.color.set(spec.ringColor);
      ring.sprite.material.opacity = 0;
      ring.sprite.position.copy(origin);
      ring.sprite.scale.setScalar(ring.baseScale * 0.25);
      ring.sprite.visible = true;
    }
  }

  /**
   * Acknowledge one genuine event. Step and evaluation bursts are restrained;
   * a checkpoint adds an amber shockwave; failure and recovery have distinct
   * colours. None of these effects identifies a measured layer.
   */
  function notifyActivity({ kind = "step" } = {}) {
    if (!activityEnabled || mode !== "brain") return false;
    const now = performance.now();
    if (kind === "step" && now - lastStepAckAt < 380) return false;
    if (kind === "evaluation" && now - lastEvaluationAckAt < 700) return false;
    if (kind === "step") lastStepAckAt = now;
    if (kind === "evaluation") lastEvaluationAckAt = now;
    const spec = activityVisualSpec(kind);
    const checkpointLike = kind === "checkpoint";
    const effect = activityEffects.find((item) => !item.sprite.visible)
      ?? activityEffects.reduce((oldest, item) => (item.startedAt < oldest.startedAt ? item : oldest), activityEffects[0]);
    effect.startedAt = now;
    effect.duration = spec.duration;
    effect.baseScale = plan.bounds.radius * (checkpointLike ? 0.13 : 0.075);
    effect.peakOpacity = checkpointLike ? 0.9 : 0.62;
    effect.sprite.material.color.set(spec.color);
    effect.sprite.material.opacity = effect.peakOpacity;
    effect.sprite.position.copy(activityAnchor);
    effect.sprite.scale.setScalar(effect.baseScale);
    effect.sprite.visible = true;
    activityGroup.visible = true;

    // Step acknowledgements originate at the neutral status anchor, not inside
    // a transformer region, so a global training event cannot look like a
    // measured per-layer signal.
    spawnBurst(activityAnchor, spec);
    spawnRings(
      new THREE.Vector3(
        plan.bounds.center[0],
        plan.bounds.center[1],
        plan.bounds.center[2],
      ),
      spec,
    );
    if (kind !== "step" && kind !== "evaluation") {
      eventFlare.strength = Math.max(eventFlare.strength, checkpointLike ? 0.9 : 0.55);
      eventFlare.color.set(spec.color);
      triggerStepScan(spec.color, checkpointLike ? 0.9 : 0.55);
    }
    telemetryEnergy = Math.min(1.8, telemetryEnergy + spec.energy);
    return true;
  }

  function updateActivity(now, dt) {
    if (!activityEnabled || mode !== "brain") {
      if (activityGroup.visible) clearActivity();
      return;
    }
    let any = false;
    for (const effect of activityEffects) {
      if (!effect.sprite.visible) continue;
      const t = (now - effect.startedAt) / effect.duration;
      if (t >= 1) {
        effect.sprite.visible = false;
        effect.sprite.material.opacity = 0;
        continue;
      }
      any = true;
      const eased = 1 - (1 - t) * (1 - t);
      effect.sprite.material.opacity = (1 - t) * (1 - t) * effect.peakOpacity;
      effect.sprite.scale.setScalar(effect.baseScale * (1 + eased * 1.6));
    }

    let anyBurst = false;
    for (let index = 0; index < burstParticles.length; index += 1) {
      const particle = burstParticles[index];
      if (!particle.active) {
        burstColors[index * 3] = 0;
        burstColors[index * 3 + 1] = 0;
        burstColors[index * 3 + 2] = 0;
        continue;
      }
      particle.age += dt;
      if (particle.age >= particle.life) {
        particle.active = false;
        burstColors[index * 3] = 0;
        burstColors[index * 3 + 1] = 0;
        burstColors[index * 3 + 2] = 0;
        continue;
      }
      anyBurst = true;
      const drag = Math.pow(0.12, dt);
      particle.velocity[0] *= drag;
      particle.velocity[1] *= drag;
      particle.velocity[2] *= drag;
      particle.position[0] += particle.velocity[0] * dt;
      particle.position[1] += particle.velocity[1] * dt;
      particle.position[2] += particle.velocity[2] * dt;
      burstPositions[index * 3] = particle.position[0];
      burstPositions[index * 3 + 1] = particle.position[1];
      burstPositions[index * 3 + 2] = particle.position[2];
      const fade = Math.pow(1 - particle.age / particle.life, 1.6);
      burstColors[index * 3] = particle.color[0] * fade;
      burstColors[index * 3 + 1] = particle.color[1] * fade;
      burstColors[index * 3 + 2] = particle.color[2] * fade;
    }
    burstPositionAttribute.needsUpdate = true;
    burstColorAttribute.needsUpdate = true;
    burstPoints.visible = anyBurst;
    any = any || anyBurst;

    for (const ring of ringEffects) {
      if (!ring.active) continue;
      ring.age += dt;
      const t = (ring.age - ring.delay) / Math.max(0.001, ring.duration);
      if (t >= 1) {
        ring.active = false;
        ring.sprite.visible = false;
        ring.sprite.material.opacity = 0;
        continue;
      }
      if (t < 0) {
        ring.sprite.visible = false;
        continue;
      }
      any = true;
      ring.sprite.visible = true;
      ring.sprite.material.opacity = Math.pow(1 - t, 1.8) * ring.peak;
      ring.sprite.scale.setScalar(ring.baseScale * (0.3 + t * 2.5));
    }

    activityGroup.visible = any;
  }

  // ---------------------------------------------------------- living regions
  // Regions breathe on a slow shared rhythm. Checkpoint/failure flares and the
  // occasional discovered "sync" between distant endpoints add punctuation.
  // The wave is an acknowledgement of the sequence as a whole; it never labels
  // a region with a measured value.
  const regionScratchColor = new THREE.Color();
  let stepScan = { active: false, position: 0, strength: 0, color: new THREE.Color(0x67e8f9) };

  function updateRegionPulse(simTime, motion, dt) {
    const regionCount = plan.regions.length;
    if (!regionCount) return;
    eventFlare.strength = Math.max(0, eventFlare.strength - dt * 0.55);
    if (stepScan.active) {
      stepScan.position += dt * 0.22;
      if (stepScan.position > 1.2) stepScan.active = false;
    }
    for (const flare of syncFlares) flare.strength = Math.max(0, flare.strength - dt * 0.8);
    while (syncFlares.length && syncFlares[0].strength <= 0) syncFlares.shift();

    for (let index = 0; index < regionCount; index += 1) {
      const region = plan.regions[index];
      const base = regionBaseRgb[index];
      const blockFraction = regionCount <= 1 ? 0 : index / (regionCount - 1);
      const phase = (region.blockIndex ?? index) * 0.58;
      const breath = 0.76 + 0.24 * Math.sin(simTime * 0.62 + phase) * motion.amplitude;
      let gain = breath * (0.72 + telemetryEnergy * 0.32) * highlightDim;
      let red = base[0];
      let green = base[1];
      let blue = base[2];

      if (eventFlare.strength > 0) {
        const amount = eventFlare.strength * 0.55;
        red += (eventFlare.color.r - red) * amount;
        green += (eventFlare.color.g - green) * amount;
        blue += (eventFlare.color.b - blue) * amount;
        gain += eventFlare.strength * 0.35;
      }
      if (stepScan.active) {
        const distance = blockFraction - stepScan.position;
        const band = Math.exp(-(distance * distance) / 0.012) * stepScan.strength;
        if (band > 0.001) {
          red += (stepScan.color.r - red) * band * 0.65;
          green += (stepScan.color.g - green) * band * 0.65;
          blue += (stepScan.color.b - blue) * band * 0.65;
          gain += band * 0.6;
        }
      }
      for (const flare of syncFlares) {
        if (flare.index !== index) continue;
        const amount = Math.min(0.85, flare.strength);
        red += (flare.color.r - red) * amount;
        green += (flare.color.g - green) * amount;
        blue += (flare.color.b - blue) * amount;
        gain += amount * 0.4;
      }

      regionScratchColor.setRGB(
        Math.min(1, red * gain),
        Math.min(1, green * gain),
        Math.min(1, blue * gain),
      );
      regionHaloColors[index * 3] = regionScratchColor.r;
      regionHaloColors[index * 3 + 1] = regionScratchColor.g;
      regionHaloColors[index * 3 + 2] = regionScratchColor.b;
    }
    regionHaloColorAttribute.needsUpdate = true;
    regionHaloMaterial.size = Math.max(5, Math.min(20, averageRegionRadius * (1.55 + 0.2 * Math.sin(simTime * 0.4))));
  }

  function triggerStepScan(color = 0x67e8f9, strength = 0.8) {
    stepScan = {
      active: true,
      position: 0,
      strength,
      color: new THREE.Color(color),
    };
  }

  // --------------------------------------------------- cinematic appearance
  const syncRandom = seededRandom(0x5a17c0de);
  const moodTint = new THREE.Color(0x818cf8);
  const ambientDensity = () => Math.max(0, Math.min(1.6, effectSettings.ambientDensity));
  const densityGain = () => {
    const density = ambientDensity();
    return density <= 0 ? 0 : 0.5 + Math.min(1.2, density) * 0.55;
  };

  function refreshCinematicAppearance() {
    const visibility = effectVisibility(effectSettings, mode, {
      layerActivity: layerActivityEnabled && Boolean(layerActivityData),
    });
    const density = ambientDensity();
    const starFraction = density <= 0 ? 0 : Math.min(1, density);
    deepGroup.visible = visibility.deepSpace;
    dust.visible = visibility.decorative;
    synapticGroup.visible = visibility.synaptic;
    signalsGroup.visible = visibility.signals && Boolean(signalField.points);
    attentionGroup.visible = visibility.attention && plan.attention.length > 0;
    atmosphereGroup.visible = visibility.atmosphere;
    regionHalo.visible = visibility.decorative;
    if (signalField.points) signalField.setVisible(visibility.signals);
    if (attentionPulses?.points) attentionPulses.setVisible(visibility.attention);
    if (!visibility.layerActivity) layerActivityPoints.visible = false;
    else if (layerActivityEnabled && layerActivityData) updateLayerActivityColors();
    starMaterial.uniforms.uDensity.value = 0.55 + starFraction * 0.85;
    starGeometry.setDrawRange(0, Math.max(0, Math.floor(plan.ambient.stars.count * starFraction)));
    dustGeometry.setDrawRange(0, Math.max(0, Math.floor(dustCount * Math.min(1, density))));
    for (const entry of nebulaSprites) entry.sprite.visible = visibility.deepSpace && density > 0;
    if (wispLineMaterial) wispLineMaterial.visible = visibility.deepSpace && density > 0;
  }

  function setEffectSettings(next = {}) {
    effectSettings = normalizeEffectSettings({ ...effectSettings, ...next }, {
      prefersReducedMotion: effectSettings.reducedMotion,
    });
    Object.assign(motion, effectiveMotion(effectSettings));
    if (effectSettings.reducedMotion === true) {
      // Clear transient bursts so switching to reduced motion takes effect at
      // once, while leaving all independent toggles and telemetry untouched.
      for (const particle of burstParticles) particle.active = false;
      for (const ring of ringEffects) {
        ring.active = false;
        ring.sprite.visible = false;
        ring.sprite.material.opacity = 0;
      }
    }
    refreshCinematicAppearance();
    updateDiagnostics();
    return effectSettings;
  }

  function setTelemetryStatus(status) {
    telemetryStatus = typeof status === "string" ? status : "unavailable";
    telemetryVisual = telemetryMood(telemetryStatus);
    refreshCinematicAppearance();
    updateDiagnostics();
    return telemetryVisual;
  }

  function updateMood(dt) {
    const target = telemetryVisual.energy;
    telemetryEnergy += (target - telemetryEnergy) * Math.min(1, dt * 1.8);
    moodTint.set(telemetryVisual.tint);
    innerLight.color.lerp(moodTint, Math.min(1, dt * 0.8));
    // A failed/stale run dims and cools the glow; live training raises it
    // gently. No full-screen flash is used.
    innerLight.intensity = 140 * (0.68 + telemetryEnergy * 0.38) * densityGain();
  }

  function updateAmbient(simTime, dt, motion) {
    const density = ambientDensity();
    const gain = densityGain();
    const energy = 0.72 + telemetryEnergy * 0.36;
    const pulse = 0.72 + telemetryVisual.pulseGain * 0.3;
    starMaterial.uniforms.uTime.value = simTime;
    starMaterial.uniforms.uIntensity.value = 0.9
      * effectSettings.intensity
      * effectSettings.intensity
      * gain
      * telemetryVisual.ambientGain
      * highlightDim;
    dust.rotation.y = simTime * 0.0055 * motion.drift;
    dust.rotation.x = Math.sin(simTime * 0.045) * 0.012 * motion.drift;
    dustMaterial.opacity = 0.44 * gain * telemetryVisual.ambientGain * highlightDim * energy;
    for (const entry of nebulaSprites) {
      const cloud = entry.cloud;
      const wave = 0.72 + 0.28 * Math.sin(simTime * 0.09 + cloud.phase);
      entry.sprite.material.opacity = entry.baseOpacity * wave * gain * highlightDim * energy;
      const scale = entry.baseScale * (1 + 0.035 * Math.sin(simTime * 0.055 + cloud.phase));
      entry.sprite.scale.set(scale, scale * 0.72, 1);
      entry.sprite.position.set(
        cloud.position[0] + Math.sin(simTime * 0.02 + cloud.phase) * cloud.drift[0] * plan.bounds.radius * 0.04,
        cloud.position[1] + Math.cos(simTime * 0.017 + cloud.phase) * cloud.drift[1] * plan.bounds.radius * 0.04,
        cloud.position[2] + Math.sin(simTime * 0.019 + cloud.phase * 1.7) * cloud.drift[2] * plan.bounds.radius * 0.04,
      );
    }
    if (wispLineMaterial) {
      wispLineMaterial.opacity = 0.22 * density * gain * highlightDim * (0.8 + telemetryEnergy * 0.25);
    }
    if (filamentLineMaterial) {
      const selected = highlightDim < 1;
      filamentLineMaterial.opacity = (selected ? 0.12 : 0.36) * (0.45 + density * 0.5) * pulse * (0.8 + telemetryEnergy * 0.25);
    }
    synapticMaterial.opacity = (highlightDim < 1 ? 0.34 : 0.5) * (0.45 + density * 0.42) * pulse;
    synapticGlowMaterial.opacity = (highlightDim < 1 ? 0.14 : 0.22) * (0.55 + density * 0.36) * pulse;
    if (signalField.points) {
      signalField.update(dt, motion.speed * (0.78 + telemetryEnergy * 0.3), (0.75 + density * 0.3) * highlightDim);
    }
    for (const entry of atmosphereSprites) {
      entry.sprite.material.opacity = entry.baseOpacity * (0.75 + telemetryEnergy * 0.4) * (0.75 + 0.25 * Math.sin(simTime * 0.11 + entry.phase)) * highlightDim;
    }
  }

  function updateAttention(simTime, dt, motion) {
    if (!attentionPulses?.points) return;
    const gain = (0.8 + ambientDensity() * 0.25) * highlightDim * (0.8 + telemetryVisual.pulseGain * 0.3);
    attentionPulses.update(dt, motion.speed * (0.85 + telemetryEnergy * 0.25), gain);
    if (attentionLineMaterial) {
      attentionLineMaterial.opacity = 0.34 * (0.6 + ambientDensity() * 0.45) * highlightDim * (0.8 + telemetryEnergy * 0.25);
    }
    if (!motion.attention || simTime < nextSyncAt) return;
    // Intermittent synchronisation: two distant regions flare together while a
    // speculative arc is already carrying motes. This is artistic, not a
    // measured attention map.
    const arc = plan.attention[Math.floor(syncRandom() * plan.attention.length)];
    nextSyncAt = simTime + 10 + syncRandom() * 16;
    for (const blockIndex of [arc.fromBlockIndex, arc.toBlockIndex]) {
      const index = plan.regions.findIndex((region) => region.blockIndex === blockIndex);
      if (index < 0) continue;
      syncFlares.push({
        index,
        strength: 0.85,
        color: new THREE.Color(arc.color),
      });
    }
  }

  // ------------------------------------------------------------ interaction
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const focusTarget = new THREE.Vector3();
  const focusPosition = new THREE.Vector3();
  const selectionColor = new THREE.Color(0xf5fbff);
  let focusActive = false;
  let selectedId = null;
  let hoverId = null;
  let disposed = false;
  let pointerDown = null;
  let frame = 0;
  let mode = initialMode;

  const pickTargets = [...nodeMeshes];
  if (plan.regions.length) pickTargets.push(regionPickMesh);

  function applyHighlight(componentId) {
    const highlight = componentId ? highlightFor(blueprint, componentId) : null;
    const brain = mode === "brain";
    const dim = brain ? 0.34 : 0.26;

    for (const item of nodeInstances) {
      let rgb = item.base;
      if (highlight) {
        if (item.node.id === componentId) {
          rgb = [selectionColor.r, selectionColor.g, selectionColor.b];
        } else if (highlight.componentIds.has(item.node.id)) {
          rgb = [Math.min(1, item.base[0] * 1.12), Math.min(1, item.base[1] * 1.12), Math.min(1, item.base[2] * 1.12)];
        } else {
          rgb = [item.base[0] * dim, item.base[1] * dim, item.base[2] * dim];
        }
      }
      item.mesh.setColorAt(item.index, scratchColor.setRGB(rgb[0], rgb[1], rgb[2]));
    }
    for (const mesh of nodeMeshes) mesh.instanceColor.needsUpdate = true;

    const glowAttr = glowGeometry.getAttribute("color");
    plan.nodes.forEach((node, index) => {
      let rgb = glowBaseColors[index];
      if (highlight) {
        if (node.id === componentId) rgb = [1, 1, 1];
        else if (highlight.componentIds.has(node.id)) rgb = [Math.min(1, rgb[0] * 1.2), Math.min(1, rgb[1] * 1.2), Math.min(1, rgb[2] * 1.2)];
        else rgb = [rgb[0] * 0.2, rgb[1] * 0.2, rgb[2] * 0.2];
      }
      glowAttr.setXYZ(index, rgb[0], rgb[1], rgb[2]);
    });
    glowAttr.needsUpdate = true;

    if (structuralLineGeometry && edgeRanges.length) {
      const colorStart = structuralLineGeometry.getAttribute("instanceColorStart");
      const colorEnd = structuralLineGeometry.getAttribute("instanceColorEnd");
      const edgeBaseFactor = brain ? 0.78 : 1;
      for (const range of edgeRanges) {
        let factor = range.edge.overview || !brain ? edgeBaseFactor : 0.025;
        if (!highlight && range.edge.type === "positional_encoding") factor *= 0.012;
        if (!highlight && range.edge.type === "tied_parameter") factor *= 0.6;
        if (highlight) {
          if (highlight.connectionIds.has(range.edge.id)) factor = brain ? 1.28 : 1.55;
          else factor *= 0.14;
        }
        const r = Math.min(1, range.base[0] * factor);
        const g = Math.min(1, range.base[1] * factor);
        const b = Math.min(1, range.base[2] * factor);
        for (let index = range.start; index < range.start + range.count; index += 1) {
          colorStart.setXYZ(index, r, g, b);
          colorEnd.setXYZ(index, r, g, b);
        }
      }
      colorStart.data.needsUpdate = true;
      colorEnd.data.needsUpdate = true;
      structuralLineMaterial.opacity = brain
        ? (highlight ? 0.58 : 0.44)
        : (highlight ? 0.98 : 0.84);
    }

    if (filamentLineMaterial) {
      filamentLineMaterial.opacity = highlight ? 0.12 : 0.36;
    }
    synapticMaterial.opacity = highlight ? 0.34 : 0.5;
    synapticGlowMaterial.opacity = highlight ? 0.14 : 0.22;
    glowMaterial.opacity = highlight ? (brain ? 0.34 : 0.26) : (brain ? 0.42 : 0.3);
    regionHaloMaterial.opacity = highlight ? 0.09 : 0.2;
    highlightDim = highlight ? 0.58 : 1;
    refreshCinematicAppearance();

    let selectedNode = null;
    let selectedRegion = null;
    if (componentId) {
      selectedNode = plan.nodes.find((node) => node.id === componentId) ?? null;
      selectedRegion = plan.regions.find((region) => region.id === componentId) ?? null;
    }
    if (selectedNode || selectedRegion) {
      const position = selectedNode?.position ?? selectedRegion.position;
      const haloScale = selectedNode
        ? Math.max(selectedNode.scale * 3.4, plan.bounds.radius * 0.018)
        : selectedRegion.radius * 1.45;
      selectionHalo.position.set(position[0], position[1], position[2]);
      selectionHalo.scale.set(haloScale, haloScale, 1);
      if (selectedNode) {
        selectionHalo.material.color.setRGB(0.72, 0.94, 1);
      } else {
        const rgb = colorToRgb(selectedRegion.color);
        selectionHalo.material.color.setRGB(
          Math.min(1, rgb[0] * 1.35),
          Math.min(1, rgb[1] * 1.35),
          Math.min(1, rgb[2] * 1.35),
        );
      }
      selectionHalo.visible = true;
      if (selectedNode) {
        selectionShell.position.set(position[0], position[1], position[2]);
        selectionShell.scale.setScalar(selectedNode.scale * 1.42);
        selectionShell.visible = true;
      } else {
        selectionShell.visible = false;
      }
    } else {
      selectionHalo.visible = false;
      selectionShell.visible = false;
    }
  }

  function applyMode() {
    const brain = mode === "brain";
    architectureGroup.visible = !brain;
    if (!brain) {
      clearActivity();
      layerActivityPoints.visible = false;
    } else if (layerActivityEnabled && layerActivityData) {
      updateLayerActivityColors();
    }
    if (regionRingMaterial) regionRingMaterial.opacity = brain ? 0.26 : 0.45;
    refreshCinematicAppearance();
    applyHighlight(selectedId);
  }

  function positionFromEvent(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    return rect;
  }

  function pick(event) {
    if (!pickTargets.length) return null;
    positionFromEvent(event);
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(pickTargets, false);
    // Prefer a structural node hit over the invisible region picker, so
    // clicking a component inside a region always inspects that component.
    for (const hit of hits) {
      if (hit.object.userData.pickKind !== "node") continue;
      const componentId = hit.object.userData.componentIds?.[hit.instanceId] ?? null;
      if (componentId) return componentId;
    }
    for (const hit of hits) {
      if (hit.object.userData.pickKind !== "region") continue;
      const componentId = hit.object.userData.componentIds?.[hit.instanceId] ?? null;
      if (componentId) return componentId;
    }
    return null;
  }

  function focusOn(componentId) {
    const node = plan.nodes.find((item) => item.id === componentId);
    const region = plan.regions.find((item) => item.id === componentId);
    if (!node && !region) return;
    userInteracted = true;
    const target = node?.position ?? region.position;
    const extent = region ? region.radius : Math.max(2, node.scale * 3);
    const distance = region ? overviewDistance * 0.26 : Math.max(6, overviewDistance * 0.12);
    const focusDistance = Math.max(extent * 2.2, distance * 0.45);
    focusTarget.set(target[0], target[1], target[2]);
    focusPosition.copy(focusTarget).addScaledVector(overviewDirection, Math.max(focusDistance, distance * 0.5));
    focusActive = true;
  }

  function select(componentId, { focus = true } = {}) {
    selectedId = componentId;
    applyHighlight(componentId);
    if (componentId && focus) focusOn(componentId);
    updateDiagnostics();
    options.onSelect?.(componentId);
  }

  function clear() {
    selectedId = null;
    applyHighlight(null);
    options.onSelect?.(null);
    resetView();
  }

  function resetView() {
    focusActive = false;
    userInteracted = false;
    frameOverview();
  }

  function setMode(nextMode) {
    if (!MODES.has(nextMode) || nextMode === mode) return mode;
    mode = nextMode;
    applyMode();
    if (!userInteracted && !selectedId) frameOverview();
    updateDiagnostics();
    return mode;
  }

  function onPointerMove(event) {
    const next = pick(event);
    if (next !== hoverId) {
      hoverId = next;
      renderer.domElement.style.cursor = next ? "pointer" : "grab";
    }
  }

  function onPointerDown(event) {
    pointerDown = { x: event.clientX, y: event.clientY };
  }

  function onPointerUp(event) {
    if (!pointerDown) return;
    const dx = event.clientX - pointerDown.x;
    const dy = event.clientY - pointerDown.y;
    pointerDown = null;
    if (dx * dx + dy * dy > 25) return;
    select(pick(event));
  }

  function onDoubleClick(event) {
    const id = pick(event);
    if (id) select(id);
  }

  function updateDiagnostics() {
    const rect = renderer.domElement.getBoundingClientRect();
    window.__brainDiagnostics = {
      mode,
      selectedId,
      nodes: plan.counts.nodes,
      edges: plan.counts.edges,
      layers: plan.counts.layers,
      regions: plan.regions.length,
      synapticNodes: plan.counts.synapticNodes,
      filaments: plan.counts.filaments,
      attentionArcs: plan.counts.attentionArcs,
      ambientStars: plan.counts.ambientStars,
      ambientClusters: plan.counts.ambientClusters,
      ambientWisps: plan.counts.ambientWisps,
      decorativeObjects: plan.counts.decorativeObjects,
      effects: { ...effectSettings },
      telemetryStatus,
      regionScreens: plan.regions.map((region) => {
        const projected = new THREE.Vector3(region.position[0], region.position[1], region.position[2]).project(camera);
        return {
          index: region.blockIndex,
          x: Math.round((projected.x + 1) * 0.5 * rect.width),
          y: Math.round((1 - projected.y) * 0.5 * rect.height),
        };
      }),
      bounds: plan.bounds,
      camera: {
        position: camera.position.toArray(),
        target: controls.target.toArray(),
        near: camera.near,
        far: camera.far,
        fov: camera.fov,
        overviewDistance,
      },
      canvas: {
        width: rect.width,
        height: rect.height,
        pixelWidth: renderer.domElement.width,
        pixelHeight: renderer.domElement.height,
      },
      render: {
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        points: renderer.info.render.points,
        lines: renderer.info.render.lines,
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
      },
      warnings: plan.warnings,
    };
  }

  renderer.domElement.addEventListener("pointermove", onPointerMove);
  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  renderer.domElement.addEventListener("pointerup", onPointerUp);
  renderer.domElement.addEventListener("dblclick", onDoubleClick);
  renderer.domElement.style.cursor = "grab";
  controls.addEventListener("start", () => {
    userInteracted = true;
  });

  const resize = () => {
    const width = Math.max(container.clientWidth, 1);
    const height = Math.max(container.clientHeight, 1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (structuralLineMaterial) structuralLineMaterial.resolution.set(width, height);
    if (filamentLineMaterial) filamentLineMaterial.resolution.set(width, height);
    if (!userInteracted && !selectedId) frameOverview();
    updateDiagnostics();
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
  window.addEventListener("resize", resize);
  resize();

  applyMode();
  applyHighlight(null);

  let previousFrameAt = performance.now();
  let simTime = 0;
  const animate = (now = performance.now()) => {
    if (disposed) return;
    frame = requestAnimationFrame(animate);
    const dt = Math.min(0.05, Math.max(0, (now - previousFrameAt) / 1000));
    previousFrameAt = now;
    simTime += dt * motion.speed;
    if (focusActive) {
      camera.position.lerp(focusPosition, 0.075);
      controls.target.lerp(focusTarget, 0.09);
      if (camera.position.distanceToSquared(focusPosition) < 0.02) focusActive = false;
    }
    updateMood(dt);
    updateAmbient(simTime, dt, motion);
    updateAttention(simTime, dt, motion);
    updateRegionPulse(simTime, motion, dt);
    updateActivity(now, dt);
    controls.update();
    renderer.render(scene, camera);
  };
  animate();

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frame);
    resizeObserver.disconnect();
    window.removeEventListener("resize", resize);
    renderer.domElement.removeEventListener("pointermove", onPointerMove);
    renderer.domElement.removeEventListener("pointerdown", onPointerDown);
    renderer.domElement.removeEventListener("pointerup", onPointerUp);
    renderer.domElement.removeEventListener("dblclick", onDoubleClick);
    controls.dispose();
    disposeObject(root);
    disposeObject(activityGroup);
    activityGroup.removeFromParent();
    disposeObject(selectionHalo);
    disposeObject(selectionShell);
    for (const material of Object.values(structuralMaterials)) material.dispose();
    for (const texture of labelTextures) texture.dispose();
    scene.environment = null;
    environmentTarget.dispose();
    glowTexture.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  }

  return {
    plan,
    select,
    clear,
    resetView,
    setMode,
    notifyActivity,
    setActivityEnabled,
    setLayerActivity,
    setLayerActivityEnabled,
    setEffectSettings,
    setTelemetryStatus,
    dispose,
    get activityEnabled() {
      return activityEnabled;
    },
    get effectSettings() {
      return { ...effectSettings };
    },
    get telemetryStatus() {
      return telemetryStatus;
    },
    get layerActivityEnabled() {
      return layerActivityEnabled;
    },
    get selectedId() {
      return selectedId;
    },
    get hoverId() {
      return hoverId;
    },
    get mode() {
      return mode;
    },
    focusOn,
  };
}
