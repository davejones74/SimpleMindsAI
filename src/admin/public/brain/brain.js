import {
  COMPONENT_COLORS,
  blueprintSummary,
  describeSelection,
  validateBlueprint,
} from "./schema.js";
import {
  applyJobStatus,
  applyTelemetryEvent,
  chartModel,
  createTelemetryState,
  formatAge,
  formatDuration,
  formatLoss,
  formatRate,
  telemetryDisplayStatus,
  telemetryFromSnapshot,
} from "./telemetry.js";
import {
  DEFAULT_EFFECT_SETTINGS,
  effectSummary,
  normalizeEffectSettings,
  telemetryMood,
} from "./cinematic.js";

const API = "/api/admin/brain/blueprint";
const ADMIN_API = "/api/admin";
const requestedMode = new URLSearchParams(window.location.search).get("mode");
const activityPreference = (() => {
  try {
    return window.sessionStorage.getItem("sma.brain.activity") !== "off";
  } catch {
    return true;
  }
})();
const layerActivityPreference = (() => {
  try {
    return window.sessionStorage.getItem("sma.brain.layerActivity") === "on";
  } catch {
    return false;
  }
})();
const reducedMotionQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
const prefersReducedMotion = reducedMotionQuery?.matches === true;
const effectPreference = (() => {
  try {
    const raw = window.sessionStorage.getItem("sma.brain.effects");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
})();
const initialEffects = normalizeEffectSettings(effectPreference, { prefersReducedMotion });
const state = {
  blueprint: null,
  summary: null,
  scene: null,
  selectedId: null,
  mode: requestedMode === "architecture" ? "architecture" : "brain",
  telemetry: createTelemetryState(),
  telemetrySeq: 0,
  activityEnabled: activityPreference,
  layerActivityEnabled: layerActivityPreference,
  layerActivityKey: "",
  effects: initialEffects,
  displayStatus: "unavailable",
  previousDisplayStatus: null,
  liveTimer: null,
  telemetryStream: null,
};

const PANEL_NAMES = { livePanel: "live training", inspector: "inspector" };

function setPanelCollapsed(panelId, collapsed, { persist = true } = {}) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  panel.classList.toggle("collapsed", collapsed);
  const button = panel.querySelector(`[data-panel-collapse="${panelId}"]`);
  const name = PANEL_NAMES[panelId] ?? "panel";
  if (button) {
    button.setAttribute("aria-expanded", String(!collapsed));
    button.setAttribute("aria-label", `${collapsed ? "Expand" : "Collapse"} ${name}`);
    button.setAttribute("title", `${collapsed ? "Expand" : "Collapse"} ${name}`);
  }
  if (persist) {
    try {
      window.sessionStorage.setItem(`sma.brain.collapsed.${panelId}`, collapsed ? "1" : "0");
    } catch {
      // Storage may be unavailable; collapse still works for this page view.
    }
  }
}

function initPanelCollapse() {
  for (const panelId of Object.keys(PANEL_NAMES)) {
    let collapsed = false;
    try {
      collapsed = window.sessionStorage.getItem(`sma.brain.collapsed.${panelId}`) === "1";
    } catch {
      collapsed = false;
    }
    setPanelCollapsed(panelId, collapsed, { persist: false });
  }
  for (const button of document.querySelectorAll("[data-panel-collapse]")) {
    button.addEventListener("click", () => {
      const panelId = button.getAttribute("data-panel-collapse");
      const panel = document.getElementById(panelId);
      if (!panel) return;
      setPanelCollapsed(panelId, !panel.classList.contains("collapsed"));
    });
  }
}

function persistEffects() {
  try {
    window.sessionStorage.setItem("sma.brain.effects", JSON.stringify(state.effects));
  } catch {
    // Storage may be unavailable; the controls still work for this view.
  }
}

function updateEffects(patch, { persist = true } = {}) {
  state.effects = normalizeEffectSettings({ ...state.effects, ...patch }, { prefersReducedMotion });
  if (persist) persistEffects();
  state.scene?.setEffectSettings(state.effects);
  renderLivingPanel();
  if (state.blueprint) renderLegend(state.blueprint);
  return state.effects;
}

function renderLivingPanel() {
  if (!state.effects) return;
  const effects = state.effects;
  const setChecked = (id, value) => {
    const element = document.getElementById(id);
    if (element) element.checked = value === true;
  };
  const setRange = (id, value, outputId) => {
    const element = document.getElementById(id);
    if (element) element.value = String(Math.round(value * 100));
    const output = document.getElementById(outputId);
    if (output) output.textContent = `${Math.round(value * 100)}%`;
  };
  setChecked("cinematicToggle", effects.cinematic);
  setChecked("signalsToggle", effects.signals);
  setChecked("attentionToggle", effects.attention);
  setChecked("reducedMotionToggle", effects.reducedMotion);
  setRange("ambientDensity", effects.ambientDensity, "ambientDensityValue");
  setRange("animationIntensity", effects.intensity, "animationIntensityValue");
  setRange("animationSpeed", effects.speed, "animationSpeedValue");
  const mood = telemetryMood(state.displayStatus);
  const summary = document.getElementById("livingSummary");
  if (summary) {
    summary.textContent = `${effectSummary(effects)} · ${mood.label}`;
    summary.className = `living-summary mood-${mood.key}`;
  }
  const note = document.getElementById("livingNote");
  if (note) {
    note.textContent = state.displayStatus === "live"
      ? "Live telemetry paces event acknowledgements. Ambient motion remains illustrative."
      : `${mood.label}. Ambient and illustrative motion continue independently of telemetry.`;
  }
}

