import {
  COMPONENT_COLORS,
  blueprintSummary,
  describeSelection,
  validateBlueprint,
} from "./schema.js";

const API = "/api/admin/brain/blueprint";
const state = {
  blueprint: null,
  summary: null,
  scene: null,
  selectedId: null,
};

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}[char]));

const formatInt = (value) => (
  typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "—"
);

const formatValue = (value) => {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(4);
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return value.length > 12 ? `[${value.slice(0, 12).join(", ")}, …]` : `[${value.join(", ")}]`;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

const formatShape = (shape) => (Array.isArray(shape) && shape.length ? `[${shape.join(" × ")}]` : "—");

const dimensionsText = (dimensions) => {
  if (!dimensions || typeof dimensions !== "object") return "—";
  if (dimensions.in !== undefined || dimensions.out !== undefined) {
    return `${formatValue(dimensions.in)} → ${formatValue(dimensions.out)}`;
  }
  return Object.entries(dimensions).map(([key, value]) => `${key}: ${formatValue(value)}`).join(" · ") || "—";
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
    <span class="brain-chip">${esc(summary.architecture ?? "unknown")} · ${esc(summary.configName ?? "config unknown")}</span>
    <span class="brain-chip"><strong>${formatInt(summary.layers)}</strong> layers</span>
    <span class="brain-chip"><strong>${formatInt(summary.parameters)}</strong> parameters</span>
    <span class="brain-chip ${verificationClass}" title="${esc(summary.weightsInspected ?? "unknown inspection")}">${esc(verificationLabel)}</span>
  `;
  document.getElementById("brainSubtitle").textContent = [
    summary.artifactName,
    summary.exportedAt ? `exported ${new Date(summary.exportedAt).toLocaleString()}` : null,
    summary.components != null ? `${formatInt(summary.components)} components` : null,
    summary.connections != null ? `${formatInt(summary.connections)} connections` : null,
  ].filter(Boolean).join(" · ");
}

function renderLegend(blueprint) {
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
  document.getElementById("legendItems").innerHTML = rows.join("") || `<div class="empty-note">No components.</div>`;
}

function renderWarnings(blueprint, planWarnings = []) {
  const warnings = [...(blueprint.warnings ?? []), ...planWarnings];
  const element = document.getElementById("warnings");
  if (!warnings.length) {
    element.classList.add("hidden");
    element.textContent = "";
    return;
  }
  const shown = warnings.slice(0, 3).map(esc).join(" · ");
  const more = warnings.length > 3 ? ` · +${warnings.length - 3} more` : "";
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
    <p class="muted">Select a component or transformer block in the scene.</p>
    <dl class="inspector-grid">
      <dt>Version</dt><dd>${esc(summary?.version ?? "—")}</dd>
      <dt>Architecture</dt><dd>${esc(summary?.architecture ?? "—")}</dd>
      <dt>Layers</dt><dd>${formatInt(summary?.layers)}</dd>
      <dt>Parameters</dt><dd>${formatInt(accounting.totalParameters)}</dd>
      <dt>Unique storage</dt><dd>${formatInt(accounting.persistedTensorElements ?? accounting.tensorElements)}</dd>
      <dt>Buffer elements</dt><dd>${formatInt(accounting.nonParameterBufferElements)}</dd>
      <dt>Verification</dt><dd>${esc(verification.status ?? "unknown")}</dd>
      <dt>Weights loaded</dt><dd>${state.blueprint?.source?.weightsLoaded === false ? "no" : "unknown"}</dd>
    </dl>
    <p class="small muted">Only structural metadata is shown. There are no live activations, gradients or training telemetry in this view.</p>
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
          <div class="tensor-meta">${esc(formatShape(tensor.shape))} · ${esc(tensor.dtype ?? "—")}</div>
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
      <dt>Block</dt><dd>${detail.blockIndex == null ? "—" : esc(detail.blockIndex)}</dd>
      <dt>Parent</dt><dd>${esc(component.parentId ?? "—")}</dd>
      <dt>Dimensions</dt><dd>${esc(dimensionsText(detail.dimensions))}</dd>
      <dt>Parameters</dt><dd>${formatInt(shownParameters)} unique · ${formatInt(shownElements)} elements${hasAggregate ? ` <span class="muted">(aggregate of ${formatInt(aggregate.components)} contained components)</span>` : ""}</dd>
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
    ${detail.labels.inferredConnections ? `<p class="small muted">${detail.labels.inferredConnections} connection(s) are inferred rather than explicit module edges.</p>` : ""}
  `;
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
        `Generate one with <code>npm run blueprint</code>, then reload this page. The exporter reads the active model and writes one JSON file; it does not load weights or touch the model store.`,
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
      onSelect: (componentId) => renderInspector(componentId),
    });
    renderWarnings(blueprint, state.scene.plan.warnings);
    hideOverlay();
  } catch (err) {
    showError(
      "The 3D scene could not start",
      `${esc(err.message ?? "WebGL initialisation failed")}. The structural blueprint itself was valid.`,
    );
  }
}

function wireControls() {
  document.getElementById("resetView").addEventListener("click", () => state.scene?.resetView());
  document.getElementById("overview").addEventListener("click", () => state.scene?.clear());
  document.getElementById("inspectorBody").addEventListener("click", (event) => {
    const target = event.target.closest("[data-select]");
    if (!target) return;
    const componentId = target.getAttribute("data-select");
    if (componentId) state.scene?.select(componentId);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "r" || event.key === "R") state.scene?.resetView();
    if (event.key === "Escape") state.scene?.clear();
  });
  window.addEventListener("beforeunload", () => state.scene?.dispose());
}

wireControls();
loadBlueprint();
