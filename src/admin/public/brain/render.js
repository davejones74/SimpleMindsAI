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

function makeLabelTexture(text) {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, 128, 64);
  context.font = "600 34px system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = "rgba(214, 231, 248, 0.92)";
  context.fillText(String(text), 64, 34);
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
  const initialAspect = Math.max(
    (container.clientWidth || 1) / (container.clientHeight || 1),
    0.4,
  );
  const plan = buildRenderPlan(blueprint, {
    ...options,
    targetAspect: Math.min(Math.max(initialAspect, 0.8), 2.4),
  });
  console.info("[brain] render plan", {
    nodes: plan.counts.nodes,
    edges: plan.counts.edges,
    layers: plan.counts.layers,
    blocks: plan.blocks.length,
    bounds: plan.bounds,
    warnings: plan.warnings,
  });

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05080d);
  scene.fog = new THREE.FogExp2(0x05080d, 0.0012);

  const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 8000);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.screenSpacePanning = true;
  controls.rotateSpeed = 0.62;
  controls.zoomSpeed = 0.85;
  controls.panSpeed = 0.75;
  controls.minDistance = Math.max(2, plan.bounds.radius * 0.1);
  controls.maxDistance = Math.max(80, plan.bounds.radius * 7);
  controls.target.set(...plan.bounds.center);

  const overviewDirection = new THREE.Vector3(0.3, 0.2, 1.0).normalize();
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
    controls.minDistance = Math.max(1, overviewDistance * 0.06);
    controls.maxDistance = Math.max(80, overviewDistance * 5);
    controls.update();
  }

  function updateDiagnostics() {
    const rect = renderer.domElement.getBoundingClientRect();
    window.__brainDiagnostics = {
      nodes: plan.counts.nodes,
      edges: plan.counts.edges,
      layers: plan.counts.layers,
      blocks: plan.blocks.length,
      blockScreens: plan.blocks.map((block) => {
        const projected = new THREE.Vector3(block.position[0], block.position[1], block.position[2]).project(camera);
        return {
          index: block.blockIndex,
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

  const ambient = new THREE.HemisphereLight(0x9ec7f5, 0x0b1220, 1.05);
  scene.add(ambient);
  const key = new THREE.DirectionalLight(0x93c5fd, 1.3);
  key.position.set(1, 2, 1.4);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xa78bfa, 0.9);
  rim.position.set(-1, -0.5, -1.2);
  scene.add(rim);

  const group = new THREE.Group();
  scene.add(group);

  const glowTexture = makeGlowTexture();

  // ------------------------------------------------------------ block shells
  const blockShellMaterial = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.055,
    depthWrite: false,
    side: THREE.BackSide,
  });
  const blockEdgeMaterial = new THREE.LineBasicMaterial({
    transparent: true,
    opacity: 0.16,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const blockShells = [];
  const blockEdges = [];
  const blockLabelSprites = [];
  for (const block of plan.blocks) {
    const geometry = new THREE.BoxGeometry(block.size[0], block.size[1], block.size[2]);
    const shell = new THREE.Mesh(geometry, blockShellMaterial.clone());
    shell.position.set(block.position[0], block.position[1], block.position[2]);
    shell.userData.componentId = block.id;
    shell.userData.blockIndex = block.blockIndex;
    shell.userData.baseColor = new THREE.Color(block.color);
    shell.material.color.copy(shell.userData.baseColor);
    group.add(shell);
    blockShells.push(shell);

    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), blockEdgeMaterial.clone());
    edge.position.copy(shell.position);
    edge.userData.componentId = block.id;
    edge.userData.blockIndex = block.blockIndex;
    edge.userData.baseColor = new THREE.Color(block.color);
    edge.material.color.copy(edge.userData.baseColor);
    group.add(edge);
    blockEdges.push(edge);

    const label = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeLabelTexture(block.blockIndex),
      transparent: true,
      opacity: 0.62,
      depthTest: false,
      depthWrite: false,
    }));
    label.position.set(block.position[0], block.position[1] + block.size[1] * 0.5 + 1.2, block.position[2]);
    label.scale.set(2.4, 1.2, 1);
    label.userData.componentId = block.id;
    label.renderOrder = 4;
    group.add(label);
    blockLabelSprites.push(label);
  }

  // ------------------------------------------------------------ node meshes
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
  const pickTargets = [...nodeMeshes, ...blockShells];

  // ------------------------------------------------------------ glow points
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
    size: 1.35,
    map: glowTexture,
    transparent: true,
    opacity: 0.42,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const glowPoints = new THREE.Points(glowGeometry, glowMaterial);
  glowPoints.renderOrder = 2;
  group.add(glowPoints);

  // ------------------------------------------------------------ edges
  const edgePositions = new Float32Array(plan.edges.length * 6);
  const edgeColors = new Float32Array(plan.edges.length * 6);
  const edgeBaseColors = [];
  const edgeAlpha = [];
  plan.edges.forEach((edge, index) => {
    edgePositions.set(edge.points[0], index * 6);
    edgePositions.set(edge.points[1], index * 6 + 3);
    const rgb = colorToRgb(edge.color);
    edgeBaseColors.push(rgb);
    edgeColors.set([rgb[0], rgb[1], rgb[2], rgb[0], rgb[1], rgb[2]], index * 6);
    edgeAlpha.push(edge.type === "positional_encoding" ? 0.22 : edge.type === "residual" ? 0.34 : 0.5);
  });
  const edgeGeometry = new THREE.BufferGeometry();
  edgeGeometry.setAttribute("position", new THREE.BufferAttribute(edgePositions, 3));
  edgeGeometry.setAttribute("color", new THREE.BufferAttribute(edgeColors, 3));
  const edgeMaterial = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.5,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const edgeLines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
  edgeLines.renderOrder = 1;
  group.add(edgeLines);

  // ------------------------------------------------------------ ambient dust
  const particleCount = 900;
  const particlePositions = new Float32Array(particleCount * 3);
  const particleColors = new Float32Array(particleCount * 3);
  const random = seededRandom(0x51a1);
  const span = plan.bounds.radius * 2.6;
  for (let index = 0; index < particleCount; index += 1) {
    const theta = random() * Math.PI * 2;
    const phi = Math.acos(2 * random() - 1);
    const radius = plan.bounds.radius * (0.5 + random() * 1.3);
    particlePositions[index * 3] = plan.bounds.center[0] + radius * Math.sin(phi) * Math.cos(theta);
    particlePositions[index * 3 + 1] = plan.bounds.center[1] + radius * Math.cos(phi);
    particlePositions[index * 3 + 2] = plan.bounds.center[2] + radius * Math.sin(phi) * Math.sin(theta);
    const tint = 0.16 + random() * 0.26;
    particleColors[index * 3] = tint * 0.45;
    particleColors[index * 3 + 1] = tint * 0.7;
    particleColors[index * 3 + 2] = tint;
  }
  const particleGeometry = new THREE.BufferGeometry();
  particleGeometry.setAttribute("position", new THREE.BufferAttribute(particlePositions, 3));
  particleGeometry.setAttribute("color", new THREE.BufferAttribute(particleColors, 3));
  const particleMaterial = new THREE.PointsMaterial({
    size: 0.045,
    transparent: true,
    opacity: 0.4,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const particles = new THREE.Points(particleGeometry, particleMaterial);
  particles.frustumCulled = false;
  scene.add(particles);

  // ------------------------------------------------------------ interaction
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

  const selectedColor = new THREE.Color(0xf5fbff);
  const dimFactor = 0.32;

  function applyHighlight(componentId) {
    const highlight = componentId ? highlightFor(blueprint, componentId) : null;
    for (const item of nodeInstances) {
      let rgb = item.base;
      if (highlight) {
        if (item.node.id === componentId) {
          const white = selectedColor;
          rgb = [white.r, white.g, white.b];
        } else if (highlight.componentIds.has(item.node.id)) {
          rgb = [item.base[0] * 1.05, item.base[1] * 1.05, item.base[2] * 1.05];
        } else {
          rgb = [item.base[0] * dimFactor, item.base[1] * dimFactor, item.base[2] * dimFactor];
        }
      }
      item.mesh.setColorAt(item.index, color.setRGB(rgb[0], rgb[1], rgb[2]));
    }
    for (const mesh of nodeMeshes) mesh.instanceColor.needsUpdate = true;

    for (const shell of blockShells) {
      const isSelected = shell.userData.componentId === componentId;
      const isRelevant = highlight?.componentIds.has(shell.userData.componentId) ?? true;
      shell.material.color.copy(shell.userData.baseColor);
      if (isSelected) shell.material.color.lerp(selectedColor, 0.55);
      else if (highlight && !isRelevant) shell.material.color.multiplyScalar(dimFactor);
      shell.material.opacity = highlight ? (isRelevant ? 0.14 : 0.02) : 0.055;
    }
    for (const edgeLine of blockEdges) {
      const isSelected = edgeLine.userData.componentId === componentId;
      const isRelevant = highlight?.componentIds.has(edgeLine.userData.componentId) ?? true;
      edgeLine.material.color.copy(edgeLine.userData.baseColor);
      if (isSelected) edgeLine.material.color.lerp(selectedColor, 0.7);
      else if (highlight && !isRelevant) edgeLine.material.color.multiplyScalar(dimFactor);
      edgeLine.material.opacity = highlight ? (isRelevant ? 0.34 : 0.03) : 0.16;
    }
    for (const label of blockLabelSprites) {
      const isRelevant = highlight?.componentIds.has(label.userData.componentId) ?? true;
      label.material.opacity = highlight && !isRelevant ? 0.12 : 0.62;
    }

    const edgeAttr = edgeGeometry.getAttribute("color");
    plan.edges.forEach((edge, index) => {
      let rgb = edgeBaseColors[index];
      if (highlight) {
        if (highlight.connectionIds.has(edge.id)) {
          rgb = [Math.min(1, rgb[0] * 2.1 + 0.15), Math.min(1, rgb[1] * 2.1 + 0.15), Math.min(1, rgb[2] * 2.1 + 0.15)];
        } else {
          rgb = [rgb[0] * 0.14, rgb[1] * 0.14, rgb[2] * 0.14];
        }
      }
      edgeAttr.setXYZ(index * 2, rgb[0], rgb[1], rgb[2]);
      edgeAttr.setXYZ(index * 2 + 1, rgb[0], rgb[1], rgb[2]);
    });
    edgeAttr.needsUpdate = true;
    edgeMaterial.opacity = highlight ? 0.9 : 0.5;

    const glowAttr = glowGeometry.getAttribute("color");
    plan.nodes.forEach((node, index) => {
      let rgb = glowBaseColors[index];
      if (highlight) {
        if (node.id === componentId) rgb = [1, 1, 1];
        else if (highlight.componentIds.has(node.id)) rgb = [rgb[0] * 1.1, rgb[1] * 1.1, rgb[2] * 1.1];
        else rgb = [rgb[0] * 0.22, rgb[1] * 0.22, rgb[2] * 0.22];
      }
      glowAttr.setXYZ(index, rgb[0], rgb[1], rgb[2]);
    });
    glowAttr.needsUpdate = true;
    glowMaterial.opacity = highlight ? 0.4 : 0.42;
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
    if (hits.length) {
      const hit = hits[0];
      const componentId = hit.object.userData.componentIds?.[hit.instanceId] ?? hit.object.userData.componentId ?? null;
      if (componentId) return componentId;
    }
    return null;
  }

  function focusOn(componentId) {
    const node = plan.nodes.find((item) => item.id === componentId);
    const block = plan.blocks.find((item) => item.id === componentId);
    if (!node && !block) return;
    userInteracted = true;
    const target = node?.position ?? block.position;
    const extent = block ? Math.hypot(block.size[0], block.size[1], block.size[2]) * 0.5 : Math.max(3, node.scale * 6);
    const distance = block ? overviewDistance * 0.34 : Math.max(6, overviewDistance * 0.12);
    const focusDistance = Math.max(extent * 1.4, distance * 0.4);
    focusTarget.set(target[0], target[1], target[2]);
    focusPosition.copy(focusTarget).addScaledVector(overviewDirection, Math.max(focusDistance, distance * 0.5));
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
    for (const shell of blockShells) shell.geometry.dispose();
    for (const edgeLine of blockEdges) edgeLine.geometry.dispose();
    for (const label of blockLabelSprites) label.material.map?.dispose();
    material.dispose();
    blockShellMaterial.dispose();
    blockEdgeMaterial.dispose();
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