function wireLivingControls() {
  const toggle = document.getElementById("livingToggle");
  const panel = document.getElementById("livingPanel");
  const setPanel = (open) => {
    panel?.classList.toggle("hidden", !open);
    toggle?.setAttribute("aria-expanded", String(open));
    toggle?.classList.toggle("active", open);
  };
  toggle?.addEventListener("click", () => setPanel(panel?.classList.contains("hidden") !== false));
  document.getElementById("livingClose")?.addEventListener("click", () => setPanel(false));
  document.getElementById("cinematicToggle")?.addEventListener("change", (event) => {
    updateEffects({ cinematic: event.target.checked });
  });
  document.getElementById("signalsToggle")?.addEventListener("change", (event) => {
    updateEffects({ signals: event.target.checked });
  });
  document.getElementById("attentionToggle")?.addEventListener("change", (event) => {
    updateEffects({ attention: event.target.checked });
  });
  document.getElementById("reducedMotionToggle")?.addEventListener("change", (event) => {
    updateEffects({ reducedMotion: event.target.checked });
  });
  for (const [id, key] of [
    ["ambientDensity", "ambientDensity"],
    ["animationIntensity", "intensity"],
    ["animationSpeed", "speed"],
  ]) {
    document.getElementById(id)?.addEventListener("input", (event) => {
      updateEffects({ [key]: Number(event.target.value) / 100 });
    });
  }
  document.getElementById("livingReset")?.addEventListener("click", () => {
    try {
      window.sessionStorage.removeItem("sma.brain.effects");
    } catch {
      // Storage may be unavailable; reset still applies for this view.
    }
    state.effects = normalizeEffectSettings(
      { ...DEFAULT_EFFECT_SETTINGS, reducedMotion: prefersReducedMotion },
      { prefersReducedMotion },
    );
    state.scene?.setEffectSettings(state.effects);
    renderLivingPanel();
    if (state.blueprint) renderLegend(state.blueprint);
  });
  renderLivingPanel();
}

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}[char]));

const formatInt = (value) => (
  typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "â€”"
);

