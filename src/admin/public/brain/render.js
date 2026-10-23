import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { highlightFor } from "./schema.js";
import { buildRenderPlan } from "./layout.js";
import { fitCamera } from "./framing.js";

const MODES = new Set(["brain", "architecture"]);

const GEOMETRY_BUILDERS = {
  sphere: () => new THREE.IcosahedronGeometry(1, 1),
  octa: () => new THREE.OctahedronGeometry(1, 1),
};

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

export function createBrainScene(container, blueprint, options = {}) {
  if (!window.WebGLRenderingContext) throw new Error("WebGL is not available in this browser");
  const plan = buildRenderPlan(blueprint, options);
  const initialMode = MODES.has(options.initialMode) ? options.initialMode : "brain";
  console.info("[brain] render plan", {
    nodes: plan.counts.nodes,
    edges: plan.counts.edges,
    layers: plan.counts.layers,
    regions: plan.regions.length,
    synapticNodes: plan.counts.synapticNodes,
    filaments: plan.counts.filaments,
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

  // Large, very faint camera-facing glows sit behind the structure. They give
  // the volume an atmospheric gradient without a full-screen post effect.
  const atmosphereGroup = new THREE.Group();
  root.add(atmosphereGroup);
  const atmosphereSpecs = [
    { color: 0x1d4ed8, opacity: 0.055, scale: plan.bounds.radius * 2.7, offset: [0, 0, -plan.bounds.radius * 0.55] },
    { color: 0x6d28d9, opacity: 0.04, scale: plan.bounds.radius * 2.15, offset: [-plan.bounds.radius * 0.45, plan.bounds.radius * 0.18, plan.bounds.radius * 0.35] },
    { color: 0x0891b2, opacity: 0.05, scale: plan.bounds.radius * 1.9, offset: [plan.bounds.radius * 0.42, -plan.bounds.radius * 0.14, -plan.bounds.radius * 0.25] },
    { color: 0x67e8f9, opacity: 0.035, scale: plan.bounds.radius * 1.15, offset: [0, 0, 0] },
  ];
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
  plan.regions.forEach((region, index) => {
    regionHaloPositions[index * 3] = region.position[0];
    regionHaloPositions[index * 3 + 1] = region.position[1];
    regionHaloPositions[index * 3 + 2] = region.position[2];
    const rgb = colorToRgb(region.color);
    regionHaloColors[index * 3] = rgb[0] * 0.75;
    regionHaloColors[index * 3 + 1] = rgb[1] * 0.75;
    regionHaloColors[index * 3 + 2] = rgb[2] * 0.75;
  });
  const regionHaloGeometry = new THREE.BufferGeometry();
  regionHaloGeometry.setAttribute("position", new THREE.BufferAttribute(regionHaloPositions, 3));
  regionHaloGeometry.setAttribute("color", new THREE.BufferAttribute(regionHaloColors, 3));
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
    opacity: 0.78,
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
    opacity: 0.32,
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
      opacity: 0.52,
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

  // ---------------------------------------------------------- ambient dust
  const dustCount = 1300;
  const dustPositions = new Float32Array(dustCount * 3);
  const dustColors = new Float32Array(dustCount * 3);
  const dustRandom = seededRandom(0x0d0577);
  for (let index = 0; index < dustCount; index += 1) {
    const theta = dustRandom() * Math.PI * 2;
    const phi = Math.acos(2 * dustRandom() - 1);
    const radius = plan.bounds.radius * (1.05 + dustRandom() * 1.7);
    dustPositions[index * 3] = plan.bounds.center[0] + radius * Math.sin(phi) * Math.cos(theta);
    dustPositions[index * 3 + 1] = plan.bounds.center[1] + radius * Math.cos(phi);
    dustPositions[index * 3 + 2] = plan.bounds.center[2] + radius * Math.sin(phi) * Math.sin(theta);
    const tint = 0.08 + dustRandom() * 0.18;
    dustColors[index * 3] = tint * (0.4 + dustRandom() * 0.35);
    dustColors[index * 3 + 1] = tint * (0.7 + dustRandom() * 0.3);
    dustColors[index * 3 + 2] = tint;
  }
  const dustGeometry = new THREE.BufferGeometry();
  dustGeometry.setAttribute("position", new THREE.BufferAttribute(dustPositions, 3));
  dustGeometry.setAttribute("color", new THREE.BufferAttribute(dustColors, 3));
  const dustMaterial = new THREE.PointsMaterial({
    size: Math.max(0.035, plan.bounds.radius * 0.0035),
    transparent: true,
    opacity: 0.42,
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
      filamentLineMaterial.opacity = highlight ? 0.14 : 0.52;
    }
    synapticMaterial.opacity = highlight ? 0.5 : 0.8;
    synapticGlowMaterial.opacity = highlight ? 0.2 : 0.32;
    glowMaterial.opacity = highlight ? (brain ? 0.34 : 0.26) : (brain ? 0.42 : 0.3);
    regionHaloMaterial.opacity = highlight ? 0.09 : 0.2;

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
    synapticGroup.visible = brain;
    dust.visible = brain;
    regionHalo.visible = brain;
    atmosphereGroup.visible = brain;
    architectureGroup.visible = !brain;
    if (regionRingMaterial) regionRingMaterial.opacity = brain ? 0.26 : 0.45;
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

  const animate = () => {
    if (disposed) return;
    frame = requestAnimationFrame(animate);
    if (focusActive) {
      camera.position.lerp(focusPosition, 0.075);
      controls.target.lerp(focusTarget, 0.09);
      if (camera.position.distanceToSquared(focusPosition) < 0.02) focusActive = false;
    }
    dust.rotation.y += 0.000035;
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
    disposeObject(selectionHalo);
    disposeObject(selectionShell);
    for (const material of Object.values(structuralMaterials)) material.dispose();
    for (const texture of labelTextures) texture.dispose();
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
    dispose,
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
