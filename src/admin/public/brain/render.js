import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { highlightFor } from "./schema.js";
import { buildRenderPlan } from "./layout.js";
import { fitCamera } from "./framing.js";

const GEOMETRY_BUILDERS = {
  sphere: () => new THREE.IcosahedronGeometry(1, 2),
  octa: () => new THREE.OctahedronGeometry(1, 0),
  box: () => new THREE.BoxGeometry(1, 1, 1),
};

/**
 * Three restrained finishes, chosen by node silhouette rather than by model
 * semantics. They describe an art direction (polished, satin, ceramic), not a
 * measured property of the network.
 */
const NODE_FINISHES = {
  sphere: { roughness: 0.24, metalness: 0.62, envMapIntensity: 1.15 },
  box: { roughness: 0.42, metalness: 0.44, envMapIntensity: 0.95 },
  octa: { roughness: 0.56, metalness: 0.14, envMapIntensity: 0.8 },
};
const FALLBACK_FINISH = { roughness: 0.4, metalness: 0.3, envMapIntensity: 0.9 };

/**
 * A tiny procedural equirectangular studio, generated once. It gives every
 * metallic surface a plausible reflection without loading an HDR file or
 * adding a second render pass. The highlights are deliberately cool, violet
 * and cyan so reflections reinforce the existing palette.
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

function makeRingTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext("2d");
  context.translate(128, 128);
  context.strokeStyle = "rgba(255,255,255,1)";
  context.shadowColor = "rgba(255,255,255,0.8)";
  context.shadowBlur = 6;
  context.lineWidth = 3;
  context.beginPath();
  context.arc(0, 0, 102, 0, Math.PI * 2);
  context.stroke();
  context.shadowBlur = 0;
  context.globalAlpha = 0.28;
  context.lineWidth = 1.4;
  context.beginPath();
  context.arc(0, 0, 84, 0, Math.PI * 2);
  context.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeGlowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.25, "rgba(255,255,255,0.65)");
  gradient.addColorStop(0.65, "rgba(255,255,255,0.16)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
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

export function createBrainScene(container, blueprint, options = {}) {
  if (!window.WebGLRenderingContext) throw new Error("WebGL is not available in this browser");
  const plan = buildRenderPlan(blueprint, options);
  console.info("[brain] render plan", {
    nodes: plan.counts.nodes,
    edges: plan.counts.edges,
    layers: plan.counts.layers,
    bounds: plan.bounds,
    warnings: plan.warnings,
  });
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05080d);
  scene.fog = new THREE.FogExp2(0x05080d, 0.0016);

  const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 8000);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
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
  controls.dampingFactor = 0.065;
  controls.screenSpacePanning = true;
  controls.rotateSpeed = 0.68;
  controls.zoomSpeed = 0.9;
  controls.panSpeed = 0.8;
  controls.minDistance = Math.max(2, plan.bounds.radius * 0.12);
  controls.maxDistance = Math.max(80, plan.bounds.radius * 7);
  controls.target.set(...plan.bounds.center);

  const overviewDirection = new THREE.Vector3(1.3, 0.65, 1.0).normalize();
  const overviewPosition = new THREE.Vector3();
  let overviewDistance = plan.bounds.radius * 2.15;
  let userInteracted = false;

  function frameOverview() {
    const fit = fitCamera(plan.bounds, {
      direction: overviewDirection.toArray(),
      fovDeg: camera.fov,
      aspect: camera.aspect,
    });
    overviewDistance = fit.distance;
    overviewPosition.set(...fit.position);
    camera.position.copy(overviewPosition);
    camera.near = fit.near;
    camera.far = fit.far;
    camera.updateProjectionMatrix();
    controls.target.set(...fit.center);
    controls.minDistance = Math.max(1, overviewDistance * 0.08);
    controls.maxDistance = Math.max(80, overviewDistance * 5);
    controls.update();
  }

  function updateDiagnostics() {
    const rect = renderer.domElement.getBoundingClientRect();
    window.__brainDiagnostics = {
      nodes: plan.counts.nodes,
      edges: plan.counts.edges,
      layers: plan.counts.layers,
      blocks: plan.layerRings.length,
      blockScreens: plan.layerRings.map((ring) => {
        const projected = new THREE.Vector3(ring.position[0], ring.position[1], ring.position[2]).project(camera);
        return {
          index: ring.blockIndex,
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
      canvas: { width: rect.width, height: rect.height, pixelWidth: renderer.domElement.width, pixelHeight: renderer.domElement.height },
      warnings: plan.warnings,
    };
  }

  const ambient = new THREE.HemisphereLight(0x8fb7ff, 0x070b12, 0.7);
  scene.add(ambient);
  const key = new THREE.DirectionalLight(0xdce9ff, 2.4);
  key.position.set(1.2, 2.2, 1.4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x9f8cff, 1.9);
  rim.position.set(-1.4, 0.4, -1.6);
  scene.add(rim);
  const fill = new THREE.DirectionalLight(0x5eead4, 0.5);
  fill.position.set(-0.6, -1.2, 1.2);
  scene.add(fill);

  const group = new THREE.Group();
  scene.add(group);

  const glowTexture = makeGlowTexture();
  const nodeMeshes = [];
  const nodeMaterials = new Map();
  const byGeometry = new Map();
  for (const node of plan.nodes) {
    if (node.group === "ring") continue;
    if (!byGeometry.has(node.group)) byGeometry.set(node.group, []);
    byGeometry.get(node.group).push(node);
  }

  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  const nodeInstances = [];
  for (const [geometryName, nodes] of byGeometry) {
    const geometry = (GEOMETRY_BUILDERS[geometryName] ?? GEOMETRY_BUILDERS.sphere)();
    const finish = NODE_FINISHES[geometryName] ?? FALLBACK_FINISH;
    const material = new THREE.MeshStandardMaterial({
      roughness: finish.roughness,
      metalness: finish.metalness,
      envMapIntensity: finish.envMapIntensity,
    });
    nodeMaterials.set(geometryName, material);
    const mesh = new THREE.InstancedMesh(geometry, material, nodes.length);
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    mesh.userData.componentIds = nodes.map((node) => node.id);
    mesh.userData.geometryName = geometryName;
    nodes.forEach((node, index) => {
      const scale = node.scale3 ?? [node.scale, node.scale, node.scale];
      dummy.position.set(node.position[0], node.position[1], node.position[2]);
      dummy.scale.set(scale[0], scale[1], scale[2]);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
      const rgb = colorToRgb(node.color);
      mesh.setColorAt(index, color.setRGB(rgb[0], rgb[1], rgb[2]));
      nodeInstances.push({ node, mesh, index, base: rgb });
    });
    mesh.instanceColor.needsUpdate = true;
    mesh.instanceMatrix.needsUpdate = true;
    group.add(mesh);
    nodeMeshes.push(mesh);
  }

  const ringTexture = makeRingTexture();
  const blockSprites = [];
  for (const ring of plan.layerRings) {
    const spriteMaterial = new THREE.SpriteMaterial({
      map: ringTexture,
      color: new THREE.Color(ring.color),
      transparent: true,
      opacity: 0.46,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const sprite = new THREE.Sprite(spriteMaterial);
    sprite.position.set(ring.position[0], ring.position[1], ring.position[2]);
    const size = ring.radius * 2.2;
    sprite.scale.set(size, size, 1);
    sprite.userData.componentId = ring.id;
    sprite.userData.blockIndex = ring.blockIndex;
    sprite.userData.baseColor = new THREE.Color(ring.color);
    sprite.renderOrder = 0;
    group.add(sprite);
    blockSprites.push(sprite);
  }
  const pickTargets = [...nodeMeshes];

  const glowPositions = new Float32Array(plan.nodes.length * 3);
  const glowColors = new Float32Array(plan.nodes.length * 3);
  plan.nodes.forEach((node, index) => {
    glowPositions[index * 3] = node.position[0];
    glowPositions[index * 3 + 1] = node.position[1];
    glowPositions[index * 3 + 2] = node.position[2];
    const rgb = colorToRgb(node.color);
    glowColors[index * 3] = rgb[0];
    glowColors[index * 3 + 1] = rgb[1];
    glowColors[index * 3 + 2] = rgb[2];
  });
  const glowGeometry = new THREE.BufferGeometry();
  glowGeometry.setAttribute("position", new THREE.BufferAttribute(glowPositions, 3));
  glowGeometry.setAttribute("color", new THREE.BufferAttribute(glowColors, 3));
  const glowMaterial = new THREE.PointsMaterial({
    size: 1.35,
    map: glowTexture,
    transparent: true,
    opacity: 0.34,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const glowPoints = new THREE.Points(glowGeometry, glowMaterial);
  glowPoints.renderOrder = 2;
  group.add(glowPoints);

  const edgePositions = new Float32Array(plan.edges.length * 6);
  const edgeColors = new Float32Array(plan.edges.length * 6);
  const edgeBaseColors = [];
  plan.edges.forEach((edge, index) => {
    edgePositions.set(edge.points[0], index * 6);
    edgePositions.set(edge.points[1], index * 6 + 3);
    const rgb = colorToRgb(edge.color);
    edgeBaseColors.push(rgb);
    edgeColors.set([rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2]], index * 6);
  });
  const edgeGeometry = new THREE.BufferGeometry();
  edgeGeometry.setAttribute("position", new THREE.BufferAttribute(edgePositions, 3));
  edgeGeometry.setAttribute("color", new THREE.BufferAttribute(edgeColors, 3));
  const edgeMaterial = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.34,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const edgeLines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
  edgeLines.renderOrder = 1;
  group.add(edgeLines);

  const particleCount = 1400;
  const particlePositions = new Float32Array(particleCount * 3);
  const particleColors = new Float32Array(particleCount * 3);
  const random = seededRandom(0x51a1);
  const span = plan.bounds.radius * 2.8;
  for (let index = 0; index < particleCount; index += 1) {
    const theta = random() * Math.PI * 2;
    const phi = Math.acos(2 * random() - 1);
    const radius = plan.bounds.radius * (0.55 + random() * 1.5);
    particlePositions[index * 3] = plan.bounds.center[0] + radius * Math.sin(phi) * Math.cos(theta);
    particlePositions[index * 3 + 1] = plan.bounds.center[1] + radius * Math.cos(phi);
    particlePositions[index * 3 + 2] = plan.bounds.center[2] + radius * Math.sin(phi) * Math.sin(theta);
    const tint = 0.18 + random() * 0.3;
    particleColors[index * 3] = tint * 0.45;
    particleColors[index * 3 + 1] = tint * 0.7;
    particleColors[index * 3 + 2] = tint;
  }
  const particleGeometry = new THREE.BufferGeometry();
  particleGeometry.setAttribute("position", new THREE.BufferAttribute(particlePositions, 3));
  particleGeometry.setAttribute("color", new THREE.BufferAttribute(particleColors, 3));
  const particleMaterial = new THREE.PointsMaterial({
    size: 0.055,
    transparent: true,
    opacity: 0.5,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const particles = new THREE.Points(particleGeometry, particleMaterial);
  particles.frustumCulled = false;
  scene.add(particles);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const focusTarget = new THREE.Vector3();
  const focusPosition = new THREE.Vector3();
  let focusActive = false;
  let selectedId = null;
  let hoverId = null;
  let disposed = false;
  let pointerDown = null;
  let frame = 0;

  const selectedColor = new THREE.Color(0xffffff);
  const dimFactor = 0.18;

  function applyHighlight(componentId) {
    const highlight = componentId ? highlightFor(blueprint, componentId) : null;
    for (const item of nodeInstances) {
      let rgb = item.base;
      if (highlight) {
        if (item.node.id === componentId) {
          const white = selectedColor;
          rgb = [white.r, white.g, white.b];
        } else if (!highlight.componentIds.has(item.node.id)) {
          rgb = [item.base[0] * dimFactor, item.base[1] * dimFactor, item.base[2] * dimFactor];
        }
      }
      item.mesh.setColorAt(item.index, color.setRGB(rgb[0], rgb[1], rgb[2]));
    }
    for (const mesh of nodeMeshes) mesh.instanceColor.needsUpdate = true;

    for (const sprite of blockSprites) {
      const isSelected = sprite.userData.componentId === componentId;
      const isRelevant = highlight?.componentIds.has(sprite.userData.componentId) ?? true;
      sprite.material.color.copy(sprite.userData.baseColor);
      if (isSelected) sprite.material.color.copy(selectedColor);
      else if (highlight && !isRelevant) sprite.material.color.multiplyScalar(dimFactor);
      sprite.material.opacity = highlight ? (isRelevant ? 0.82 : 0.12) : 0.46;
    }

    const edgeAttr = edgeGeometry.getAttribute("color");
    plan.edges.forEach((edge, index) => {
      let rgb = edgeBaseColors[index];
      if (highlight) {
        if (highlight.connectionIds.has(edge.id)) {
          rgb = [Math.min(1, rgb[0] * 2.4 + 0.12), Math.min(1, rgb[1] * 2.4 + 0.12), Math.min(1, rgb[2] * 2.4 + 0.12)];
        } else {
          rgb = [rgb[0] * 0.14, rgb[1] * 0.14, rgb[2] * 0.14];
        }
      }
      edgeAttr.setXYZ(index * 2, rgb[0], rgb[1], rgb[2]);
      edgeAttr.setXYZ(index * 2 + 1, rgb[0], rgb[1], rgb[2]);
    });
    edgeAttr.needsUpdate = true;
    edgeMaterial.opacity = highlight ? 0.78 : 0.34;

    const glowAttr = glowGeometry.getAttribute("color");
    plan.nodes.forEach((node, index) => {
      let rgb = colorToRgb(node.color);
      if (highlight) {
        if (node.id === componentId) rgb = [1, 1, 1];
        else if (!highlight.componentIds.has(node.id)) rgb = [rgb[0] * 0.2, rgb[1] * 0.2, rgb[2] * 0.2];
      }
      glowAttr.setXYZ(index, rgb[0], rgb[1], rgb[2]);
    });
    glowAttr.needsUpdate = true;
    glowMaterial.opacity = highlight ? 0.42 : 0.34;
  }

  function positionFromEvent(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    return rect;
  }

  const pickWorldCenter = new THREE.Vector3();
  const pickWorldEdge = new THREE.Vector3();
  const pickScreenCenter = new THREE.Vector3();
  const pickScreenEdge = new THREE.Vector3();
  const cameraRight = new THREE.Vector3();

  function pickBlock(event, rect) {
    const screenX = ((pointer.x + 1) * 0.5) * rect.width;
    const screenY = ((1 - pointer.y) * 0.5) * rect.height;
    cameraRight.setFromMatrixColumn(camera.matrixWorld, 0);
    for (const ring of plan.layerRings) {
      pickWorldCenter.set(ring.position[0], ring.position[1], ring.position[2]);
      pickWorldEdge.copy(pickWorldCenter).addScaledVector(cameraRight, ring.radius * 0.88);
      pickScreenCenter.copy(pickWorldCenter).project(camera);
      pickScreenEdge.copy(pickWorldEdge).project(camera);
      if (pickScreenCenter.z < -1 || pickScreenCenter.z > 1) continue;
      const cx = ((pickScreenCenter.x + 1) * 0.5) * rect.width;
      const cy = ((1 - pickScreenCenter.y) * 0.5) * rect.height;
      const ex = ((pickScreenEdge.x + 1) * 0.5) * rect.width;
      const ey = ((1 - pickScreenEdge.y) * 0.5) * rect.height;
      const radius = Math.hypot(ex - cx, ey - cy);
      const distance = Math.hypot(screenX - cx, screenY - cy);
      if (Math.abs(distance - radius) <= Math.max(7, radius * 0.18)) return ring.id;
    }
    return null;
  }

  function pick(event) {
    if (!nodeMeshes.length && !blockSprites.length) return null;
    const rect = positionFromEvent(event);
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(pickTargets, false);
    if (hits.length) {
      const hit = hits[0];
      const componentId = hit.object.userData.componentIds?.[hit.instanceId] ?? null;
      if (componentId) return componentId;
    }
    return pickBlock(event, rect);
  }

  function focusOn(componentId) {
    const node = plan.nodes.find((item) => item.id === componentId);
    if (!node) return;
    userInteracted = true;
    const distance = node.group === "ring"
      ? overviewDistance * 0.48
      : Math.max(7, overviewDistance * 0.2);
    focusTarget.set(node.position[0], node.position[1], node.position[2]);
    focusPosition.copy(focusTarget).addScaledVector(overviewDirection, distance);
    focusActive = true;
  }

  function select(componentId, { focus = true } = {}) {
    selectedId = componentId;
    applyHighlight(componentId);
    if (componentId && focus) focusOn(componentId);
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
    if (!userInteracted && !selectedId) frameOverview();
    updateDiagnostics();
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
  window.addEventListener("resize", resize);
  resize();

  const animate = () => {
    if (disposed) return;
    frame = requestAnimationFrame(animate);
    if (focusActive) {
      camera.position.lerp(focusPosition, 0.075);
      controls.target.lerp(focusTarget, 0.09);
      if (camera.position.distanceToSquared(focusPosition) < 0.02) focusActive = false;
    }
    particles.rotation.z += 0.00008;
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
    for (const mesh of nodeMeshes) mesh.geometry.dispose();
    for (const material of nodeMaterials.values()) material.dispose();
    for (const sprite of blockSprites) sprite.material.dispose();
    ringTexture.dispose();
    scene.environment = null;
    environmentTarget.dispose();
    glowGeometry.dispose();
    glowMaterial.dispose();
    glowTexture.dispose();
    edgeGeometry.dispose();
    edgeMaterial.dispose();
    particleGeometry.dispose();
    particleMaterial.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  }

  return {
    plan,
    select,
    clear,
    resetView,
    dispose,
    get selectedId() {
      return selectedId;
    },
    get hoverId() {
      return hoverId;
    },
    focusOn,
  };
}