const formatValue = (value) => {
  if (value === null || value === undefined) return "â€”";
  if (typeof value === "number") return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(4);
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return value.length > 12 ? `[${value.slice(0, 12).join(", ")}, â€¦]` : `[${value.join(", ")}]`;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

const formatShape = (shape) => (Array.isArray(shape) && shape.length ? `[${shape.join(" Ã— ")}]` : "â€”");

const dimensionsText = (dimensions) => {
  if (!dimensions || typeof dimensions !== "object") return "â€”";
  if (dimensions.in !== undefined || dimensions.out !== undefined) {
    return `${formatValue(dimensions.in)} â†’ ${formatValue(dimensions.out)}`;
  }
  return Object.entries(dimensions).map(([key, value]) => `${key}: ${formatValue(value)}`).join(" Â· ") || "â€”";
};

function setOverlay(html) {
  const overlay = document.getElementById("overlay");
  overlay.innerHTML = html;
  overlay.classList.remove("hidden");
}

function hideOverlay() {
  const overlay = document.getElementById("overlay");
  overlay.classList.add("hidden");
  overlay.innerHTML = "";
}

function showError(title, detail, errors = []) {
  const subtitle = document.getElementById("brainSubtitle");
  if (subtitle) subtitle.textContent = title;
  const list = errors.length
    ? `<ul class="overlay-errors">${errors.slice(0, 12).map((error) => `<li>${esc(error)}</li>`).join("")}</ul>`
    : "";
  setOverlay(`
    <div class="overlay-card">
      <div class="overlay-title">${esc(title)}</div>
      <div class="overlay-detail">${detail}</div>
      ${list}
      <div class="overlay-actions">
        <a href="/admin">Observatory</a>
        <a href="javascript:location.reload()">Retry</a>
      </div>
    </div>
  `);
}

function renderHeader(summary) {
  const verificationClass = summary.verification === "verified"
    ? "good"
    : summary.verification === "mismatch" ? "bad" : "warn";
  const verificationLabel = summary.verification === "verified"
    ? "verified structure"
    : summary.verification === "mismatch" ? "structure mismatch" : "manifest-only count";
  const metrics = document.getElementById("brainMetrics");
  metrics.innerHTML = `
    <span class="brain-chip"><strong>${esc(summary.version ?? "unknown")}</strong></span>
    <span class="brain-chip">${esc(summary.architecture ?? "unknown")} Â· ${esc(summary.configName ?? "config unknown")}</span>
    <span class="brain-chip"><strong>${formatInt(summary.layers)}</strong> layers</span>
    <span class="brain-chip"><strong>${formatInt(summary.parameters)}</strong> parameters</span>
    <span class="brain-chip ${verificationClass}" title="${esc(summary.weightsInspected ?? "unknown inspection")}">${esc(verificationLabel)}</span>
  `;
  document.getElementById("brainSubtitle").textContent = [
    summary.artifactName,
    summary.exportedAt ? `exported ${new Date(summary.exportedAt).toLocaleString()}` : null,
    summary.components != null ? `${formatInt(summary.components)} components` : null,
    summary.connections != null ? `${formatInt(summary.connections)} connections` : null,
  ].filter(Boolean).join(" Â· ");
}

function renderLegend(blueprint) {
  if (!blueprint) return;
  const counts = blueprint.model?.counts?.componentsByType ?? {};
  const present = Object.entries(counts).filter(([, count]) => count > 0);
  const fallback = Object.entries(
    (blueprint.components ?? []).reduce((accumulator, component) => {
      accumulator[component.type] = (accumulator[component.type] ?? 0) + 1;
      return accumulator;
    }, {}),
  );
  const rows = (present.length ? present : fallback)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([type, count]) => {
      const color = COMPONENT_COLORS[type] ?? COMPONENT_COLORS.buffer;
      return `
        <div class="legend-row">
          <span class="legend-dot" style="background:${color};color:${color}"></span>
          <span>${esc(type.replaceAll("_", " "))}</span>
          <span class="legend-count">${formatInt(count)}</span>
        </div>
      `;
    });
  const planCounts = state.scene?.plan?.counts ?? null;
  const key = `
    <div class="legend-key">
      <div class="legend-row"><span class="legend-swatch structural"></span><span>Structural component</span></div>
      <div class="legend-row"><span class="legend-swatch connection"></span><span>Blueprint connection</span></div>
      ${state.mode === "brain" ? `
        <div class="legend-row"><span class="legend-swatch filament"></span><span>Illustrative filament</span></div>
        <div class="legend-row"><span class="legend-swatch pulse"></span><span>Illustrative travelling pulse</span></div>
        ${state.effects?.attention !== false ? `<div class="legend-row"><span class="legend-swatch attention"></span><span>Speculative attention arc</span></div>` : ""}
        <div class="legend-row"><span class="legend-swatch ambient"></span><span>Ambient particle / nebula</span></div>
        ${state.layerActivityEnabled ? `<div class="legend-row"><span class="legend-swatch measured"></span><span>Measured layer gradient RMS</span></div>` : ""}
      ` : ""}
    </div>
  `;
  const countsLine = state.mode === "brain" && planCounts
    ? `<p class="legend-meta">Illustrative ${formatInt(planCounts.illustrativeNodes)} nodes · ${formatInt(planCounts.illustrativeFilaments)} filaments · ${formatInt(planCounts.attentionArcs)} speculative arcs · ${formatInt((planCounts.ambientStars ?? 0) + (planCounts.ambientClusters ?? 0) + (planCounts.ambientWisps ?? 0))} ambient objects</p>`
    : "";
  const note = state.mode === "brain"
    ? `<p class="legend-note"><strong>Actual architecture</strong> is the glass/metal nodes and solid blueprint edges. Filaments, travelling pulses, speculative attention arcs, nebulae and ambient dust are <em>illustrative atmosphere</em>, not weights, activations or measured signals. Live telemetry is shown separately below.</p>`
    : `<p class="legend-note">Architecture mode hides every illustrative and ambient layer. Every node and connection shown here comes from the exported blueprint. Low-priority positional links brighten when a related component is selected.</p>`;
  document.getElementById("legendItems").innerHTML = key
    + (rows.join("") || `<div class="empty-note">No components.</div>`)
    + countsLine
    + note;
}

function renderWarnings(blueprint, planWarnings = []) {
  const warnings = [...(blueprint.warnings ?? []), ...planWarnings];
  const element = document.getElementById("warnings");
  if (!warnings.length) {
    element.classList.add("hidden");
    element.textContent = "";
    return;
  }
  const shown = warnings.slice(0, 3).map(esc).join(" Â· ");
  const more = warnings.length > 3 ? ` Â· +${warnings.length - 3} more` : "";
  element.textContent = `${shown}${more}`;
  element.classList.remove("hidden");
}

