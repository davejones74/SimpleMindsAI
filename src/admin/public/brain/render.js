import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { highlightFor } from "./schema.js";
import { buildRenderPlan } from "./layout.js";

const GEOMETRY_BUILDERS = {
  ring: () => new THREE.TorusGeometry(1, 0.045, 8, 80),
  sphere: () => new THREE.IcosahedronGeometry(1, 2),
  octa: () => new THREE.OctahedronGeometry(1, 0),
  box: () => new THREE.BoxGeometry(1, 1, 1),
};

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
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05080d);
  scene.fog = new THREE.FogExp2(0x05080d, 0.0016);

  const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 8000);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

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

  const overviewDirection = new THREE.Vector3(1.35, 0.9, 1).normalize();
  const overviewTarget = new THREE.Vector3(...plan.bounds.center);
  const overviewPosition = overviewTarget.clone().addScaledVector(overviewDirection, plan.bounds.radius * 2.15);
  camera.position.copy(overviewPosition);
  camera.lookAt(overviewTarget);

  const ambient = new THREE.HemisphereLight(0x93c5fd, 0x0b1220, 1.1);
  scene.add(ambient);
  const key = new THREE.DirectionalLight(0x93c5fd, 1.4);
  key.position.set(1, 2, 1);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xa78bfa, 1.1);
  rim.position.set(-1, -0.6, -1);
  scene.add(rim);

  const group = new THREE.Group();
  scene.add(group);

  const glowTexture = makeGlowTexture();
  const nodeMeshes = [];
  const material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.96 });
  const byGeometry = new Map();
  for (const node of plan.nodes) {
    if (!byGeometry.has(node.group)) byGeometry.set(node.group, []);
    byGeometry.get(node.group).push(node);
  }

  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  const nodeInstances = [];
  for (const [geometryName, nodes] of byGeometry) {
    const geometry = (GEOMETRY_BUILDERS[geometryName] ?? GEOMETRY_BUILDERS.sphere)();
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
    size: 1.7,
    map: glowTexture,
    transparent: true,
    opacity: 0.6,
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
    opacity: 0.52,
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
    edgeMaterial.opacity = highlight ? 0.85 : 0.52;

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
    glowMaterial.opacity = highlight ? 0.4 : 0.6;
  }

  function positionFromEvent(event) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  function pick(event) {
    if (!nodeMeshes.length) return null;
    positionFromEvent(event);
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(nodeMeshes, false);
    if (!hits.length) return null;
    const hit = hits[0];
    return hit.object.userData.componentIds?.[hit.instanceId] ?? null;
  }

  function focusOn(componentId) {
    const node = plan.nodes.find((item) => item.id === componentId);
    if (!node) return;
    const distance = node.group === "ring"
      ? plan.bounds.radius * 0.95
      : Math.max(8, plan.bounds.radius * 0.42);
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
    controls.target.copy(overviewTarget);
    camera.position.copy(overviewPosition);
    controls.update();
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

  const resize = () => {
    const width = Math.max(container.clientWidth, 1);
    const height = Math.max(container.clientHeight, 1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
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
    renderer.domElement.removeEventListener("pointermove", onPointerMove);
    renderer.domElement.removeEventListener("pointerdown", onPointerDown);
    renderer.domElement.removeEventListener("pointerup", onPointerUp);
    renderer.domElement.removeEventListener("dblclick", onDoubleClick);
    controls.dispose();
    for (const mesh of nodeMeshes) mesh.geometry.dispose();
    material.dispose();
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