function renderIntro() {
  const summary = state.summary;
  const accounting = state.blueprint?.parameterAccounting ?? {};
  const verification = accounting.verification ?? {};
  const checks = Array.isArray(verification.checks) ? verification.checks : [];
  const checksHtml = checks.length
    ? `<div class="inspector-section">
        <h3>What was checked</h3>
        <div class="meta-list">
          ${checks.map((check) => `
            <div class="meta-row">
              <span>${esc(check.name)}</span>
              <span>${check.ok === false ? "failed" : check.ok === true ? "ok" : "not checked"}</span>
            </div>
          `).join("")}
        </div>
      </div>`
    : "";
  document.getElementById("inspectorBody").innerHTML = `
    <p class="muted">Select a structural node or layer region in the scene.</p>
    <p class="small muted">${state.mode === "brain"
      ? "Brain mode adds illustrative filaments for atmosphere. Selection still identifies the real component and its genuine blueprint connections."
      : "Architecture mode shows only the exported blueprint: structural nodes, tensor metadata and real computational connections."}</p>
    <dl class="inspector-grid">
      <dt>Version</dt><dd>${esc(summary?.version ?? "â€”")}</dd>
      <dt>Architecture</dt><dd>${esc(summary?.architecture ?? "â€”")}</dd>
      <dt>Layers</dt><dd>${formatInt(summary?.layers)}</dd>
      <dt>Parameters</dt><dd>${formatInt(accounting.totalParameters)}</dd>
      <dt>Unique storage</dt><dd>${formatInt(accounting.persistedTensorElements ?? accounting.tensorElements)}</dd>
      <dt>Buffer elements</dt><dd>${formatInt(accounting.nonParameterBufferElements)}</dd>
      <dt>Verification</dt><dd>${esc(verification.status ?? "unknown")}</dd>
      <dt>Weights loaded</dt><dd>${state.blueprint?.source?.weightsLoaded === false ? "no" : "unknown"}</dd>
    </dl>
    <p class="small muted">This inspector shows structural metadata only. Live training telemetry and the optional per-layer gradient RMS overlay are shown in the Live training panel; the legend separates measured activity from illustrative motion.</p>
    ${checksHtml}
  `;
}

function connectionChips(list, direction) {
  if (!list.length) return `<div class="empty-note">No ${direction} connections.</div>`;
  return `<div class="connection-list">${list.map((edge) => `
    <button type="button" class="connection-chip" data-select="${esc(edge.otherId)}" title="${esc(edge.explicit ? "explicit" : "inferred")}">
      ${esc(edge.name)}<span class="edge-type">${esc(edge.type)}</span>
    </button>
  `).join("")}</div>`;
}

function renderInspector(componentId) {
  state.selectedId = componentId;
  if (!componentId) {
    renderIntro();
    return;
  }
  const detail = describeSelection(state.blueprint, componentId);
  if (!detail) {
    renderIntro();
    return;
  }
  const { component } = detail;
  const parameters = detail.parameters ?? {};
  const tiedLabel = detail.labels.tied
    ? `<span class="type-badge tied">tied to embedding</span>`
    : "";
  const derivedLabel = detail.labels.derived
    ? `<span class="type-badge derived">derived structural node</span>`
    : "";
  const tensorSource = (detail.tensors.length ? detail.tensors : detail.descendantTensors)
    .slice()
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const tensorRows = tensorSource
    .map((tensor) => `
        <div class="tensor-row">
          <div class="tensor-name">${esc(tensor.name)}</div>
          <div class="tensor-meta">${esc(formatShape(tensor.shape))} Â· ${esc(tensor.dtype ?? "â€”")}</div>
          <div class="tensor-elements">${formatInt(tensor.elements ?? tensor.numel)}</div>
        </div>
      `).join("");
  const aggregate = detail.aggregate ?? { components: 0 };
  const hasAggregate = aggregate.components > 0;
  const shownParameters = hasAggregate ? aggregate.parametersUnique : parameters.unique;
  const shownElements = hasAggregate ? aggregate.tensorElements : parameters.elements;
  const metadataRows = Object.entries(detail.metadata ?? {})
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `<div class="meta-row"><span>${esc(key)}</span><span>${esc(formatValue(value))}</span></div>`)
    .join("");
  const parameterNote = !hasAggregate && parameters.counted === false && parameters.elements
    ? `<div class="empty-note">${formatInt(parameters.elements)} tensor elements are shared or tied and are not counted again.</div>`
    : "";

  document.getElementById("inspectorBody").innerHTML = `
    <div class="inspector-heading">
      <div class="inspector-name">${esc(component.name ?? component.id)}</div>
    </div>
    <span class="type-badge">${esc(component.type)}</span>
    ${tiedLabel}
    ${derivedLabel}
    <dl class="inspector-grid">
      <dt>Block</dt><dd>${detail.blockIndex == null ? "â€”" : esc(detail.blockIndex)}</dd>
      <dt>Parent</dt><dd>${esc(component.parentId ?? "â€”")}</dd>
      <dt>Dimensions</dt><dd>${esc(dimensionsText(detail.dimensions))}</dd>
      <dt>Parameters</dt><dd>${formatInt(shownParameters)} unique Â· ${formatInt(shownElements)} elements${hasAggregate ? ` <span class="muted">(aggregate of ${formatInt(aggregate.components)} contained components)</span>` : ""}</dd>
      <dt>Exactness</dt><dd>${parameters.exact === false ? "estimated" : "exact"}</dd>
      <dt>Tensor count</dt><dd>${formatInt(tensorSource.length)}${hasAggregate ? ` <span class="muted">(contained)</span>` : ""}</dd>
    </dl>
    ${parameterNote}
    ${tensorSource.length ? `
      <div class="inspector-section">
        <h3>Tensors${hasAggregate ? " (contained)" : ""}</h3>
        <div class="tensor-list">${tensorRows}</div>
      </div>
    ` : ""}
    ${metadataRows ? `
      <div class="inspector-section">
        <h3>Architecture metadata</h3>
        <div class="meta-list">${metadataRows}</div>
      </div>
    ` : ""}
    <div class="inspector-section">
      <h3>Incoming (${detail.incoming.length})</h3>
      ${connectionChips(detail.incoming, "incoming")}
    </div>
    <div class="inspector-section">
      <h3>Outgoing (${detail.outgoing.length})</h3>
      ${connectionChips(detail.outgoing, "outgoing")}
    </div>
    ${detail.isContainer ? `
      <div class="inspector-section">
        <h3>Contained components (${formatInt(detail.containedComponents)})</h3>
        <div class="inspector-section">
          <h3>Connections into block (${detail.interfaceIncoming.length})</h3>
          ${connectionChips(detail.interfaceIncoming, "incoming")}
        </div>
        <div class="inspector-section">
          <h3>Connections out of block (${detail.interfaceOutgoing.length})</h3>
          ${connectionChips(detail.interfaceOutgoing, "outgoing")}
        </div>
        <div class="inspector-section">
          <h3>Connections within block (${detail.internal.length})</h3>
          ${connectionChips(detail.internal, "internal")}
        </div>
      </div>
      <p class="small muted">A container reports its children's graph relationships separately: "into/out of block" are edges crossing the container boundary, "within block" are edges between contained components.</p>
    ` : ""}
    ${detail.labels.inferredConnections ? `<p class="small muted">${detail.labels.inferredConnections} connection(s) are inferred rather than explicit module edges.</p>` : ""}
  `;
}

function updateModeButtons() {
  for (const button of document.querySelectorAll("[data-mode]")) {
    const active = button.getAttribute("data-mode") === state.mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function setMode(mode, { announce = true } = {}) {
  if (mode !== "brain" && mode !== "architecture") return;
  state.mode = mode;
  updateModeButtons();
  if (state.scene) state.scene.setMode(mode);
  if (state.blueprint) renderLegend(state.blueprint);
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("mode", mode);
    window.history.replaceState(null, "", url);
  } catch {
    // A restrictive file:// or embedded context may not allow history updates.
  }
  if (announce && state.blueprint) {
    renderInspector(state.selectedId);
    const subtitle = document.getElementById("brainSubtitle");
    if (subtitle) {
      subtitle.dataset.mode = mode;
    }
  }
}

async function loadBlueprint() {
  setOverlay(`
    <div class="overlay-card">
      <div class="spinner"></div>
      <div class="overlay-title">Loading the brain</div>
      <div class="overlay-detail">Reading the exported structural blueprint.</div>
    </div>
  `);
  let response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    response = await fetch(API, { headers: { Accept: "application/json" }, signal: controller.signal });
  } catch (err) {
    const message = err?.name === "AbortError"
      ? "The blueprint request timed out after 15 seconds."
      : (err.message ?? "network error");
    document.getElementById("brainSubtitle").textContent = "Blueprint unavailable";
    showError("Cannot reach the blueprint endpoint", esc(message));
    return;
  } finally {
    clearTimeout(timer);
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || payload?.available === false) {
    const reason = payload?.reason ?? payload?.error ?? `HTTP ${response.status}`;
    if (response.status === 404 || /missing|not exported|no blueprint/i.test(reason)) {
      showError(
        "No blueprint exported yet",
        `Run <code>npm run blueprint</code> on the machine serving this page, then choose Retry. The exporter reads the active model and writes one JSON file; it does not load weights or touch the model store.`,
      );
    } else {
      showError("The blueprint is unavailable", esc(reason));
    }
    return;
  }
  const blueprint = payload?.blueprint ?? payload;
  const validation = validateBlueprint(blueprint);
  if (!validation.ok) {
    showError(
      "The blueprint is malformed",
      "The visualiser refuses to render invalid structural data rather than inventing missing components.",
      validation.errors,
    );
    return;
  }
  state.blueprint = blueprint;
  state.summary = blueprintSummary(blueprint);
  renderHeader(state.summary);
  renderLegend(blueprint);
  renderWarnings(blueprint);
  renderIntro();

  if (blueprint.warnings?.length) {
    renderWarnings(blueprint);
  }

  try {
    const { createBrainScene } = await import("./render.js");
    state.scene = createBrainScene(document.getElementById("scene"), blueprint, {
      initialMode: state.mode,
      activityEnabled: state.activityEnabled,
      layerActivityEnabled: state.layerActivityEnabled,
      effects: state.effects,
      prefersReducedMotion,
      telemetryStatus: state.displayStatus,
      onSelect: (componentId) => {
        if (componentId) setPanelCollapsed("inspector", false);
        renderInspector(componentId);
      },
    });
    state.scene.setMode(state.mode);
    state.scene.setActivityEnabled(state.activityEnabled);
    state.scene.setEffectSettings(state.effects);
    state.scene.setTelemetryStatus(state.displayStatus);
    syncLayerActivity(true);
    updateModeButtons();
    renderLegend(blueprint);
    renderLivingPanel();
    renderWarnings(blueprint, state.scene.plan.warnings);
    hideOverlay();
  } catch (err) {
    showError(
      "The 3D scene could not start",
      `${esc(err.message ?? "WebGL initialisation failed")}. The structural blueprint itself was valid.`,
    );
  }
}

// ---------------------------------------------------------- live training
const LIVE_STATUS_LABEL = {
  live: "Live",
  connecting: "Connecting",
  stale: "Stale",
  disconnected: "Disconnected",
  unavailable: "No telemetry",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
  interrupted: "Interrupted",
  paused: "Paused",
  waiting: "Waiting",
  running: "Running",
  "pause-requested": "Pausing",
  "stop-requested": "Stopping",
  stopping: "Stopping",
};

function liveStatusClass(status) {
  return ["live", "stale", "disconnected", "unavailable", "connecting", "failed", "completed", "stopped", "paused", "waiting", "pause-requested", "stop-requested", "stopping"].includes(status)
    ? status
    : "unavailable";
}

function syncTelemetryVisual(displayStatus) {
  const previous = state.displayStatus;
  state.previousDisplayStatus = previous;
  state.displayStatus = displayStatus;
  state.scene?.setTelemetryStatus(displayStatus);
  if (previous && previous !== displayStatus) {
    if (displayStatus === "failed") {
      acknowledgeActivity("failure");
    } else if (displayStatus === "live" && (previous === "failed" || previous === "disconnected")) {
      acknowledgeActivity("recovery");
    }
  }
  renderLivingPanel();
}

function metricHtml(label, value, className = "") {
  return `
    <div class="live-metric">
      <span class="live-metric-label">${esc(label)}</span>
      <span class="live-metric-value ${className}">${esc(value)}</span>
    </div>
  `;
}

function chartSvg(telemetry) {
  const model = chartModel(telemetry);
  if (!model) return null;
  const width = 640;
  const height = 150;
  const left = 44;
  const right = 12;
  const top = 10;
  const bottom = 22;
  const innerWidth = width - left - right;
  const innerHeight = height - top - bottom;
  const px = (step) => left + model.x(step) * innerWidth;
  const py = (loss) => top + (1 - model.y(loss)) * innerHeight;
  const line = (points) => points
    .map((point, index) => `${index === 0 ? "M" : "L"}${px(point.step).toFixed(1)},${py(point.loss).toFixed(1)}`)
    .join(" ");
  const yTicks = [model.yMax, (model.yMax + model.yMin) / 2, model.yMin];
  const xTicks = [model.xMin, (model.xMin + model.xMax) / 2, model.xMax];
  const grid = yTicks.map((value) => {
    const y = py(value).toFixed(1);
    return `<line class="grid" x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"/>
      <text class="axis" x="${left - 5}" y="${Number(y) + 3}" text-anchor="end">${esc(formatLoss(value))}</text>`;
  }).join("");
  const xAxis = xTicks.map((value) => {
    const x = px(value).toFixed(1);
    return `<text class="axis" x="${x}" y="${height - 6}" text-anchor="${value === model.xMin ? "start" : value === model.xMax ? "end" : "middle"}">${esc(Math.round(value).toLocaleString())}</text>`;
  }).join("");
  const trainingPath = model.training.length > 1
    ? `<path class="training-line" d="${line(model.training)}"/>`
    : "";
  const evaluationPath = model.evaluation.length > 1
    ? `<path class="eval-line" d="${line(model.evaluation)}"/>`
    : "";
  const evaluationPoints = model.evaluation
    .map((point) => `<circle class="eval-point" cx="${px(point.step).toFixed(1)}" cy="${py(point.loss).toFixed(1)}" r="2.8"/>`)
    .join("");
  const checkpoints = (telemetry.checkpoints ?? [])
    .filter((checkpoint) => Number.isFinite(checkpoint.step)
      && checkpoint.step >= model.xMin
      && checkpoint.step <= model.xMax)
    .map((checkpoint) => {
      const x = px(checkpoint.step).toFixed(1);
      return `<line class="checkpoint-mark" x1="${x}" y1="${top}" x2="${x}" y2="${height - bottom}"/>`;
    })
    .join("");
  return `${grid}${xAxis}${checkpoints}${trainingPath}${evaluationPath}${evaluationPoints}`;
}

function syncLayerActivity(force = false) {
  const now = Date.now();
  const activity = state.telemetry.layerActivity;
  const status = telemetryDisplayStatus(state.telemetry, {
    now,
    connection: state.telemetry.connection,
  });
  const live = status === "live" && state.telemetry.status === "running";
  const enabled = state.layerActivityEnabled && live && Boolean(activity);
  const key = enabled
    ? `${state.telemetry.sessionId}:${activity.step}:${activity.layers.map((layer) => `${layer.index}:${layer.rms ?? "n"}`).join(",")}`
    : `off:${status}`;
  if (force || key !== state.layerActivityKey) {
    state.layerActivityKey = key;
    state.scene?.setLayerActivity(enabled ? activity : null);
  }

  const statusEl = document.getElementById("layerActivityStatus");
  if (statusEl) {
    let text;
    let measured = false;
    if (!state.layerActivityEnabled) {
      text = "Layer gradient RMS: overlay off";
    } else if (!activity) {
      text = "Layer gradient RMS: not measured";
    } else if (!live) {
      text = `Layer gradient RMS: ${status}`;
    } else {
      const age = activity.sampledAt ? Date.parse(activity.sampledAt) : NaN;
      text = `Layer gradient RMS: ${activity.layers.length} layers · step ${activity.step ?? "—"}${Number.isFinite(age) ? ` · sampled ${formatAge(Math.max(0, now - age))}` : ""}`;
      measured = true;
    }
    statusEl.textContent = text;
    statusEl.title = "Gradient RMS = sqrt(mean(g^2)) over each transformer block's parameter gradients, after backward and before clipping. Raw values are in the telemetry payload.";
    statusEl.classList.toggle("measured", measured);
  }
}

function renderLivePanel({ rebuildChart = true } = {}) {
  const now = Date.now();
  const telemetry = state.telemetry;
  const displayStatus = telemetryDisplayStatus(telemetry, {
    now,
    connection: telemetry.connection,
  });
  const statusEl = document.getElementById("liveStatus");
  if (statusEl) {
    statusEl.textContent = LIVE_STATUS_LABEL[displayStatus] ?? "No telemetry";
    statusEl.className = `live-status ${liveStatusClass(displayStatus)}`;
  }
  syncTelemetryVisual(displayStatus);
  const connectionEl = document.getElementById("liveConnection");
  if (connectionEl) {
    const connection = telemetry.connection ?? "connecting";
    connectionEl.textContent = connection === "live"
      ? "SSE live"
      : connection === "disconnected" ? "SSE reconnecting" : "SSE connecting";
    connectionEl.className = `live-pill ${liveStatusClass(connection)}`;
  }
  const runEl = document.getElementById("liveRun");
  if (runEl) {
    runEl.textContent = telemetry.jobId
      ? [telemetry.jobId, telemetry.version, telemetry.parentVersion ? `from ${telemetry.parentVersion}` : null]
        .filter(Boolean).join(" Â· ")
      : (telemetry.available ? "Training session" : "No active training session");
  }
  const updatedEl = document.getElementById("liveUpdated");
  if (updatedEl) {
    if (telemetry.receivedLocallyAt) {
      const age = Math.max(0, now - telemetry.receivedLocallyAt);
      const suffix = telemetry.completedAt ? "finished" : "updated";
      updatedEl.textContent = `${suffix} ${formatAge(age)} Â· stale after ${formatDuration(telemetry.staleAfterMs)}`;
    } else if (telemetry.reason) {
      updatedEl.textContent = telemetry.reason;
    } else {
      updatedEl.textContent = "â€”";
    }
    updatedEl.title = updatedEl.textContent;
  }

  const metrics = document.getElementById("liveMetrics");
  if (metrics) {
    const step = telemetry.step == null
      ? "â€”"
      : `${Math.round(telemetry.step).toLocaleString()}${telemetry.totalSteps ? ` / ${Math.round(telemetry.totalSteps).toLocaleString()}` : ""}`;
    const learningRate = Number.isFinite(telemetry.learningRate)
      ? Number(telemetry.learningRate).toExponential(2)
      : "â€”";
    metrics.innerHTML = [
      metricHtml("Step", step),
      metricHtml("Train loss", formatLoss(telemetry.trainLoss), "train"),
      metricHtml("Eval loss", telemetry.evaluationLoss == null ? "not measured" : formatLoss(telemetry.evaluationLoss), "eval"),
      metricHtml("Learning rate", learningRate),
      metricHtml("Throughput", formatRate(telemetry.stepsPerSecond)),
      metricHtml("Elapsed", formatDuration(telemetry.elapsedMs)),
    ].join("");
  }

  if (rebuildChart) {
    const svg = document.getElementById("lossChart");
    const empty = document.getElementById("lossEmpty");
    const markup = chartSvg(telemetry);
    if (svg) svg.innerHTML = markup ?? "";
    if (empty) {
      empty.classList.toggle("hidden", Boolean(markup));
      empty.textContent = telemetry.available
        ? "No loss measurements yet. The chart fills as training steps are observed."
        : (telemetry.reason ?? "No live training telemetry.");
    }
  }

  const toggle = document.getElementById("activityToggle");
  if (toggle) {
    toggle.setAttribute("aria-pressed", String(state.activityEnabled));
    toggle.textContent = state.activityEnabled ? "Activity on" : "Activity off";
  }
  const layerToggle = document.getElementById("layerActivityToggle");
  if (layerToggle) {
    layerToggle.setAttribute("aria-pressed", String(state.layerActivityEnabled));
    layerToggle.textContent = state.layerActivityEnabled ? "Layer overlay on" : "Layer overlay off";
  }
  syncLayerActivity();
}

function acknowledgeActivity(kind) {
  if (!state.activityEnabled) return;
  state.scene?.notifyActivity({ kind });
}

async function loadTelemetrySnapshot() {
  let response;
  try {
    response = await fetch(`${ADMIN_API}/training/telemetry`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
  } catch {
    state.telemetry.connection = "disconnected";
    renderLivePanel();
    return;
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || !payload) {
    if (response.status === 401) {
      state.telemetry.connection = "disconnected";
    } else {
      state.telemetry.connection = "disconnected";
      state.telemetry.reason = payload?.error ?? `telemetry HTTP ${response.status}`;
    }
    renderLivePanel();
    return;
  }
  state.telemetry = telemetryFromSnapshot(payload, { now: Date.now() });
  state.telemetry.connection = payload.available ? "live" : "unavailable";
  state.telemetrySeq = Math.max(state.telemetrySeq, Number(payload.changeSeq) || 0);
  renderLivePanel();
}

function connectTelemetryStream() {
  if (!window.EventSource) {
    state.telemetry.connection = "disconnected";
    state.telemetry.reason = "this browser cannot subscribe to live telemetry; refreshing the snapshot periodically";
    renderLivePanel();
    state.liveTimer = setInterval(() => {
      loadTelemetrySnapshot();
      renderLivePanel({ rebuildChart: false });
    }, 5000);
    return;
  }
  state.telemetryStream?.close();
  const stream = new EventSource(`${ADMIN_API}/events?since=${state.telemetrySeq}`);
  state.telemetryStream = stream;
  stream.onopen = () => {
    if (state.telemetry.connection !== "live") {
      state.telemetry.connection = "connecting";
      renderLivePanel();
    }
  };
  stream.addEventListener("hello", () => {
    state.telemetry.connection = "live";
    renderLivePanel();
    loadTelemetrySnapshot();
  });
  stream.addEventListener("change", (event) => {
    let change;
    try {
      change = JSON.parse(event.data);
    } catch {
      return;
    }
    state.telemetrySeq = Math.max(state.telemetrySeq, Number(change.seq) || 0);
    if (change.type === "training.telemetry" && change.data) {
      state.telemetry.connection = "live";
      const previousStep = state.telemetry.step;
      const result = applyTelemetryEvent(state.telemetry, change.data, { now: Date.now() });
      if (!result.accepted) return;
      if (result.kind === "checkpoint") {
        acknowledgeActivity("checkpoint");
      } else if (result.kind === "evaluation") {
        acknowledgeActivity("evaluation");
      } else if (result.kind === "snapshot" && result.point && result.point.step !== previousStep) {
        acknowledgeActivity("step");
      }
      renderLivePanel();
      return;
    }
    if (change.type === "job.status" && change.data) {
      if (state.telemetry.jobId && change.data.jobId === state.telemetry.jobId) {
        if (applyJobStatus(state.telemetry, change.data, { now: Date.now() })) {
          renderLivePanel();
        }
      }
    }
    if (change.type === "job.started" && change.data?.kind === "training") {
      loadTelemetrySnapshot();
    }
  });
  stream.addEventListener("resync", () => loadTelemetrySnapshot());
  stream.onerror = () => {
    state.telemetry.connection = "disconnected";
    renderLivePanel();
  };
}

async function wireLiveTraining() {
  document.getElementById("activityToggle")?.addEventListener("click", () => {
    state.activityEnabled = !state.activityEnabled;
    state.scene?.setActivityEnabled(state.activityEnabled);
    try {
      window.sessionStorage.setItem("sma.brain.activity", state.activityEnabled ? "on" : "off");
    } catch {
      // A restrictive context may not allow storage; the toggle still works.
    }
    renderLivePanel();
  });
  document.getElementById("layerActivityToggle")?.addEventListener("click", () => {
    state.layerActivityEnabled = !state.layerActivityEnabled;
    state.scene?.setLayerActivityEnabled(state.layerActivityEnabled);
    state.layerActivityKey = "";
    try {
      window.sessionStorage.setItem("sma.brain.layerActivity", state.layerActivityEnabled ? "on" : "off");
    } catch {
      // A restrictive context may not allow storage; the toggle still works.
    }
    syncLayerActivity(true);
    renderLivePanel();
    if (state.blueprint) renderLegend(state.blueprint);
  });
  renderLivePanel();
  await loadTelemetrySnapshot();
  connectTelemetryStream();
  if (!state.liveTimer) {
    state.liveTimer = setInterval(() => renderLivePanel({ rebuildChart: false }), 1000);
  }
}

function wireControls() {
  initPanelCollapse();
  wireLivingControls();
  document.getElementById("resetView").addEventListener("click", () => state.scene?.resetView());
  document.getElementById("overview").addEventListener("click", () => state.scene?.clear());
  for (const button of document.querySelectorAll("[data-mode]")) {
    button.addEventListener("click", () => setMode(button.getAttribute("data-mode")));
  }
  document.getElementById("inspectorBody").addEventListener("click", (event) => {
    const target = event.target.closest("[data-select]");
    if (!target) return;
    const componentId = target.getAttribute("data-select");
    if (componentId) state.scene?.select(componentId);
  });
  document.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "r" || event.key === "R") state.scene?.resetView();
    if (event.key === "Escape") state.scene?.clear();
    if (event.key === "b" || event.key === "B") setMode("brain");
    if (event.key === "a" || event.key === "A") setMode("architecture");
  });
  window.addEventListener("beforeunload", () => {
    state.telemetryStream?.close();
    if (state.liveTimer) clearInterval(state.liveTimer);
    state.scene?.dispose();
  });
  updateModeButtons();
}

wireControls();
wireLiveTraining();
loadBlueprint();
