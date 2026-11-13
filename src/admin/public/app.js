const API = "/api/admin";

const state = {
  tab: "dashboard",
  workspaces: [],
  workspace: null, // selected workspace id
  workspaceInfo: null, // descriptor for the selected workspace
  overview: null,
  articles: { items: [], nextCursor: null, filters: {} },
  selectedArticle: null,
  chat: {
    messages: [],
    identity: null,
    sending: false,
    conversations: [],
    currentConversationId: null,
    currentConvVersion: null,
    // The composer's in-progress text. An SSE-driven refresh re-renders the
    // whole chat view, which would otherwise discard an unsent draft; keeping it
    // in state (like the form selections and open job above) means a refresh is
    // invisible to an operator who is mid-message.
    draft: "",
  },
  mission: null,
  strategy: null,
  cycles: null,
  history: null,
  trends: null,
  // Which sub-tab of Training History / Trends is showing. Sections that stack
  // several wide tables are tabbed so a table always gets the full width it
  // needs; defaulting to the first entry keeps the initial render unchanged.
  historyTab: "runs",
  trendsTab: "trend",
  // Trends & Metrics view state. Kept outside the DOM so a live SSE refresh or
  // a sub-tab switch never discards an operator's filters or expanded run.
  trendsView: {
    runQuery: "",
    runOutcome: "",
    runVersion: "",
    runSort: "newest",
    runPage: 1,
    runPageSize: 50,
    runExpanded: null,
    xMode: "sequence",
    connectValidation: false,
  },
  trendsExtras: null, // { history, byRun, pyByVersion } from /training-history
  trendsExtrasLoading: false,
  trendsExtrasError: null,
  control: null, // { jobs, eligibility, teacher, versions }
  // Persisted Learning & Training form selections, so a re-render (from SSE,
  // polling, or after Start/Stop) never silently resets the operator's choice
  // back to the first option.
  controlForm: {},
  jobDetail: null,
  // The job whose detail panel is open. A refresh (SSE, poll, or a
  // Start/Stop/Pause action) re-renders the whole Learning & Training tab, so
  // the selection has to live here: without it the panel the operator just
  // opened disappeared under them mid-scroll.
  openJobId: null,
  // Shared model-version selector: pinned per workspace, independent of the
  // active pointer and of a running job's training parent.
  versions: [],
  selectedVersion: null,
  live: false,
  seq: 0,
};

// ---------------------------------------------------------- job hash helpers
const JOB_HASH_PREFIX = "job=";

/** Read the job ID from the URL hash, e.g. "#job=job-123". */
function readJobHash() {
  const hash = window.location.hash;
  if (!hash.startsWith("#" + JOB_HASH_PREFIX)) return null;
  return hash.slice(("#" + JOB_HASH_PREFIX).length);
}

/** Update the URL hash to reflect the currently selected job, or clear it. */
function writeJobHash(jobId) {
  if (jobId) {
    window.location.hash = JOB_HASH_PREFIX + jobId;
  } else {
    // Only clear if the current hash is a job hash
    if (window.location.hash.startsWith("#" + JOB_HASH_PREFIX)) {
      window.location.hash = "";
    }
  }
}

/** Restore the selected job from the URL hash, if present and valid. */
function restoreJobFromHash() {
  const jobId = readJobHash();
  if (jobId) {
    state.openJobId = jobId;
  }
}

/** Listen for hash changes (back/forward navigation, manual hash edit). */
function watchJobHash() {
  window.addEventListener("hashchange", () => {
    const jobId = readJobHash();
    // If the hash was cleared or changed to a different job, close the current panel
    // and let the new hash take effect via the normal openJob flow.
    if (state.openJobId !== jobId) {
      if (!jobId) {
        closeJob();
      } else {
        // The hash changed to a different job - open it
        openJob(jobId);
      }
    }
  });
}

/** Restore the selected job from URL hash if it exists in the current job list. */
function restoreJobFromHashIfValid() {
  const jobId = readJobHash();
  if (!jobId) return;
  // Check if the job still exists in the current job list
  const jobExists = document.querySelector(`[data-job="${esc(jobId)}"]`);
  if (jobExists) {
    state.openJobId = jobId;
    openJob(jobId, { silent: true });
  } else {
    // Job no longer exists - clear the hash
    writeJobHash(null);
  }
}

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v) => (v === null || v === undefined ? "—" : typeof v === "number" ? (Number.isInteger(v) ? v.toLocaleString() : v.toFixed(3)) : String(v));
const when = (iso) => (iso ? new Date(iso).toLocaleString() : "—");
const badge = (cls, text) => `<span class="badge ${esc(cls)}">${esc(text)}</span>`;
function jobBadge(job) {
  const status = job?.status ?? "unknown";
  const cls = status === "running" || status === "completed"
    ? "REVIEWED"
    : status === "failed" || status === "stopped" || status === "interrupted"
      ? "REJECTED"
      : "PENDING_REVIEW";
  return badge(cls, status);
}

/**
 * The shared model-version scope. The pinned version is a VIEWING selector — it
 * never moves the active pointer and never changes a running job's parent. It is
 * kept strictly separate from "active" and from a job's "training parent".
 */
function versionScope() {
  const v = state.selectedVersion;
  const active = state.overview?.pythonStore?.activeVersion ?? state.workspaceInfo?.activeVersion ?? null;
  if (!v) return `<span class="pill" title="no pinned version; views follow the active pointer">scope: active${active ? ` ${esc(active)}` : ""}</span>`;
  return `<span class="pill" title="pinned for viewing only; the active pointer is unchanged">scope: pinned ${esc(v)}</span>`;
}

/** True when the selected workspace is inspection-only (all mutations blocked). */
const isReadOnly = () => state.workspaceInfo?.readOnly === true;
const roAttr = (title = "inspection-only workspace") => (isReadOnly() ? `disabled title="${esc(title)}"` : "");

async function api(path, { method = "GET", body } = {}) {
  let url = API + path;
  if (state.workspace) url += `${path.includes("?") ? "&" : "?"}workspace=${encodeURIComponent(state.workspace)}`;
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
  return json;
}

// ---------------------------------------------------------- workspace selection
async function loadWorkspaces() {
  const res = await fetch(`${API}/workspaces`);
  const data = await res.json();
  state.workspaces = data.workspaces ?? [];
  const sel = document.getElementById("workspaceSelect");
  if (sel) {
    sel.innerHTML = state.workspaces
      .map((w) => `<option value="${esc(w.id)}"${w.available ? "" : " disabled"}>${esc(w.label)}${w.activeVersion ? ` — ${esc(w.activeVersion)}` : ""}${w.readOnly ? " (inspection)" : ""}${w.available ? "" : " · unavailable"}</option>`)
      .join("");
    sel.value = state.workspace ?? data.default ?? "";
  }
  selectWorkspace(state.workspace ?? data.default ?? state.workspaces[0]?.id ?? null);
}

function selectWorkspace(id) {
  state.workspace = id;
  state.workspaceInfo = state.workspaces.find((w) => w.id === id) ?? null;
  const sel = document.getElementById("workspaceSelect");
  if (sel && id) sel.value = id;
  // Reset every per-workspace cache so nothing can bleed across stores.
  state.overview = null;
  state.articles = { items: [], nextCursor: null, filters: {} };
  state.selectedArticle = null;
  state.mission = null;
  state.strategy = null;
  state.cycles = null;
  state.history = null;
  state.trends = null;
  state.trendsExtras = null;
  state.trendsExtrasLoading = false;
  state.trendsExtrasError = null;
  state.trendsView = {
    runQuery: "",
    runOutcome: "",
    runVersion: "",
    runSort: "newest",
    runPage: 1,
    runPageSize: 50,
    runExpanded: null,
    xMode: "sequence",
    connectValidation: false,
  };
  state.control = null;
  state.jobDetail = null;
  state.versions = [];
  state.selectedVersion = readPinnedVersion(id);
  renderWorkspaceBanner();
  updatePills();
  loadVersions().finally(refresh);
}

// ------------------------------------------------- shared model-version pin
const pinKey = (wsId) => `sma.version.${wsId ?? "default"}`;
function readPinnedVersion(wsId) {
  try { return localStorage.getItem(pinKey(wsId)) || null; } catch { return null; }
}
function writePinnedVersion(wsId, version) {
  try { version ? localStorage.setItem(pinKey(wsId), version) : localStorage.removeItem(pinKey(wsId)); } catch { /* ignore */ }
}

/**
 * Load the committed brain versions for the selected workspace and populate the
 * header selector. Versions are loaded dynamically from the selected workspace's
 * registry; the selector is honest when the store is unavailable.
 */
async function loadVersions() {
  let data;
  try { data = await api("/brain/versions"); } catch { data = { available: false, versions: [] }; }
  state.versions = data?.versions ?? [];
  const sel = document.getElementById("modelVersion");
  if (!sel) return;
  if (!data?.available || !state.versions.length) {
    sel.innerHTML = `<option value="">${data?.available ? "no committed versions" : "store unavailable"}</option>`;
    sel.disabled = true;
    state.selectedVersion = null;
    return;
  }
  sel.disabled = false;
  const committed = state.versions.filter((v) => v.committed);
  // A pinned version that no longer exists in this store is dropped rather than
  // silently mapped to a different one.
  if (state.selectedVersion && !state.versions.some((v) => v.version === state.selectedVersion)) {
    state.selectedVersion = null;
    writePinnedVersion(state.workspace, null);
  }
  // Only committed versions are selectable. The active one is labelled so a
  // long lineage can be scanned without cross-referencing the banner.
  sel.innerHTML = [
    `<option value="">active/default</option>`,
    ...committed.map((v) => {
      const active = isActiveVersion(v.version) ? " (active)" : "";
      const parent = v.parentVersion ? ` ← ${esc(v.parentVersion)}` : "";
      return `<option value="${esc(v.version)}">${esc(v.version)}${active}${parent}</option>`;
    }),
  ].join("");
  sel.value = state.selectedVersion ?? "";
}

/** The version the server is actually serving, from the workspace overview. */
function isActiveVersion(version) {
  if (!version) return false;
  const active = state.overview?.pythonStore?.activeVersion ?? state.workspaceInfo?.activeVersion ?? null;
  return Boolean(active) && active === version;
}

function setPinnedVersion(version) {
  state.selectedVersion = version || null;
  writePinnedVersion(state.workspace, state.selectedVersion);
  // Changing selector opens a new conversation (never switches mid-conversation).
  if (state.tab === "chat") {
    state.chat.messages = [];
    state.chat.currentConversationId = null;
    state.chat.currentConvVersion = state.selectedVersion || null;
    renderChat();
  } else {
    render();
  }
}


function renderWorkspaceBanner() {
  const el = document.getElementById("workspaceBanner");
  if (!el) return;
  const w = state.workspaceInfo;
  if (!w) { el.className = "workspace-banner"; el.textContent = ""; return; }
  const flag = w.readOnly ? "inspection-only — mutations disabled" : "read/write";
  el.className = `workspace-banner ${w.readOnly ? "inspection" : ""} ${w.available ? "" : "unavailable"}`;
  el.innerHTML = `
    <span class="ws-name">Workspace: ${esc(w.label)}</span>
    <span class="muted small">${esc(w.id)} · ${esc(w.kind)}</span>
    <span class="pill ${w.available ? "" : "warn"}">${w.available ? (w.activeVersion ? `active ${esc(w.activeVersion)}` : "no active version") : "unavailable"}</span>
    <span class="ws-flag small">${esc(flag)}</span>
    ${w.available ? "" : `<span class="small bad">${esc(w.reason ?? "")}</span>`}
    <span style="flex:1"></span>
    <span class="muted small" title="${esc(w.root ?? "")}">${esc(w.root ?? "")}</span>`;
}

// ---------------------------------------------------------------- rendering
const main = document.getElementById("main");

function setTab(tab) {
  state.tab = tab;
  hideChartTooltip();
  for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("active", b.dataset.tab === tab);
  render();
  refresh();
}

async function refresh() {
  try {
    if (state.workspaceInfo && !state.workspaceInfo.available) {
      updatePills();
      main.innerHTML = `<div class="panel notice"><div class="title bad">Workspace unavailable</div>
        <div class="muted">${esc(state.workspaceInfo.reason ?? "store not found")}</div>
        <div class="small muted" style="margin-top:6px">No data is fabricated for a missing or invalid store.</div></div>`;
      return;
    }
    state.overview = await api("/overview");
    state.seq = Math.max(state.seq, state.overview.changeSeq ?? 0);
    updatePills();
    if (state.tab === "dashboard") renderDashboard();
    if (state.tab === "articles") await loadArticles();
    if (state.tab === "control") await loadControl();
    if (state.tab === "chat") await loadChat();
    if (state.tab === "mission") await loadMission();
    if (state.tab === "cycles") await loadCycles();
    if (state.tab === "history") await loadHistory();
    if (state.tab === "trends") await loadTrends();
    if (state.tab === "sources") await loadSources();
  } catch (err) {
    main.innerHTML = `<div class="panel notice"><div class="title bad">Portal error</div><div class="muted">${esc(err.message)}</div></div>`;
  }
}

function updatePills() {
  const py = state.overview?.pythonStore;
  const w = state.workspaceInfo;
  const store = document.getElementById("storePill");
  if (w && !w.available) {
    store.className = "pill warn";
    store.textContent = `${w.label}: unavailable`;
    store.title = w.reason ?? "";
  } else if (!py || !py.available) {
    store.className = "pill warn";
    store.textContent = py ? "python store: unavailable" : "store: —";
    store.title = py?.reason ?? "";
  } else {
    store.className = "pill";
    const active = py.activeVersion ?? w?.activeVersion;
    store.textContent = `${w?.label ?? "python store"}: ${active ? `active ${active}` : `${py.versions.length} version(s)`}`;
  }
  const live = document.getElementById("livePill");
  live.className = `pill ${state.live ? "online" : "offline"}`;
  live.textContent = state.live ? "live ●" : "live ○";
}

function render() {
  if (state.tab === "dashboard") renderDashboard();
  else if (state.tab === "articles") renderArticles();
  else if (state.tab === "control") renderControl();
  else if (state.tab === "chat") renderChat();
  else if (state.tab === "mission") renderMission();
  else if (state.tab === "cycles") renderCycles();
  else if (state.tab === "history") renderHistory();
  else if (state.tab === "trends") renderTrends();
  // Sources & Domains renders only from authoritative API state. `render()` runs
  // before that state exists, so this tab is populated exclusively by
  // `loadSources()`; calling it here with no data would render an empty table
  // and look like "no domains discovered" rather than "not loaded yet".
}

// --------------------------------------------------------------- dashboard
function statCard(k, v) {
  return `<div class="card"><div class="k">${esc(k)}</div><div class="v">${fmt(v)}</div></div>`;
}

function renderDashboard() {
  const o = state.overview;
  if (!o) return;
  const a = o.articles;
  const s = a.byStatus;
  const legacy = o.legacy?.present ?? [];
  main.innerHTML = `
    <h2 class="section-title">Dashboard <span class="sm">${versionScope()}</span></h2>
    <div class="grid">
      ${statCard("Total articles", a.totalArticles)}
      ${statCard("Pending review", a.pendingReview)}
      ${statCard("Reviewed", a.reviewed)}
      ${statCard("Rejected", a.rejected)}
      ${statCard("Ingested (unselected)", a.ingested)}
      ${statCard("Fresh trainable", a.trainable)}
      ${statCard("Unique consumed", a.uniqueConsumed)}
      ${statCard("Training appearances", a.totalAppearances)}
      ${statCard("Avg review score", a.avgReviewScore)}
      ${statCard("Duplication index", a.duplicationIndex)}
      ${statCard("Registry runs", o.registry.runCount)}
      ${statCard("Snapshots", o.registry.snapshotCount)}
    </div>
    <div class="cols" style="margin-top:16px">
      <div class="panel">
        <div class="k">Articles by status</div>
        <table><tr><th>Status</th><th>Count</th></tr>
          ${Object.entries(s).map(([k, v]) => `<tr><td>${badge(k, k)}</td><td>${fmt(v)}</td></tr>`).join("")}
        </table>
        <div class="small muted" style="margin-top:8px">Only REVIEWED &amp; unconsumed articles are fresh-trainable. The training snapshot additionally applies source-diversity caps, so its fresh-token batch may be smaller than this article count.</div>
      </div>
      <div class="panel">
        <div class="k">By domain / importance</div>
        <table><tr><th>Domain</th><th>Count</th></tr>
          ${(a.byDomain ?? []).slice(0, 12).map((d) => `<tr><td>${esc(d.domain)}</td><td>${fmt(d.count)}</td></tr>`).join("") || `<tr><td colspan="2" class="muted">no data</td></tr>`}
        </table>
        <div class="small" style="margin-top:8px">
          Normal ${fmt(a.byImportance.Normal)} · Important ${fmt(a.byImportance.Important)} · Critical ${fmt(a.byImportance.Critical)}
        </div>
        <div class="small muted" style="margin-top:4px">
          classification source: default ${fmt(a.byImportanceSource?.default)} · teacher ${fmt(a.byImportanceSource?.teacher)} · automation ${fmt(a.byImportanceSource?.automation)} · operator ${fmt(a.byImportanceSource?.operator)}
        </div>
      </div>
    </div>
    <div class="cols">
      <div class="panel">
        <div class="k">Active mission (secondary)</div>
        <div class="prose">${esc(o.mission.secondary?.text ?? "—")}</div>
        <div class="small muted" style="margin-top:6px">version ${fmt(o.mission.secondary?.version)} · primary v${fmt(o.mission.primary?.version)}</div>
      </div>
      <div class="panel">
        <div class="k">Current review cycle</div>
        ${o.currentReviewCycle
          ? `<div>Cycle #${o.currentReviewCycle.index} · threshold ${fmt(o.currentReviewCycle.threshold)} consumed</div>
             <div class="small muted">opened ${when(o.currentReviewCycle.openedAt)} · mission v${fmt(o.currentReviewCycle.missionVersion)} · strategy v${fmt(o.currentReviewCycle.strategyVersion)}</div>`
          : `<div class="muted">No cycle open. Next checkpoint every ${fmt(o.reviewInterval)} consumed articles (unique consumed: ${fmt(a.uniqueConsumed)}).</div>`}
      </div>
    </div>
    <div class="panel">
      <div class="k">Acquisition (frontier)</div>
      ${renderFrontier(o.frontier)}
    </div>
    <div class="panel">
      <div class="k">Python brain store</div>
      ${renderPythonStore(o.pythonStore)}
    </div>
    ${legacy.length ? `<div class="panel notice"><div class="title warn">Legacy pair-buffer files detected</div>
      <div class="small muted">Read-only, never a source of truth:</div>
      <ul class="small">${legacy.map((l) => `<li>${esc(l.file)} — ${l.count ?? "?"} line(s)</li>`).join("")}</ul></div>` : ""}
  `;
}

/** Acquisition observability: live frontier counts incl. due retries/rediscoveries. */
function renderFrontier(f) {
  if (!f) return `<div class="muted">frontier not wired</div>`;
  const parts = [
    `${fmt(f.queued)} queued`,
    `${fmt(f.deferred)} deferred${f.deferredDue ? ` (${fmt(f.deferredDue)} due)` : ""}`,
    `${fmt(f.visited)} visited`,
    `${fmt(f.rediscoveryDue)} rediscovery due`,
    `${fmt(f.failed)} failed`,
  ];
  return `<div>${parts.join(" · ")}</div>
    <div class="small muted">next scheduled: ${f.nextDueAt ? when(f.nextDueAt) : "—"}</div>`;
}

/**
 * Job-detail diagnostics for a waiting/running job: the machine-readable waiting
 * reason, acquisition state, scheduled deadline, frontier counts and recovery
 * pipeline. This is the "why is it waiting?" surface (Slice 7).
 */
function renderWaitDiagnostics(meta) {
  if (!meta) return "";
  const rows = [];
  if (meta.waitingReason) rows.push(["waiting reason", meta.waitingReason]);
  if (meta.acquisitionState) rows.push(["acquisition", meta.acquisitionState]);
  if (meta.nextAttemptAt) rows.push(["next attempt", when(meta.nextAttemptAt)]);
  const f = meta.diagnostics?.frontier;
  if (f) {
    rows.push([
      "frontier",
      `${fmt(f.queued)} queued · ${fmt(f.deferred)} deferred (${fmt(f.deferredDue)} due) · ${fmt(f.rediscoveryDue)} rediscovery due${f.nextDueAt ? ` · next ${when(f.nextDueAt)}` : ""}`,
    ]);
  }
  const r = meta.recovery;
  if (r) {
    rows.push([
      "recovery",
      `${fmt(r.ingested)} ingested · ${fmt(r.pendingReview)} pending · ${fmt(r.quarantined)} quarantined · ${fmt(r.released)} released`,
    ]);
  }
  const d = meta.diagnostics?.discovery;
  if (d?.status) rows.push(["discovery", `${d.status}${d.providerAvailable ? " · provider available" : ""}`]);
  if (!rows.length) return "";
  return `<div class="small" style="margin-top:6px">${rows
    .map(([k, v]) => `<div><span class="muted">${esc(k)}:</span> ${esc(String(v))}</div>`)
    .join("")}</div>`;
}

function storeStatus() {
  const py = state.overview?.pythonStore;
  if (!py) return "";
  if (!py.available) return badge("warn", "unavailable");
  return py.activeVersion ? badge("REVIEWED", `active ${py.activeVersion}`) : badge("PENDING_REVIEW", "no active version");
}

function renderPythonStore(py) {
  if (!py) return `<div class="muted">-</div>`;
  if (!py.available) return `<div class="muted">${esc(py.reason ?? "unavailable")}</div>`;
  const rows = py.versions.map((v) => `
  <tr>
    <td>${esc(v.version)} ${v.version === py.activeVersion ? badge("REVIEWED", "active") : ""}</td>
    <td>${v.committed ? badge("REVIEWED", "committed") : badge("REJECTED", "uncommitted")}</td>
    <td>${fmt(v.metrics.loss)}</td>
    <td>${fmt(v.metrics.steps)}</td>
    <td>${fmt(v.metrics.tokens)}</td>
    <td>${fmt(v.metrics.parameters)}</td>
    <td class="small muted">${when(v.committedAt)}</td>
  </tr>`).join("");
  return `root: <code>${esc(py.root)}</code>
    ${brainStateSummary(py)}
    <table style="margin-top:8px"><tr><th>Version</th><th>State</th><th>Loss</th><th>Steps</th><th>Tokens</th><th>Params</th><th>Committed</th></tr>
    ${rows || `<tr><td colspan="7" class="muted">no versions yet</td></tr>`}</table>
    ${prunedTable(py)}
    ${stagedTable(py)}
    <div class="small muted" style="margin-top:6px">Read-only reader. “—” means the metric is unavailable, not zero.</div>`;
}

/**
 * What the store's counts actually mean. Four different things are all called a
 * "brain" in conversation, and reporting them as one number is what makes the
 * version count look wrong: a published version is a checkpoint, a staged
 * candidate is not yet published, a training run is an event, and a pruned
 * version's weights are gone while its record survives in the git mirror.
 */
function brainStateSummary(py) {
  const c = py.counts;
  if (!c) return "";
  const parts = [
    `<span class="pill">${c.published} published</span>`,
    `<span class="pill">${c.uncommitted} uncommitted</span>`,
  ];
  if (c.staged) parts.push(`<span class="pill">${c.staged} staged candidate${c.staged === 1 ? "" : "s"}</span>`);
  if (c.pruned) parts.push(`<span class="pill" title="weights removed by retention; the record survives in the git mirror">${c.pruned} pruned (record retained)</span>`);
  return `<div class="toolbar" style="margin:6px 0">${parts.join(" ")}
    <span class="small muted">${(py.versions ?? []).length} version director${(py.versions ?? []).length === 1 ? "y" : "ies"} on disk</span></div>`;
}

/** Weights deliberately removed by retention. History, not loss. */
function prunedTable(py) {
  const pruned = py.pruned ?? [];
  if (!pruned.length) return "";
  const rows = pruned.map((p) => `<tr>
    <td>${esc(p.version)}</td>
    <td class="small muted">${when(p.prunedAt)}</td>
    <td class="small">${p.weightBytes == null ? "—" : `${(p.weightBytes / 1e9).toFixed(2)} GB`}</td>
    <td class="small muted">${p.mirrorRetained ? "record retained in git" : "record location unknown"}</td>
  </tr>`).join("");
  return `<div style="margin-top:12px">
    <div class="k small muted">Pruned by retention (no weights; record retained)</div>
    <table style="margin-top:4px"><tr><th>Version</th><th>Pruned</th><th>Weights</th><th>Record</th></tr>${rows}</table>
    <div class="small muted" style="margin-top:4px">Removed deliberately by <code>sma.brain prune</code>. Their text remains reviewable in the git-tracked mirror under <code>models/</code>, so the lineage stays inspectable.</div>
  </div>`;
}

/** Candidates built by `train --stage-only`, awaiting promotion or rejection. */
function stagedTable(py) {
  const staged = py.staged ?? [];
  if (!staged.length) return "";
  const rows = staged.map((s) => `<tr>
    <td>${esc(s.version)}</td>
    <td class="small muted">${esc(s.stagingDir)}</td>
    <td>${s.hasManifest ? badge("PENDING_REVIEW", "built, not published") : badge("REJECTED", "incomplete")}</td>
  </tr>`).join("");
  return `<div style="margin-top:12px">
    <div class="k small muted">Staged candidates (not published)</div>
    <table style="margin-top:4px"><tr><th>Version</th><th>Directory</th><th>State</th></tr>${rows}</table>
    <div class="small muted" style="margin-top:4px">A staged candidate is a fully built checkpoint with no <code>COMMITTED</code> marker. It becomes a version only on promotion, and its weights are discarded on rejection.</div>
  </div>`;
}

// ---------------------------------------------------------------- articles
async function loadArticles() {
  const f = state.articles.filters;
  const q = new URLSearchParams();
  q.set("limit", "50");
  q.set("order", "desc"); // newest curated articles first
  for (const key of ["status", "importance", "domain", "consumed"]) if (f[key]) q.set(key, f[key]);
  if (state.articles.nextCursor) q.set("after", state.articles.nextCursor);
  const page = await api(`/articles?${q.toString()}`);
  state.articles.items = state.articles.nextCursor ? [...state.articles.items, ...page.items] : page.items;
  state.articles.nextCursor = page.nextCursor;
  renderArticles();
}

function renderArticles() {
  const a = state.articles;
  const f = a.filters;
  // The domain filter is a fixed set, not free text: the list is the domains
  // actually present on articles, which `/overview` already reports (sorted by
  // count). A filtered domain that no longer exists keeps its own option so the
  // active filter is never silently dropped.
  const domains = state.overview?.articles?.byDomain ?? [];
  const domainOptions = domains
    .map((d) => `<option value="${esc(d.domain)}" ${f.domain === d.domain ? "selected" : ""}>${esc(d.domain)} (${fmt(d.count)})</option>`)
    .join("");
  const staleDomain = f.domain && !domains.some((d) => d.domain === f.domain)
    ? `<option value="${esc(f.domain)}" selected>${esc(f.domain)}</option>`
    : "";
  main.innerHTML = `
    <h2 class="section-title">Articles</h2>
    ${isReadOnly() ? `<div class="panel notice"><div class="title">Inspection-only workspace</div><div class="small muted">This view reads a frozen store. Mutations — review selection, importance changes and review verdicts — are disabled.</div></div>` : ""}
    <div class="toolbar">
      <select data-filter="status">
        <option value="">all statuses</option>
        ${["INGESTED", "PENDING_REVIEW", "REVIEWED", "REJECTED"].map((s) => `<option ${f.status === s ? "selected" : ""}>${s}</option>`).join("")}
      </select>
      <select data-filter="importance">
        <option value="">all importance</option>
        ${["NORMAL", "IMPORTANT", "CRITICAL"].map((s) => `<option ${f.importance === s ? "selected" : ""}>${s}</option>`).join("")}
      </select>
      <select data-filter="consumed">
        <option value="">any consumption</option>
        <option value="false" ${f.consumed === "false" ? "selected" : ""}>unconsumed</option>
        <option value="true" ${f.consumed === "true" ? "selected" : ""}>consumed</option>
      </select>
      <select data-filter="domain">
        <option value="">all domains</option>
        ${staleDomain}
        ${domainOptions}
      </select>
      <button id="reloadArticles">Apply</button>
      <button id="selectReview" class="primary" ${roAttr()}>Run review selection</button>
    </div>
    <div class="panel" id="articleTable">
      ${articleTable()}
      ${a.nextCursor ? `<div style="margin-top:10px"><button id="moreArticles">Load more</button></div>` : ""}
    </div>
    <div id="articleDetail"></div>
  `;
  wireArticles();
}

function articleTable() {
  const items = state.articles.items;
  if (!items.length) return `<div class="empty">No articles match. Ingest via the GraphQL/REST API, or run the crawler + curator.</div>`;
  return `<table><tr><th>Article</th><th>Domain</th><th>Importance</th><th>Status</th><th>Trainable</th><th>Curated at</th><th>Consumed</th><th>Actions</th></tr>
    ${items.map((x) => `
      <tr data-id="${esc(x.articleId)}">
        <td class="wrap" style="max-width:420px"><a href="#" data-open="${esc(x.articleId)}">${esc((x.text ?? "").slice(0, 110))}${(x.text ?? "").length > 110 ? "…" : ""}</a>
          <div class="small muted">${esc(x.articleId)}</div></td>
        <td>${esc(x.domain ?? "—")}</td>
        <td><span title="source: ${esc(x.importanceSource ?? "default")}${x.importanceDecidedBy ? ` (${esc(x.importanceDecidedBy)})` : ""}">${badge(x.importance.toUpperCase(), x.importance)}</span>${x.suggestedImportance ? ` ${badge(`suggested ${String(x.suggestedImportance).toUpperCase()}`, `sugg: ${x.suggestedImportance}`)}` : ""}</td>
        <td>${badge(x.status, x.status)}</td>
        <td>${x.trainable ? "✔" : "—"}</td>
        <td class="small muted">${when(x.createdAt)}</td>
        <td>${x.consumedAt ? `<span title="${esc(x.consumedRef ?? "")}">${when(x.consumedAt)}</span>` : "—"}</td>
        <td class="actions">
          <button data-imp="${esc(x.articleId)}" data-val="Important" ${roAttr()}>Mark Important</button>
          <button data-req="${esc(x.articleId)}" ${roAttr()}>Request review</button>
        </td>
      </tr>`).join("")}
  </table>`;
}

function wireArticles() {
  for (const el of document.querySelectorAll("[data-filter]")) {
    el.addEventListener("change", () => {
      state.articles.filters[el.dataset.filter] = el.value;
      state.articles.nextCursor = null;
      state.articles.items = [];
      loadArticles();
    });
  }
  document.getElementById("reloadArticles")?.addEventListener("click", () => {
    for (const el of document.querySelectorAll("[data-filter]")) state.articles.filters[el.dataset.filter] = el.value;
    state.articles.nextCursor = null;
    state.articles.items = [];
    loadArticles();
  });
  document.getElementById("moreArticles")?.addEventListener("click", loadArticles);
  document.getElementById("selectReview")?.addEventListener("click", async (e) => {
    if (isReadOnly()) return;
    e.target.textContent = "selecting…";
    try { const r = await api("/articles/select-for-review", { method: "POST", body: { limit: 500 } }); alert(`Queued ${r.selected.length} article(s) for review.`); await refresh(); }
    catch (err) { alert(err.message); }
  });
  for (const el of document.querySelectorAll("[data-open]")) {
    el.addEventListener("click", (e) => { e.preventDefault(); openArticle(el.dataset.open); });
  }
  for (const el of document.querySelectorAll("[data-req]")) {
    el.addEventListener("click", async () => {
      if (isReadOnly()) return;
      try { await api(`/articles/${encodeURIComponent(el.dataset.req)}/request-review`, { method: "POST", body: {} }); await loadArticles(); }
      catch (err) { alert(err.message); }
    });
  }
  for (const el of document.querySelectorAll("[data-imp]")) {
    el.addEventListener("click", async () => {
      if (isReadOnly()) return;
      try { await api(`/articles/${encodeURIComponent(el.dataset.imp)}/importance`, { method: "POST", body: { importance: el.dataset.val } }); await loadArticles(); }
      catch (err) { alert(err.message); }
    });
  }
}

async function openArticle(articleId) {
  const box = document.getElementById("articleDetail");
  box.innerHTML = `<div class="panel loading">Loading article…</div>`;
  try {
    const a = await api(`/articles/${encodeURIComponent(articleId)}`);
    box.innerHTML = articleDetail(a);
    wireDetail(a);
    // The detail panel sits below the (potentially long) article table, so
    // opening an article would otherwise leave the operator at the top of the
    // page scrolling down by hand. Bring the panel into view once it has content.
    box.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    box.innerHTML = `<div class="panel notice"><span class="bad">${esc(err.message)}</span></div>`;
  }
}

function articleDetail(a) {
  return `
    <div class="panel">
      <div class="toolbar">
        <strong>${esc(a.articleId)}</strong>
        ${badge(a.status, a.status)} ${badge(a.importance.toUpperCase(), a.importance)}
        ${a.trainable ? badge("REVIEWED", "trainable") : ""}
        <span class="spacer" style="flex:1"></span>
        <button data-close>close</button>
      </div>
      <div class="prose panel" style="background:var(--panel-2)">${esc(a.text)}</div>
      ${a.sourceUrl || a.fetchedContentHash || a.origin ? `<div class="small muted" style="margin-top:8px">
        provenance: origin ${esc(a.origin ?? "—")}${a.source ? ` · source ${esc(a.source)}` : ""}
        ${a.sourceUrl ? `<br>source URL <a href="${esc(a.sourceUrl)}" target="_blank" rel="noreferrer">${esc(a.sourceUrl)}</a>` : ""}
        ${a.fetchedContentHash ? `<br>fetched hash <code>${esc(a.fetchedContentHash)}</code>${a.fetchedContentHash === a.contentHash ? " (matches stored)" : ""}` : ""}
        ${a.fetchedAt ? `<br>fetched ${when(a.fetchedAt)}` : ""}
      </div>` : ""}
      <div class="small muted" style="margin-top:8px">
        importance source: <strong>${esc(a.importanceSource ?? "default")}</strong>${a.importanceDecidedBy ? ` · decided by ${esc(a.importanceDecidedBy)}` : ""}${a.importanceReviewId ? ` · review ${esc(a.importanceReviewId)}` : ""}${a.suggestedImportance ? ` · critic suggested ${esc(a.suggestedImportance)}` : ""}
      </div>
      <div class="toolbar" style="margin-top:12px">
        <label class="small muted">Importance</label>
        <select id="dImp" ${roAttr()}>${["NORMAL", "IMPORTANT", "CRITICAL"].map((v) => `<option ${a.importance.toUpperCase() === v ? "selected" : ""}>${v}</option>`).join("")}</select>
        <button id="dSetImp" ${roAttr()}>Set importance</button>
        <span style="flex:1"></span>
        <button id="dApprove" class="primary" ${roAttr()}>Human approve</button>
        <button id="dReject" class="danger" ${roAttr()}>Human reject</button>
        <button id="dPending" ${roAttr()}>Set pending</button>
      </div>
      ${isReadOnly() ? `<div class="small warn">Inspection-only workspace: review actions are disabled.</div>` : ""}
      <div class="cols">
        <div>
          <div class="k">Review history</div>
          ${a.reviews.length ? a.reviews.map((r) => `
            <div class="history-item ${esc(r.authority)}">
              ${badge(r.verdict.toUpperCase(), r.verdict)} score ${fmt(r.score)} · ${esc(r.authority)}
              <div class="small muted">${when(r.at)} · applied=${r.applied} → ${esc(r.resultingStatus)}</div>
              ${r.rationale ? `<div class="small">${esc(r.rationale)}</div>` : ""}
            </div>`).join("") : `<div class="muted small">No reviews yet.</div>`}
        </div>
        <div>
          <div class="k">Event log</div>
          ${a.events.length ? a.events.map((e) => `
            <div class="history-item"><div class="small">${esc(e.type)} ${e.from ? `${esc(e.from)} → ${esc(e.to)}` : esc(e.to ?? "")}</div>
            <div class="small muted">${when(e.at)} · ${esc(e.actor ?? "system")}${e.reason ? ` · ${esc(e.reason)}` : ""}</div></div>`).join("") : `<div class="muted small">No events.</div>`}
        </div>
      </div>
    </div>`;
}

function wireDetail(a) {
  document.querySelector("[data-close]")?.addEventListener("click", () => (document.getElementById("articleDetail").innerHTML = ""));
  document.getElementById("dSetImp")?.addEventListener("click", async () => {
    if (isReadOnly()) return;
    const importance = document.getElementById("dImp").value;
    try { await api(`/articles/${encodeURIComponent(a.articleId)}/importance`, { method: "POST", body: { importance } }); await openArticle(a.articleId); await loadArticles(); }
    catch (err) { alert(err.message); }
  });
  const review = (verdict) => async () => {
    if (isReadOnly()) return;
    try {
      await api(`/articles/${encodeURIComponent(a.articleId)}/review`, { method: "POST", body: { verdict, authority: "human" } });
      await openArticle(a.articleId); await loadArticles();
    } catch (err) { alert(err.message); }
  };
  document.getElementById("dApprove")?.addEventListener("click", review("approve"));
  document.getElementById("dReject")?.addEventListener("click", review("reject"));
  document.getElementById("dPending")?.addEventListener("click", async () => {
    if (isReadOnly()) return;
    try { await api(`/articles/${encodeURIComponent(a.articleId)}/status`, { method: "POST", body: { status: "PENDING_REVIEW", reason: "operator override" } }); await openArticle(a.articleId); await loadArticles(); }
    catch (err) { alert(err.message); }
  });
}

// -------------------------------------------------------------------- chat
async function loadChat() {
  try { state.chat.identity = await api("/chat/identity"); } catch (err) { state.chat.identity = { error: err.message }; }
  if (!state.chat.currentConversationId && state.selectedVersion) {
    state.chat.currentConvVersion = state.selectedVersion;
  }
  if (!state.chat.currentConvVersion) {
    state.chat.currentConvVersion = state.selectedVersion || null;
  }
  renderChat();
}

function renderChat() {
  const c = state.chat;
  const id = c.identity ?? {};
  // renderChat replaces the entire view via `main.innerHTML`, and refresh()
  // calls it on every inbound SSE change while the Live Chat tab is active. An
  // unsent message, its caret and the log's scroll must survive that rebuild, or
  // the composer is emptied under the operator mid-keystroke.
  const prevInput = document.getElementById("chatInput");
  const prevLog = document.getElementById("chatLog");
  if (prevInput) c.draft = prevInput.value;
  const hadFocus = prevInput != null && document.activeElement === prevInput;
  const selStart = prevInput ? prevInput.selectionStart : null;
  const selEnd = prevInput ? prevInput.selectionEnd : null;
  const logScroll = prevLog ? prevLog.scrollTop : null;
  const vScope = versionScope();
  const curVer = c.currentConvVersion || null;
  const curId = c.currentConversationId || null;
  const convInfo = curId ? `${curId.slice(0, 8)} · pinned ${curVer ?? "?"}` : "no conversation selected";
  main.innerHTML = `
    <h2 class="section-title">Live Chat <span class="sm">${vScope}</span></h2>
    <div class="panel">
      <div class="toolbar">
        <button id="chatNewBtn" class="ghost">New conversation</button>
        <span class="spacer"></span>
        <span class="muted small">${esc(convInfo)}</span>
      </div>
      <div class="toolbar">
        <span class="k">Student</span>
        ${badge(id.available ? "REVIEWED" : "REJECTED", id.available ? "available" : "unavailable")}
        <span class="muted small">mode: ${esc(id.mode ?? "—")} · serving version: ${esc(id.version ?? "none")}</span>
      </div>
      <div class="small muted" style="margin:-2px 0 8px">Conversations are pinned to the checkpoint version they were created with; the header version selector opens a new conversation when changed (it never switches a live one).</div>
      ${!id.available ? `<div class="small warn">No committed student version is active. The chat has no teacher fallback — this is reported honestly rather than faked.</div>` : ""}
      <div class="chat">
        <div class="log" id="chatLog">
          ${c.messages.length ? c.messages.map((m) => `
            <div class="msg ${esc(m.role)}">${esc(m.text)}<span class="meta">${esc(m.meta ?? "")}</span></div>`).join("") : `<div class="msg system">Say something to the current brain.</div>`}
        </div>
      <div class="composer">
        <textarea id="chatInput" rows="4" placeholder="Message the brain…  (Enter to send, Shift+Enter for a new line)" ${id.available ? "" : "disabled"}></textarea>
        <button id="chatSend" class="primary" ${id.available ? "" : "disabled"}>Send</button>
      </div>
      </div>
    </div>`;
  const inputEl = document.getElementById("chatInput");
  if (inputEl) inputEl.value = c.draft ?? "";
  if (hadFocus && inputEl) {
    inputEl.focus();
    if (selStart != null && selEnd != null) {
      try { inputEl.setSelectionRange(selStart, selEnd); } catch {}
    }
  }
  const logEl = document.getElementById("chatLog");
  if (logEl) logEl.scrollTop = logScroll ?? 1e9;
  const send = async () => {
    const input = document.getElementById("chatInput");
    const text = input.value.trim();
    if (!text) return;
    c.messages.push({ role: "user", text, meta: new Date().toLocaleTimeString() });
    input.value = "";
    c.draft = "";
    renderChat();
    document.getElementById("chatLog").scrollTop = 1e9;
    try {
      const body = { message: text };
      if (c.currentConversationId) body.conversationId = c.currentConversationId;
      else if (c.currentConvVersion) body.version = c.currentConvVersion;
      const r = await api("/chat", { method: "POST", body });
      const meta = [];
      if (r.version) meta.push(r.version);
      if (r.integrity) meta.push(r.integrity);
      meta.push(new Date().toLocaleTimeString());
      c.messages.push({ role: "brain", text: r.reply, meta: meta.join(" · ") });
      if (r.conversationId && !c.currentConversationId) {
        c.currentConversationId = r.conversationId;
      }
    } catch (err) {
      c.messages.push({ role: "system", text: `error: ${err.message}`, meta: "" });
    }
    renderChat();
    document.getElementById("chatLog").scrollTop = 1e9;
  };
  const newConv = async () => {
    c.messages = [];
    c.currentConversationId = null;
    c.currentConvVersion = state.selectedVersion || null;
    c.draft = "";
    renderChat();
    document.getElementById("chatInput")?.focus();
  };
  document.getElementById("chatSend")?.addEventListener("click", send);
  document.getElementById("chatInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });
  document.getElementById("chatInput")?.addEventListener("input", (e) => { c.draft = e.target.value; });
  document.getElementById("chatNewBtn")?.addEventListener("click", newConv);
}

// ------------------------------------------------------- mission & strategy
async function loadMission() {
  state.mission = await api("/mission");
  state.strategy = await api("/strategy");
  renderMission();
}

function renderMission() {
  const m = state.mission;
  const s = state.strategy;
  if (!m || !s) return;
  main.innerHTML = `
    <h2 class="section-title">Mission &amp; Strategy</h2>
    ${isReadOnly() ? `<div class="panel notice"><div class="title">Inspection-only workspace</div><div class="small muted">Mission and strategy are shown read-only; edits and proposals are disabled.</div></div>` : ""}
    <div class="cols">
      <div class="panel">
        <div class="k">Primary mission ${badge("seed", "operator-only")}</div>
        <div class="prose">${esc(m.primary?.text ?? "—")}</div>
        <div class="small muted">version ${m.primary?.version ?? "—"} · AI cannot modify this; only an audited operator action can.</div>
        <textarea id="primaryText" placeholder="Amend primary mission (audited)…" ${roAttr()}></textarea>
        <button id="primaryApply" class="danger" ${roAttr()}>Amend primary mission</button>
      </div>
      <div class="panel">
        <div class="k">Secondary mission (evolvable)</div>
        <div class="prose">${esc(m.secondary?.text ?? "—")}</div>
        <textarea id="secondaryText" ${roAttr()}>${esc(m.secondary?.text ?? "")}</textarea>
        <div class="toolbar">
          <input type="text" id="secondaryRationale" placeholder="rationale (recorded with the version)" ${roAttr()} />
          <button id="secondaryApply" class="primary" ${roAttr()}>Save as new version</button>
          <button id="secondaryPropose" ${roAttr()}>Propose AI change</button>
        </div>
      </div>
    </div>
    <div class="cols">
      <div class="panel">
        <div class="k">Pending mission proposals (${m.proposals.length})</div>
        ${m.proposals.length ? m.proposals.map((p) => `
          <div class="history-item ai">
            <div class="small">${esc(p.text)}</div>
            <div class="small muted">${esc(p.rationale ?? "")} · ${when(p.at)}</div>
            <div class="toolbar">
              <button data-approve-mission="${esc(p.proposalId)}" class="primary" ${roAttr()}>Approve</button>
              <button data-reject-mission="${esc(p.proposalId)}" class="danger" ${roAttr()}>Reject</button>
            </div>
          </div>`).join("") : `<div class="muted small">No pending proposals.</div>`}
      </div>
      <div class="panel">
        <div class="k">Mission version history</div>
        ${(m.versions ?? []).slice().reverse().map((v) => `
          <div class="history-item ${esc(v.origin)}">
            <div class="small">v${v.version} ${badge(v.origin, v.origin)}</div>
            <div class="small muted">${when(v.at)} · ${esc(v.actor)}</div>
          </div>`).join("") || `<div class="muted small">No versions.</div>`}
      </div>
    </div>

    <h2 class="section-title" style="margin-top:24px">Collection Strategy</h2>
    <div class="cols">
      <div class="panel">
        <div class="k">Active strategy (v${s.active?.version ?? "—"})</div>
        <textarea id="strategyText" ${roAttr()}>${esc(JSON.stringify(s.active?.strategy ?? {}, null, 2))}</textarea>
        <div class="toolbar">
          <input type="text" id="strategyRationale" placeholder="rationale" ${roAttr()} />
          <button id="strategyApply" class="primary" ${roAttr()}>Save as new version</button>
          <button id="strategyPropose" ${roAttr()}>Propose update</button>
        </div>
      </div>
      <div class="panel">
        <div class="k">Pending strategy proposals (${s.proposals.length})</div>
        ${s.proposals.length ? s.proposals.map((p) => `
          <div class="history-item ai">
            <pre>${esc(JSON.stringify(p.strategy, null, 2))}</pre>
            <div class="small muted">${esc(p.rationale ?? "")} · ${when(p.at)}</div>
            <div class="toolbar">
              <button data-approve-strategy="${esc(p.proposalId)}" class="primary" ${roAttr()}>Approve</button>
              <button data-reject-strategy="${esc(p.proposalId)}" class="danger" ${roAttr()}>Reject</button>
            </div>
          </div>`).join("") : `<div class="muted small">No pending proposals.</div>`}
        <div class="k" style="margin-top:12px">Version history</div>
        ${(s.versions ?? []).slice().reverse().map((v) => `
          <div class="history-item ${esc(v.origin)}"><div class="small">v${v.version} ${badge(v.origin, v.origin)} · ${when(v.at)}</div></div>`).join("") || `<div class="muted small">No versions.</div>`}
      </div>
    </div>
  `;
  wireMission();
}

function wireMission() {
  document.getElementById("secondaryApply")?.addEventListener("click", async () => {
    if (isReadOnly()) return;
    try {
      await api("/mission/secondary", { method: "POST", body: { text: document.getElementById("secondaryText").value, rationale: document.getElementById("secondaryRationale").value } });
      await loadMission();
    } catch (err) { alert(err.message); }
  });
  document.getElementById("secondaryPropose")?.addEventListener("click", async () => {
    if (isReadOnly()) return;
    try {
      await api("/mission/proposals", { method: "POST", body: { text: document.getElementById("secondaryText").value, rationale: document.getElementById("secondaryRationale").value } });
      await loadMission();
    } catch (err) { alert(err.message); }
  });
  document.getElementById("primaryApply")?.addEventListener("click", async () => {
    if (isReadOnly()) return;
    const text = document.getElementById("primaryText").value;
    if (!confirm("Amend the primary mission? This is an audited operator action.")) return;
    try { await api("/mission/primary", { method: "POST", body: { text, rationale: "operator amendment" } }); await loadMission(); }
    catch (err) { alert(err.message); }
  });
  for (const el of document.querySelectorAll("[data-approve-mission]")) {
    el.addEventListener("click", async () => { if (isReadOnly()) return; try { await api(`/mission/proposals/${encodeURIComponent(el.dataset.approveMission)}/approve`, { method: "POST", body: {} }); await loadMission(); } catch (err) { alert(err.message); } });
  }
  for (const el of document.querySelectorAll("[data-reject-mission]")) {
    el.addEventListener("click", async () => { if (isReadOnly()) return; try { await api(`/mission/proposals/${encodeURIComponent(el.dataset.rejectMission)}/reject`, { method: "POST", body: {} }); await loadMission(); } catch (err) { alert(err.message); } });
  }
  document.getElementById("strategyApply")?.addEventListener("click", async () => {
    if (isReadOnly()) return;
    try {
      const strategy = JSON.parse(document.getElementById("strategyText").value);
      await api("/strategy", { method: "POST", body: { strategy, rationale: document.getElementById("strategyRationale").value } });
      await loadMission();
    } catch (err) { alert(`invalid strategy JSON or server error: ${err.message}`); }
  });
  document.getElementById("strategyPropose")?.addEventListener("click", async () => {
    if (isReadOnly()) return;
    try {
      const strategy = JSON.parse(document.getElementById("strategyText").value);
      await api("/strategy/proposals", { method: "POST", body: { strategy, rationale: document.getElementById("strategyRationale").value } });
      await loadMission();
    } catch (err) { alert(`invalid strategy JSON or server error: ${err.message}`); }
  });
  for (const el of document.querySelectorAll("[data-approve-strategy]")) {
    el.addEventListener("click", async () => { if (isReadOnly()) return; try { await api(`/strategy/proposals/${encodeURIComponent(el.dataset.approveStrategy)}/approve`, { method: "POST", body: {} }); await loadMission(); } catch (err) { alert(err.message); } });
  }
  for (const el of document.querySelectorAll("[data-reject-strategy]")) {
    el.addEventListener("click", async () => { if (isReadOnly()) return; try { await api(`/strategy/proposals/${encodeURIComponent(el.dataset.rejectStrategy)}/reject`, { method: "POST", body: {} }); await loadMission(); } catch (err) { alert(err.message); } });
  }
}

// -------------------------------------------------------------- review cycles
async function loadCycles() {
  state.cycles = await api("/review-cycles");
  renderCycles();
}

function renderCycles() {
  const c = state.cycles;
  if (!c) return;
  main.innerHTML = `
    <h2 class="section-title">Review Cycles</h2>
    ${isReadOnly() ? `<div class="panel notice"><div class="title">Inspection-only workspace</div><div class="small muted">Cycles are shown read-only; opening and closing are disabled.</div></div>` : ""}
    <div class="panel">
      <div class="k">Cycle ledger</div>
      <div class="small muted">A cycle opens every ${fmt(c.interval)} uniquely consumed articles — a checkpoint, never a cap. Each records the mission &amp; strategy versions active when it opened.</div>
      <table style="margin-top:8px"><tr><th>#</th><th>Status</th><th>Threshold</th><th>Opened</th><th>Closed</th><th>Mission v</th><th>Strategy v</th><th>Notes</th><th></th></tr>
        ${(c.cycles ?? []).map((cy) => `
          <tr>
            <td>${cy.index}</td>
            <td>${cy.status === "open" ? badge("PENDING_REVIEW", "open") : badge("REVIEWED", "closed")}</td>
            <td>${fmt(cy.threshold)}</td>
            <td class="small">${when(cy.openedAt)}</td>
            <td class="small">${when(cy.closedAt)}</td>
            <td>${fmt(cy.missionVersion)}</td>
            <td>${fmt(cy.strategyVersion)}</td>
            <td class="small">${esc(cy.notes ?? "—")}</td>
            <td>${cy.status === "open" ? `<button data-close-cycle="${esc(cy.reviewCycleId)}" class="primary" ${roAttr()}>Close</button>` : ""}</td>
          </tr>`).join("") || `<tr><td colspan="9" class="muted">No cycles yet (need ${fmt(c.interval)} consumed articles to open the first).</td></tr>`}
      </table>
    </div>`;
  for (const el of document.querySelectorAll("[data-close-cycle]")) {
    el.addEventListener("click", async () => {
      if (isReadOnly()) return;
      const notes = prompt("Closing notes (recorded):") ?? "";
      try { await api(`/review-cycles/${encodeURIComponent(el.dataset.closeCycle)}/close`, { method: "POST", body: { notes } }); await loadCycles(); }
      catch (err) { alert(err.message); }
    });
  }
}

// ------------------------------------------------------------ training history
async function loadHistory() {
  state.history = await api("/training-history");
  renderHistory();
}

function renderHistory() {
  const h = state.history;
  if (!h) return;
  const r = h.registry;
  const tab = state.historyTab;
  main.innerHTML = `
    <h2 class="section-title">Training History <span class="sm">${versionScope()}</span></h2>
    <div class="small muted" style="margin:-6px 0 12px">
      workspace <strong>${esc(h.workspace?.id ?? "—")}</strong>${h.workspace?.readOnly ? " (inspection-only)" : ""} ·
      python store <code>${esc(h.pythonStore?.root ?? "—")}</code>
    </div>
    ${h.discrepancies.length ? `<div class="panel notice">
      <div class="title warn">${h.discrepancies.length} unresolved registry conflict(s) between Node registry and Python store — reported, not silently reconciled</div>
      <ul class="small">${h.discrepancies.map((d) => `<li>${esc(d.kind)}${d.version ? ` — ${esc(d.version)}` : ""}${d.detail ? ` (${esc(d.detail)})` : ""}</li>`).join("")}</ul>
    </div>` : `<div class="panel"><span class="ok">No unresolved registry conflicts.</span> <span class="small muted">${h.lifecycle ? `${h.lifecycle.published} published · ${h.lifecycle.staged} staged · ${h.lifecycle.discarded} discarded attempts · ${h.lifecycle.pruned} pruned · ${h.lifecycle.adopted} adopted` : "Node = orchestration/audit; Python = committed artifacts."}</span></div>`}

    ${subtabs("historyTab", [
      ["runs", `Training runs (${r.runs.length})`],
      ["models", `Models (${r.models.length})`],
      ["python", `Python store (${h.pythonStore?.versions?.length ?? 0})`],
      ["eval", "Evaluation set"],
    ])}

    ${tab === "runs" ? runsPanel(r) : ""}
    ${tab === "models" ? modelsPanel(r) : ""}
    ${tab === "python" ? pythonStorePanel(h.pythonStore) : ""}
    ${tab === "eval" ? evalSetPanel(h.evaluationSet) : ""}
  `;
  bindSubtabs();
}

/**
 * Training runs at full width. Ten columns cannot share a half-width grid cell:
 * the auto layout starves the free-text column to one character and
 * `overflow-wrap: anywhere` renders every character on its own line.
 */
function runsPanel(r) {
  const rows = r.runs.slice().reverse().map(runRow).join("");
  return `<div class="panel">
    <div class="k">Training runs (Node registry)</div>
    <div class="small muted" style="margin-bottom:8px">
      One row per recorded run — including runs that were rejected, failed or never finished. A run becomes a published version only when it is promoted.
    </div>
    <table><tr><th>Run</th><th>Status</th><th>Records</th><th>Versions (parent→candidate)</th><th>Promotion</th><th>Score (base→trained)</th><th>Loss (base→trained)</th><th>Δ</th><th class="reason">Reason</th><th>Started</th></tr>
      ${rows || `<tr><td colspan="10" class="muted">No runs yet. Run <code>npm run train</code>.</td></tr>`}
    </table>
  </div>`;
}

function runRow(run) {
  const prom = run.promotionStatus ?? run.status;
  const reason = run.candidate?.note ?? run.note ?? null;
  const lineage = run.pythonVersion ? `${run.parentVersion ? `${esc(run.parentVersion)} → ` : ""}${esc(run.pythonVersion)}` : "—";
  const dataCell = run.datasetHash
    ? `<div class="muted" title="dataset hash ${esc(run.datasetHash)}">data ${esc(shortHash(run.datasetHash))}</div>`
    : "";
  const activeCell = run.activatedVersion
    ? `<div class="muted" title="version this run activated">active ${esc(run.activatedVersion)}</div>`
    : "";
  const trainAvg = run.candidate?.avgTrainLoss != null
    ? `<div class="muted" title="mean training-tail loss (candidate meta)">train avg ${fmt(run.candidate.avgTrainLoss)}</div>`
    : "";
  const score = run.baselineScore == null && run.trainedScore == null ? "—" : `${fmt(run.baselineScore)} → ${fmt(run.trainedScore)}`;
  const loss = run.baselineLoss == null && run.trainedLoss == null ? "—" : `${fmt(run.baselineLoss)} → ${fmt(run.trainedLoss)}${trainAvg}`;
  const delta = run.lossDelta == null ? "—" : `${run.lossDelta > 0 ? "+" : ""}${run.lossDelta.toFixed(3)}`;
  return `<tr>
    <td class="small">${esc(run.runId)}${run.candidate?.modelId ? `<div class="muted" title="candidate model id">${esc(run.candidate.modelId)}</div>` : ""}</td>
    <td>${badge(prom === "promoted" ? "REVIEWED" : prom === "rejected" ? "REJECTED" : "PENDING_REVIEW", run.status)}</td>
    <td>${fmt(run.recordCount)}</td>
    <td class="small">${lineage}${dataCell}</td>
    <td class="small">${esc(run.promotionStatus ?? "—")}${activeCell}</td>
    <td>${score}</td>
    <td>${loss}</td>
    <td>${delta}</td>
    <td class="small reason">${reason ? `<span title="${esc(reason)}">${esc(reason)}</span>` : "—"}</td>
    <td class="small">${when(run.startedAt)}</td>
  </tr>`;
}

function modelsPanel(r) {
  const rows = r.models.slice().reverse().map((m) => `<tr>
    <td class="small">${esc(m.modelId)}</td>
    <td>${esc(m.kind)}</td>
    <td>${badge(m.status === "promoted" ? "REVIEWED" : m.status === "rejected" ? "REJECTED" : "PENDING_REVIEW", m.status)}</td>
    <td>${fmt(m.evaluationScore)}</td>
  </tr>`).join("");
  return `<div class="panel">
    <div class="k">Models (Node registry)</div>
    <table><tr><th>Model</th><th>Kind</th><th>Status</th><th>Score</th></tr>
      ${rows || `<tr><td colspan="4" class="muted">No models.</td></tr>`}
    </table>
    <div class="small muted" style="margin-top:6px">active: ${esc(r.activeModel?.modelId ?? "none")}</div>
  </div>`;
}

function pythonStorePanel(py) {
  return `<div class="panel">
    <div class="k">Python brain store (authoritative for committed artifacts) <span class="sm">${storeStatus()}</span></div>
    ${renderPythonStore(py)}
  </div>`;
}

function evalSetPanel(evalSet) {
  if (!evalSet) return `<div class="panel"><div class="muted">No frozen evaluation set configured.</div></div>`;
  const rows = evalSet.files.map((f) => `<tr>
    <td>${esc(f.file)}</td>
    <td>${f.bytes}</td>
    <td class="small wrap" title="${esc(f.sha256)}">${esc(shortHash(f.sha256))}</td>
  </tr>`).join("");
  return `<div class="panel">
    <div class="k">Frozen evaluation set (identity)</div>
    <div class="small muted">${esc(evalSet.dir)}</div>
    <table><tr><th>File</th><th>Bytes</th><th class="wrap">sha256</th></tr>
      ${rows || `<tr><td colspan="3" class="muted">No files.</td></tr>`}
    </table>
    <div class="small muted">The frozen hold-out the promotion gate scores against — never used for training.</div>
  </div>`;
}

// ------------------------------------------------------- trends & metrics
// The view model is a pure ES module so chart geometry, verdict arithmetic and
// run filtering are testable without a DOM. It is loaded lazily (dynamic import
// keeps app.js parseable as a classic script by the portal asset test).
let trendsModel = null;
async function ensureTrendsModel() {
  if (!trendsModel) trendsModel = await import("./trends-model.js");
  return trendsModel;
}

async function loadTrends() {
  await ensureTrendsModel();
  state.trends = await api(`/metrics${state.selectedVersion ? `?version=${encodeURIComponent(state.selectedVersion)}` : ""}`);
  state.trendsExtrasError = null;
  renderTrends();
  if (state.trendsTab === "events") ensureTrendExtras();
}

function outcomeBadge(outcome) {
  const meta = trendsModel?.outcomeMeta(outcome);
  if (!meta) return badge("PENDING_REVIEW", outcome ?? "?");
  return `<span class="outcome-badge ${esc(meta.className)}"><span class="outcome-glyph" aria-hidden="true">${esc(meta.glyph)}</span>${esc(meta.label)}</span>`;
}

function trendBadge(verdict) {
  const meta = trendsModel?.trendMeta(verdict) ?? { label: "Insufficient evidence", className: "trend-insufficient" };
  return `<span class="trend-badge ${esc(meta.className)}">${esc(meta.label)}</span>`;
}

function metricCard(k, vHtml, hint = "") {
  return `<div class="metric-card">
    <div class="k">${esc(k)}</div>
    <div class="metric-value">${vHtml}</div>
    ${hint ? `<div class="metric-hint">${hint}</div>` : ""}
  </div>`;
}

function metricPair(first, second) {
  return `<span class="metric-pair"><span>${first}</span><span class="metric-arrow">→</span><span>${second}</span></span>`;
}

/**
 * Section sub-tabs. `options` = [[key, label], ...]; the active key lives in
 * `state[stateKey]`, and re-rendering is the caller's job so a tab switch can
 * reuse already-loaded data instead of refetching.
 *
 * `data-subtab`/`data-subkey` are deliberately NOT `data-tab`/`data-key`: the
 * top-level portal nav already uses `data-tab` on its own buttons, and sharing
 * the attribute would make the sub-tab binder leak into the main nav.
 */
function subtabs(stateKey, options) {
  const active = state[stateKey];
  return `<nav class="subtabs">${options
    .map(([key, label]) => `<button type="button" class="${active === key ? "active" : ""}" data-subtab="${stateKey}" data-subkey="${esc(key)}">${esc(label)}</button>`)
    .join("")}</nav>`;
}

/**
 * Wire every `[data-subtab]` button to set its section's key and re-render.
 * Called from the section renderers themselves (not from `render()`), because
 * the tabs are rebuilt by each innerHTML assignment and `load*()` renders
 * without going through `render()`.
 */
function bindSubtabs() {
  for (const btn of main.querySelectorAll("button[data-subtab]")) {
    btn.addEventListener("click", () => {
      const key = btn.dataset.subkey;
      const section = btn.dataset.subtab;
      if (state[section] === key) return;
      state[section] = key;
      if (section === "historyTab") renderHistory();
      else if (section === "trendsTab") renderTrends();
    });
  }
}

function samplingLabel(k) {
  if (k === "periodic") return badge("REVIEWED", "periodic");
  if (k === "endpoints") return badge("PENDING_REVIEW", "endpoints only");
  return badge("INGESTED", "none");
}

function shortHash(h) {
  if (!h) return null;
  return h.length > 12 ? `${h.slice(0, 8)}…${h.slice(-4)}` : h;
}

function renderTrends() {
  const m = state.trends;
  if (!m) return;
  hideChartTooltip();
  const body =
    !m.available
      ? `<div class="panel notice"><div class="title bad">Store unavailable</div><div class="muted">${esc(m.reason ?? "python store unavailable")}</div></div>`
      : m.reason
        ? `<div class="panel notice"><div class="muted">${esc(m.reason)}</div></div>`
        : trendsBody(m);
  main.innerHTML = `<h2 class="section-title">Trends &amp; Metrics <span class="sm">${versionScope()}</span></h2>${body}`;
  bindSubtabs();
  wireTrends();
}

// --------------------------------------------------------- sources & domains
// The domain registry is a live server-side singleton. The browser has no
// direct handle on it, so every number and row here comes from the admin API:
// this tab is a view over persisted state, never a cache that could drift.
async function loadSources() {
  // Never leave the tab blank: a spinner says "measuring", which is the truth.
  main.innerHTML = `<h2 class="section-title">Sources &amp; Domains</h2><div class="panel loading">Loading discovered domains…</div>`;
  let stats = null;
  let domains = [];
  let error = null;
  try {
    const [s, d] = await Promise.all([api("/domains/stats"), api("/domains?limit=200")]);
    stats = s;
    domains = d.items ?? [];
  } catch (err) {
    error = err.message;
  }
  renderSources({ stats, domains, error });
}

function renderSources({ stats, domains, error }) {
  if (error) {
    // A 503 here means "this deployment has no discovery service" — report that
    // honestly instead of rendering an empty table that looks like "no domains".
    const missing = /no rows|not available|inspection-only|503|Unknown table/i.test(error);
    main.innerHTML = `
      <h2 class="section-title">Sources &amp; Domains</h2>
      <div class="panel notice"><div class="title ${missing ? "warn" : "bad"}">Domain registry unavailable</div>
        <div class="muted">${esc(error)}</div>
        <div class="small muted" style="margin-top:6px">Domain discovery, blocking and importance are enforced by the acquisition service. If it is not running, sources cannot be self-expanded.</div></div>`;
    return;
  }

  const s = stats ?? { total: 0, byPolicy: { normal: 0, important: 0, blocked: 0 }, byOrigin: { auto: 0, manual: 0 } };

  main.innerHTML = `
    <h2 class="section-title">Sources &amp; Domains</h2>
    <div class="small muted" style="margin:-6px 0 12px">
      Domains the crawler discovered on its own, plus anything an operator added. Blocking a domain stops the crawler fetching it; marking it
      important gives its articles a modest selection preference. Removing a domain is NOT a block — it can be rediscovered.
    </div>

    <div class="grid" style="margin-bottom:16px">
      <div class="card"><div class="k">Registered domains</div><div class="v">${fmt(s.total)}</div></div>
      <div class="card"><div class="k">Important</div><div class="v">${fmt(s.byPolicy.important)}</div></div>
      <div class="card"><div class="k">Blocked</div><div class="v">${fmt(s.byPolicy.blocked)}</div></div>
      <div class="card"><div class="k">Auto-discovered</div><div class="v">${fmt(s.byOrigin.auto)}</div></div>
      <div class="card"><div class="k">Manually added</div><div class="v">${fmt(s.byOrigin.manual)}</div></div>
    </div>

    <div class="toolbar">
      <input type="text" id="domainSearch" placeholder="Search domains…" style="flex:1; max-width:300px" />
      <select id="domainFilterPolicy">
        <option value="">All policies</option>
        <option value="normal">Normal</option>
        <option value="important">Important</option>
        <option value="blocked">Blocked</option>
      </select>
      <select id="domainFilterOrigin">
        <option value="">All origins</option>
        <option value="auto">Auto-discovered</option>
        <option value="manual">Manually added</option>
      </select>
      <button id="addDomainBtn" class="primary" ${roAttr()}>Add domain</button>
    </div>

    <div class="panel" id="domainTable">
      ${domains.length
        ? `<table><tr><th>Domain</th><th>Policy</th><th>Origin</th><th>URLs found</th><th>Docs kept</th><th>Failures</th><th>Last seen</th><th>Last fetched</th><th></th></tr>${domains.map(domainRow).join("")}</table>`
        : `<div class="empty">No domains discovered yet. Run a learning job with CRAWL_MODE=real and CRAWL_URLS set — discovery expands from those seeds.</div>`}
    </div>

    <div id="addDomainModal" class="hidden">
      <div class="panel" style="max-width:520px; margin:24px auto">
        <div class="toolbar"><strong>Add a domain</strong><button id="closeAddDomainModal">x</button></div>
        <div class="small muted" style="margin:8px 0">A hostname or a full URL — the domain is extracted automatically. No page is fetched by adding it.</div>
        <div class="toolbar">
          <input type="text" id="newDomainInput" placeholder="example.com or https://example.com/page" style="flex:1" />
          <select id="newDomainOrigin" style="width:auto">
            <option value="manual" selected>Manually added</option>
            <option value="auto">Auto-discovered</option>
          </select>
          <button id="confirmAddDomain" class="primary">Add</button>
        </div>
      </div>
    </div>
  `;
  wireDomainActions();
}

function domainRow(d) {
  const policyLabel = d.policy === "blocked" ? "Blocked" : d.policy === "important" ? "Important" : "Normal";
  const actions = [];
  if (d.policy === "blocked") {
    actions.push(`<button class="primary" data-act="unblock" data-domain="${esc(d.domain)}" ${roAttr()}>Unblock</button>`);
  } else {
    actions.push(`<button class="danger" data-act="block" data-domain="${esc(d.domain)}" ${roAttr()}>Block</button>`);
    if (d.policy === "important") {
      actions.push(`<button data-act="unimportant" data-domain="${esc(d.domain)}" ${roAttr()}>Remove importance</button>`);
    } else {
      actions.push(`<button class="primary" data-act="important" data-domain="${esc(d.domain)}" ${roAttr()}>Mark important</button>`);
    }
  }
  actions.push(`<button class="danger" data-act="remove" data-domain="${esc(d.domain)}" ${roAttr()}>Remove</button>`);
  return `<tr data-domain="${esc(d.domain)}" data-policy="${esc(d.policy)}" data-origin="${esc(d.origin)}">
    <td class="wrap" style="max-width:320px">
      <strong>${esc(d.domain)}</strong>
      ${d.firstDiscoveredVia?.parentUrl ? `<div class="small muted" title="first found via a link from">via ${esc(d.firstDiscoveredVia.parentUrl)}</div>` : ""}
      ${d.policyReason ? `<div class="small muted" title="${esc(d.policyReason)}">${esc(d.policyReason)}</div>` : ""}
    </td>
    <td>${badge(d.policy === "blocked" ? "REJECTED" : d.policy === "important" ? "REVIEWED" : "INGESTED", policyLabel)}</td>
    <td class="small">${esc(d.origin === "manual" ? "manual" : "crawler")}</td>
    <td>${fmt(d.urlsDiscovered ?? 0)}</td>
    <td>${fmt(d.documentsFetched ?? 0)}</td>
    <td class="small">${d.failureCount ? `<span class="warn">${fmt(d.failureCount)}</span>${d.lastError ? ` <span class="muted" title="${esc(d.lastError)}">${esc(d.lastError)}</span>` : ""}` : "—"}</td>
    <td class="small">${when(d.lastSeenAt)}</td>
    <td class="small">${when(d.lastSuccessfulFetch)}</td>
    <td class="actions">${actions.join(" ")}</td>
  </tr>`;
}

/** Rows are re-filtered in place, so a long registry is never re-fetched to filter. */
function applyDomainFilters() {
  const search = (document.getElementById("domainSearch")?.value ?? "").toLowerCase();
  const policy = document.getElementById("domainFilterPolicy")?.value ?? "";
  const origin = document.getElementById("domainFilterOrigin")?.value ?? "";
  for (const row of document.getElementById("domainTable")?.querySelectorAll("tr[data-domain]") ?? []) {
    const domain = row.getAttribute("data-domain") ?? "";
    const match =
      domain.includes(search) &&
      (!policy || row.getAttribute("data-policy") === policy) &&
      (!origin || row.getAttribute("data-origin") === origin);
    row.style.display = match ? "" : "none";
  }
}

function wireDomainActions() {
  document.getElementById("domainSearch")?.addEventListener("input", applyDomainFilters);
  document.getElementById("domainFilterPolicy")?.addEventListener("change", applyDomainFilters);
  document.getElementById("domainFilterOrigin")?.addEventListener("change", applyDomainFilters);

  const modal = document.getElementById("addDomainModal");
  document.getElementById("addDomainBtn")?.addEventListener("click", () => modal?.classList.remove("hidden"));
  document.getElementById("closeAddDomainModal")?.addEventListener("click", () => modal?.classList.add("hidden"));
  document.getElementById("confirmAddDomain")?.addEventListener("click", async () => {
    const input = document.getElementById("newDomainInput").value.trim();
    if (!input) return alert("Enter a domain or a URL");
    try {
      const res = await api("/domains", {
        method: "POST",
        body: { domain: input, origin: document.getElementById("newDomainOrigin").value },
      });
      if (res.ok === false) { alert(res.error ?? "Could not add that domain"); return; }
      document.getElementById("newDomainInput").value = "";
      modal?.classList.add("hidden");
      await loadSources();
    } catch (err) { alert(err.message); }
  });

  // Row actions go straight to the API and then reload from authoritative state,
  // so a stale client-side list can never be the source of truth.
  document.getElementById("domainTable")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const domain = btn.getAttribute("data-domain");
    const act = btn.getAttribute("data-act");
    if (!domain || !act) return;
    if (act === "remove" && !confirm(`Remove ${domain} from the registry?\n\nThis does NOT block it: the crawler may rediscover it. Its articles and history are kept.`)) return;
    if (act === "block" && !confirm(`Block ${domain}?\n\nThe crawler will stop fetching that domain and its subdomains. Existing articles are kept.`)) return;

    let endpoint;
    let method = "POST";
    let body = null;
    if (act === "block") { endpoint = `/domains/${encodeURIComponent(domain)}/block`; body = { reason: "blocked by operator" }; }
    else if (act === "unblock") { endpoint = `/domains/${encodeURIComponent(domain)}/unblock`; }
    else if (act === "important") { endpoint = `/domains/${encodeURIComponent(domain)}/important`; body = { important: true }; }
    else if (act === "unimportant") { endpoint = `/domains/${encodeURIComponent(domain)}/important`; body = { important: false }; }
    else if (act === "remove") { endpoint = `/domains/${encodeURIComponent(domain)}`; method = "DELETE"; }
    else return;

    try {
      const res = await api(endpoint, { method, body });
      if (res.ok === false) { alert(res.error ?? "That action was refused"); return; }
      await loadSources();
    } catch (err) { alert(err.message); }
  });
}

function trendsBody(m) {
  const tab = state.trendsTab;
  return `
    ${subtabs("trendsTab", [
      ["trend", "Verdict"],
      ["chart", "Loss chart"],
      ["lineage", `Lineage segments (${(m.segments ?? []).length})`],
      ["events", `Run events (${(m.events ?? []).length})`],
    ])}
    ${tab === "trend" ? renderVerdictTab(m) : ""}
    ${tab === "chart" ? renderLossCharts(m) : ""}
    ${tab === "lineage" ? renderLineageTab(m) : ""}
    ${tab === "events" ? renderRunEventsTab(m) : ""}
  `;
}

function eventsSummary(m) {
  const health = trendsModel?.summarizeEvents(m.events ?? []);
  if (!health?.total) return `<span class="small muted">(none recorded)</span>`;
  const parts = trendsModel.OUTCOMES.map((outcome) => {
    const meta = trendsModel.outcomeMeta(outcome);
    return `${meta.label.toLowerCase()} ${trendsModel.fmtCount(health.counts[outcome] ?? 0)}`;
  });
  return `<span class="small muted">${trendsModel.fmtCount(health.total)} run(s) · ${parts.join(" · ")}</span>`;
}

function outcomeCountPills(health) {
  return trendsModel.OUTCOMES.map((outcome) => {
    const meta = trendsModel.outcomeMeta(outcome);
    return `<span class="outcome-count ${esc(meta.className)}" title="${esc(meta.label)}">
      <span class="outcome-glyph" aria-hidden="true">${esc(meta.glyph)}</span>
      <span>${esc(meta.label)}</span><strong>${trendsModel.fmtCount(health.counts[outcome] ?? 0)}</strong>
    </span>`;
  }).join("");
}

function lossCell(value) {
  return Number.isFinite(value)
    ? `<span class="num">${trendsModel.fmtLoss(value)}</span>`
    : `<span class="muted" title="not recorded">—</span>`;
}

function hashChip(hash) {
  if (!hash) return `<span class="muted">not recorded</span>`;
  return `<code class="hash-chip" title="${esc(hash)}">${esc(shortHash(hash))}</code>`;
}

function samplingText(kind) {
  if (kind === "periodic") return "Periodic validation";
  if (kind === "endpoints") return "Opening/closing endpoints only";
  if (kind === "none" || kind == null) return "No validation recorded";
  return String(kind);
}

// ------------------------------------------------------------------ verdict
function renderVerdictTab(m) {
  const v = trendsModel.buildVerdict(m);
  const validation = v.validation;
  const health = v.runHealth;
  const bestValidation = v.bestValidation;
  const bestFrozen = v.bestFrozen;
  const latestVsBest = validation.lastVsBestRel == null
    ? "—"
    : Math.abs(validation.lastVsBestRel) < 1e-9
      ? "at the best observation"
      : `${trendsModel.fmtPct(Math.abs(validation.lastVsBestRel))} ${validation.lastVsBestRel > 0 ? "above" : "below"} best`;
  const gapText = v.gap == null
    ? "Not available (no training sample at the latest validation step)"
    : `${trendsModel.fmtLoss(v.gap.value)} <span class="muted small">(validation ${trendsModel.fmtLoss(v.gap.validation)} − training ${trendsModel.fmtLoss(v.gap.training)} at step ${trendsModel.fmtCount(v.gap.step)})</span>`;
  const improvement = validation.improvementRel == null
    ? "—"
    : `${trendsModel.fmtPct(validation.improvementRel)}`;
  const evidence = v.evidence ?? {};
  const thresholds = v.thresholds ?? {};

  return `
    <div class="trend-hero ${esc(v.className)}">
      <div class="trend-hero-top">
        ${trendBadge(v.verdict)}
        <span class="trend-hero-context">
          ${v.sufficient
            ? `${trendsModel.fmtCount(validation.points)} held-out validation observation${validation.points === 1 ? "" : "s"}`
            : `Only ${trendsModel.fmtCount(validation.points)} validation observation${validation.points === 1 ? "" : "s"} — insufficient evidence to classify`}
          ${v.effectiveVersion ? ` · ${esc(v.effectiveVersion)}` : ""}
        </span>
      </div>
      <div class="trend-hero-reason">${esc(v.reason)}</div>
      <div class="trend-hero-note">
        Held-out validation is the verdict basis. Training loss is shown for context; frozen evaluation-set scores remain a separate measurement.
      </div>
    </div>

    <div class="metric-grid">
      ${metricCard("Held-out validation", validation.first == null && validation.latest == null ? "—" : metricPair(trendsModel.fmtLoss(validation.first), trendsModel.fmtLoss(validation.latest)), `${improvement} from first to latest · ${trendsModel.fmtCount(validation.points)} samples`)}
      ${metricCard("Best held-out validation", trendsModel.fmtLoss(validation.best), bestValidation ? `Step ${trendsModel.fmtCount(validation.bestStep)} · ${esc(validation.bestVersion ?? "version not recorded")}` : "No finite validation observation")}
      ${metricCard("Latest vs best", latestVsBest, "Compared within held-out validation only")}
      ${metricCard("Steps covered", v.steps.from == null ? "—" : `${trendsModel.fmtCount(v.steps.from)} → ${trendsModel.fmtCount(v.steps.to)}`, v.sampling ? samplingText(v.sampling) : "")}
      ${metricCard("Training loss", v.training.first == null && v.training.latest == null ? "—" : metricPair(trendsModel.fmtLoss(v.training.first), trendsModel.fmtLoss(v.training.latest)), `${trendsModel.fmtCount(v.training.points)} recorded samples · context only`)}
      ${metricCard("Generalisation gap", gapText, "Diagnostic only: validation and training are different splits of the same corpus")}
      ${metricCard("Best frozen evaluation", bestFrozen ? trendsModel.fmtLoss(bestFrozen.loss) : "—", bestFrozen ? `${esc(bestFrozen.runId)}${bestFrozen.version ? ` · ${esc(bestFrozen.version)}` : ""} · separate evaluation set` : "No frozen evaluation recorded")}
      ${metricCard("Effective version", esc(v.effectiveVersion ?? "—"), v.activeVersion ? `Serving pointer: ${esc(v.activeVersion)}${v.activeModel?.modelId ? ` · ${esc(v.activeModel.modelId)}` : ""}` : "No active version recorded")}
    </div>

    <div class="panel trends-health">
      <div class="panel-heading">
        <div>
          <div class="k">Run health</div>
          <div class="small muted">Every recorded run, including runs that never became a version.</div>
        </div>
        <div class="small muted">${trendsModel.fmtCount(health.total)} total</div>
      </div>
      <div class="outcome-counts">${outcomeCountPills(health)}</div>
      <div class="health-facts">
        <div><span class="k">Promotion rate</span><strong>${trendsModel.fmtRate(health.promotionRate)}</strong><span class="small muted">${trendsModel.fmtCount(health.counts.promoted)} promoted / ${trendsModel.fmtCount(health.terminalEvaluated)} gate decisions</span></div>
        <div><span class="k">Evaluation coverage</span><strong>${trendsModel.fmtRate(health.evaluationCoverage)}</strong><span class="small muted">${trendsModel.fmtCount(health.evaluated)} runs with a finite frozen evaluation / ${trendsModel.fmtCount(health.total)}</span></div>
        <div><span class="k">Lineage scope</span><strong>${trendsModel.fmtCount(v.segments)} segment${v.segments === 1 ? "" : "s"}</strong><span class="small muted">Same training-corpus hash · ${hashChip(v.datasetHash)}</span></div>
      </div>
    </div>

    <details class="panel trend-evidence">
      <summary><span class="k">Evidence and thresholds</span></summary>
      <div class="evidence-grid">
        <div><span class="k">Finite validation samples</span><strong>${trendsModel.fmtCount(evidence.points)}</strong></div>
        <div><span class="k">Step range</span><strong>${evidence.firstStep == null ? "—" : `${trendsModel.fmtCount(evidence.firstStep)} → ${trendsModel.fmtCount(evidence.lastStep)}`}</strong></div>
        <div><span class="k">minimum samples</span><strong>${trendsModel.fmtCount(thresholds.minPoints)}</strong></div>
        <div><span class="k">improving drop ≥</span><strong>${trendsModel.fmtRate(thresholds.improveDrop ?? 0)}</strong></div>
        <div><span class="k">worsening rise ≥</span><strong>${trendsModel.fmtRate(thresholds.worsenRise ?? 0)}</strong></div>
        <div><span class="k">overfit from best ≥</span><strong>${trendsModel.fmtRate(thresholds.overfitValRise ?? 0)}</strong></div>
      </div>
      <div class="small muted evidence-note">
        Verdict is a deterministic, threshold-based function of finite held-out validation observations. Training loss is never compared with frozen evaluation-set loss.
      </div>
    </details>
  `;
}

// ------------------------------------------------------------------- charts
function chartTip(lines) {
  return lines.filter(Boolean).join("\n");
}

function trainingTip(point, kind) {
  return chartTip([
    kind === "validation" ? "Held-out validation observation" : "In-run training sample",
    `Step ${trendsModel.fmtCount(point.step)}`,
    `Loss ${trendsModel.fmtLoss(point.loss)}`,
    point.version ? `Version ${point.version}` : "Version not recorded",
    "Timestamp not recorded for this sample",
  ]);
}

function runTip(event, m) {
  const detail = trendsModel.buildRunDetail(event, {
    ...(state.trendsExtras ?? {}),
    evaluationSet: m?.evaluationSet ?? null,
  });
  return chartTip([
    `Run ${detail.runId}`,
    detail.meta?.label ?? detail.outcome,
    detail.version ? `Version ${detail.version}` : "Version not recorded",
    Number.isFinite(detail.loss) ? `Frozen evaluation loss ${trendsModel.fmtLoss(detail.loss)}` : "Frozen evaluation loss not recorded",
    detail.evaluationDatasetHash ? `Evaluation set ${shortHash(detail.evaluationDatasetHash)}` : "Evaluation-set identity not recorded",
    `When ${trendsModel.formatDateTime(detail.trainedAt ?? detail.startedAt)}`,
    Number.isFinite(detail.trainingSteps) ? `Training steps ${trendsModel.fmtCount(detail.trainingSteps)}` : null,
    Number.isFinite(detail.tokensSeen) ? `Tokens ${trendsModel.fmtCount(detail.tokensSeen)}` : null,
    detail.datasetHash ? `Training corpus ${shortHash(detail.datasetHash)}` : null,
    detail.inLineage ? "Inside selected lineage" : "Outside selected lineage",
  ]);
}

function svgOutcomeShape(meta, x, y, radius = 4.6) {
  const r = radius;
  const cls = `outcome-mark ${meta.className}`;
  const cx = Number(x).toFixed(1);
  const cy = Number(y).toFixed(1);
  if (meta.shape === "square") {
    return `<rect class="${cls}" x="${(x - r).toFixed(1)}" y="${(y - r).toFixed(1)}" width="${2 * r}" height="${2 * r}" rx="1"/>`;
  }
  if (meta.shape === "diamond") {
    return `<polygon class="${cls}" points="${cx},${(y - r).toFixed(1)} ${(x + r).toFixed(1)},${cy} ${cx},${(y + r).toFixed(1)} ${(x - r).toFixed(1)},${cy}"/>`;
  }
  if (meta.shape === "triangle") {
    return `<polygon class="${cls}" points="${cx},${(y - r).toFixed(1)} ${(x + r).toFixed(1)},${(y + r).toFixed(1)} ${(x - r).toFixed(1)},${(y + r).toFixed(1)}"/>`;
  }
  return `<circle class="${cls}" cx="${cx}" cy="${cy}" r="${r}"/>`;
}

function trainingChartSvg(model) {
  if (model.empty) {
    return `<div class="chart-empty">${esc(model.reason)}</div>`;
  }
  const { width, height, padding, plot } = model;
  const trainPath = model.training.length
    ? model.training.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")
    : "";
  const guide = state.trendsView.connectValidation && model.validation.length > 1
    ? model.validation.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")
    : "";
  const trainDots = model.training.length <= 260
    ? model.training.map((p) => `<circle class="chart-training-dot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="1.6"><title>${esc(trainingTip(p, "training"))}</title></circle>`).join("")
    : "";
  const best = model.bestValidation;
  const bestLabelX = best ? (best.x > width * 0.72 ? best.x - 10 : best.x + 10) : 0;
  return `
    <div class="chart-scroll">
      <svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Training loss and discrete held-out validation observations over recorded training steps">
        <defs><clipPath id="trainingPlotClip"><rect x="${plot.left}" y="${plot.top}" width="${plot.right - plot.left}" height="${plot.bottom - plot.top}"/></clipPath></defs>
        <g class="chart-grid">
          ${model.yTicks.map((tick) => `<line x1="${plot.left}" y1="${tick.y.toFixed(1)}" x2="${plot.right}" y2="${tick.y.toFixed(1)}"/>`).join("")}
        </g>
        <g class="chart-axis-labels">
          ${model.yTicks.map((tick) => `<text x="${plot.left - 10}" y="${(tick.y + 4).toFixed(1)}" text-anchor="end">${trendsModel.fmtLoss(tick.value)}</text>`).join("")}
          ${model.xTicks.map((tick) => `<text x="${tick.x.toFixed(1)}" y="${plot.bottom + 22}" text-anchor="middle">${trendsModel.fmtCount(tick.value)}</text>`).join("")}
          <text x="${plot.left}" y="${height - 8}" class="axis-title">${model.segmentCount > 1 ? "cumulative lineage step" : "training step"}</text>
          <text x="${plot.left}" y="14" class="axis-title">loss (nats)</text>
        </g>
        <line class="chart-axis" x1="${plot.left}" y1="${plot.top}" x2="${plot.left}" y2="${plot.bottom}"/>
        <line class="chart-axis" x1="${plot.left}" y1="${plot.bottom}" x2="${plot.right}" y2="${plot.bottom}"/>
        <g clip-path="url(#trainingPlotClip)">
          ${guide ? `<path class="chart-validation-guide" d="${guide}"/>` : ""}
          ${trainPath ? `<path class="chart-training-line" d="${trainPath}"/>` : ""}
          ${trainDots}
          ${model.validation.map((p) => `<g class="chart-mark" tabindex="0" data-tip="${esc(trainingTip(p, "validation"))}" aria-label="${esc(trainingTip(p, "validation").replace(/\n/g, ", "))}"><circle class="chart-validation-dot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4"/></g>`).join("")}
          ${best ? `<line class="chart-best-line" x1="${best.x.toFixed(1)}" y1="${plot.top}" x2="${best.x.toFixed(1)}" y2="${plot.bottom}"/>` : ""}
        </g>
        ${best ? `<g class="chart-best-label">
          <circle class="chart-best-dot" cx="${best.x.toFixed(1)}" cy="${best.y.toFixed(1)}" r="6"/>
          <text x="${bestLabelX.toFixed(1)}" y="${Math.max(plot.top + 12, best.y - 12).toFixed(1)}" text-anchor="${best.x > width * 0.72 ? "end" : "start"}">best ${trendsModel.fmtLoss(best.loss)} · step ${trendsModel.fmtCount(best.step)}${best.version ? ` · ${esc(best.version)}` : ""}</text>
        </g>` : ""}
      </svg>
    </div>`;
}

function runOutcomeChartSvg(model) {
  if (model.empty) {
    return `<div class="chart-empty">${esc(model.reason)}</div>${model.unmeasured?.length ? unmeasuredStrip(model) : ""}`;
  }
  const { width, height, padding, plot, strip } = model;
  const best = model.best;
  const markerRadius = model.total > 400 ? 2.7 : model.total > 150 ? 3.4 : 4.6;
  return `
    <div class="chart-scroll">
      <svg class="chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Frozen evaluation-set loss by run, with outcomes distinguished by shape and colour">
        <defs><clipPath id="runPlotClip"><rect x="${plot.left}" y="${plot.top}" width="${plot.right - plot.left}" height="${plot.bottom - plot.top}"/></clipPath></defs>
        <g class="chart-grid">
          ${model.yTicks.map((tick) => `<line x1="${plot.left}" y1="${tick.y.toFixed(1)}" x2="${plot.right}" y2="${tick.y.toFixed(1)}"/>`).join("")}
        </g>
        <g class="chart-axis-labels">
          ${model.yTicks.map((tick) => `<text x="${plot.left - 10}" y="${(tick.y + 4).toFixed(1)}" text-anchor="end">${trendsModel.fmtLoss(tick.value)}</text>`).join("")}
          ${model.xTicks.map((tick) => `<text x="${tick.x.toFixed(1)}" y="${plot.bottom + 22}" text-anchor="middle">${esc(tick.label)}</text>`).join("")}
          <text x="${plot.left}" y="14" class="axis-title">frozen evaluation-set loss (nats)</text>
          <text x="${plot.left}" y="${height - 8}" class="axis-title">${model.xMode === "time" ? "run timestamp" : "run sequence (oldest → newest)"}</text>
        </g>
        <line class="chart-axis" x1="${plot.left}" y1="${plot.top}" x2="${plot.left}" y2="${plot.bottom}"/>
        <line class="chart-axis" x1="${plot.left}" y1="${plot.bottom}" x2="${plot.right}" y2="${plot.bottom}"/>
        <g clip-path="url(#runPlotClip)">
          ${model.measured.map((p) => `<g class="chart-mark" tabindex="0" data-tip="${esc(runTip(p.event, state.trends))}" aria-label="${esc(runTip(p.event, state.trends).replace(/\n/g, ", "))}">${svgOutcomeShape(p.meta, p.x, p.y, markerRadius)}</g>`).join("")}
          ${best ? `<circle class="chart-best-ring" cx="${best.x.toFixed(1)}" cy="${best.y.toFixed(1)}" r="9"/>` : ""}
        </g>
        ${strip ? unmeasuredStripSvg(model) : ""}
      </svg>
    </div>`;
}

function unmeasuredStripSvg(model) {
  const { plot, strip, width } = model;
  return `<g class="chart-unmeasured-strip">
    <line class="chart-strip-axis" x1="${plot.left}" y1="${strip.top.toFixed(1)}" x2="${width - model.padding.right}" y2="${strip.top.toFixed(1)}"/>
    <text x="${plot.left}" y="${(strip.top + 13).toFixed(1)}" class="axis-title">no frozen evaluation recorded (${trendsModel.fmtCount(model.unmeasuredCount)})</text>
    ${model.unmeasured.map((p) => `<g class="chart-mark" tabindex="0" data-tip="${esc(runTip(p.event, state.trends))}" aria-label="${esc(runTip(p.event, state.trends).replace(/\n/g, ", "))}">${svgOutcomeShape(p.meta, p.x, strip.y, 3.4)}</g>`).join("")}
  </g>`;
}

function unmeasuredStrip(model) {
  if (!model.unmeasured?.length) return "";
  return `<div class="small muted chart-strip-note">${trendsModel.fmtCount(model.unmeasuredCount)} run(s) have no recorded frozen evaluation-set loss. They are listed here and remain visible in Run events; they are not plotted on the loss axis.</div>`;
}

function outcomeLegend(events) {
  const health = trendsModel.summarizeEvents(events);
  return trendsModel.OUTCOMES.map((outcome) => {
    const meta = trendsModel.outcomeMeta(outcome);
    return `<span class="legend-item outcome-legend ${esc(meta.className)}" title="${esc(meta.label)}">
      <span class="legend-glyph" aria-hidden="true">${esc(meta.glyph)}</span>
      ${esc(meta.label)} <strong>${trendsModel.fmtCount(health.counts[outcome] ?? 0)}</strong>
    </span>`;
  }).join("");
}

function renderLossCharts(m) {
  const training = trendsModel.buildTrainingChart(m);
  const runs = trendsModel.buildRunOutcomeChart(m, { xMode: state.trendsView.xMode });
  const effective = (m.segments ?? []).find((s) => s.version === m.effectiveVersion) ?? (m.segments ?? [])[0] ?? null;
  const collisions = m.chain?.collisions ?? 0;
  const trainingTotal = training.trainingTotal ?? training.trainingCount ?? 0;
  const validationTotal = training.validationTotal ?? training.validationCount ?? 0;
  const identityRecorded = runs.identityRecorded ?? 0;
  const citedHashes = runs.citedHashCount ?? 0;
  return `
    <div class="panel chart-panel">
      <div class="panel-heading">
        <div>
          <div class="k">Training &amp; held-out validation</div>
          <div class="small muted">In-run training samples and discrete held-out observations on the same corpus. No interpolation.</div>
        </div>
        <div class="chart-controls">
          <label class="small muted"><input type="checkbox" data-trends-action="toggle-guide" ${state.trendsView.connectValidation ? "checked" : ""}/> connect validation samples (guide only)</label>
        </div>
      </div>
      <div class="chart-legend">
        <span class="legend-item"><span class="legend-line training"></span>Training loss (measured per step)</span>
        <span class="legend-item"><span class="legend-dot validation"></span>Held-out validation observation</span>
        ${training.bestValidation ? `<span class="legend-item"><span class="legend-dot best"></span>Best validation · ${trendsModel.fmtLoss(training.bestValidation.loss)}</span>` : ""}
      </div>
      ${trainingChartSvg(training)}
      <div class="chart-caption small muted">
        ${training.empty ? "" : `${trendsModel.fmtCount(trainingTotal)} training sample${trainingTotal === 1 ? "" : "s"} and ${trendsModel.fmtCount(validationTotal)} validation observation${validationTotal === 1 ? "" : "s"}.`}
        ${training.trainingCount < trainingTotal || training.validationCount < validationTotal ? ` Showing ${trendsModel.fmtCount(training.trainingCount)} training and ${trendsModel.fmtCount(training.validationCount)} validation points after render decimation.` : ""}
        ${training.sampling && training.sampling !== "periodic" ? ` ${esc(samplingText(training.sampling))} — set <code>TRAIN_EVAL_EVERY ≥ 1</code> to record a denser curve.` : ""}
        ${training.segmentCount > 1 ? ` This lineage has ${trendsModel.fmtCount(training.segmentCount)} segments; the x-axis is a cumulative lineage sequence because each segment starts at its own step 0.` : ""}
        ${collisions ? `<span class="bad"> ${trendsModel.fmtCount(collisions)} step collision(s) remain between lineage segments; treat the sequence axis as approximate.</span>` : ""}
      </div>
    </div>

    <div class="panel chart-panel">
      <div class="panel-heading">
        <div>
          <div class="k">Frozen evaluation-set runs</div>
          <div class="small muted">Each point is one recorded run. No line is drawn between evaluations.</div>
        </div>
        <div class="chart-controls">
          <div class="segmented">
            <button type="button" class="${state.trendsView.xMode === "sequence" ? "active" : ""}" data-trends-action="x-mode" data-mode="sequence">Run sequence</button>
            <button type="button" class="${state.trendsView.xMode === "time" ? "active" : ""}" data-trends-action="x-mode" data-mode="time">Timestamp</button>
          </div>
        </div>
      </div>
      <div class="chart-legend run-legend">
        ${outcomeLegend(m.events ?? [])}
        ${runs.best ? `<span class="legend-item best-frozen"><span class="legend-dot best"></span>Best frozen ${trendsModel.fmtLoss(runs.best.event.loss)} · ${esc(runs.best.event.runId)}${runs.best.event.version ? ` / ${esc(runs.best.event.version)}` : ""}</span>` : ""}
      </div>
      ${runOutcomeChartSvg(runs)}
      <div class="chart-caption small muted">
        ${runs.empty ? "" : `${trendsModel.fmtCount(runs.measuredCount)} measured run(s) across ${trendsModel.fmtCount(runs.total)} recorded runs.`}
        ${runs.unmeasuredCount ? ` ${trendsModel.fmtCount(runs.unmeasuredCount)} run(s) without a recorded frozen evaluation remain visible in the strip below.` : ""}
        ${identityRecorded ? ` Evaluation-set identity is recorded for ${trendsModel.fmtCount(identityRecorded)} run(s).` : " Per-run evaluation-set identity is not recorded as a field in the current ledger."}
        ${citedHashes ? ` ${trendsModel.fmtCount(citedHashes)} run(s) cite an evaluation-set hash in the stored decision reason; open a run to see it.` : ""}
        ${runs.tieGroups ? ` ${trendsModel.fmtCount(runs.tieGroups)} timestamp group(s) share an instant and are spread horizontally for visibility only.` : ""}
        Training-step placement is intentionally not offered for runs: most runs have no recorded step in the selected lineage, which is what previously compressed every marker at the lineage end.
      </div>
    </div>
  `;
}

// ------------------------------------------------------------------ lineage
function segmentBestValidation(m, version) {
  return (m.chain?.points ?? [])
    .filter((p) => p.version === version && Number.isFinite(p.loss))
    .reduce((best, p) => (best === null || p.loss < best.loss ? p : best), null);
}

function segmentTrainingEnds(segment) {
  if (Number.isFinite(segment.initialTrainLoss) || Number.isFinite(segment.finalTrainLoss)) {
    return { first: segment.initialTrainLoss ?? null, last: segment.finalTrainLoss ?? null };
  }
  return { first: null, last: null };
}

function segmentRunHealth(m, segment) {
  const events = (m.events ?? []).filter((e) => e.version === segment.version);
  return trendsModel.summarizeEvents(events);
}

function segmentCard(m, segment) {
  const best = segmentBestValidation(m, segment.version);
  const train = segmentTrainingEnds(segment);
  const health = segment.runs ?? segmentRunHealth(m, segment);
  const effective = segment.isEffective || segment.version === m.effectiveVersion;
  return `<article class="segment-card ${effective ? "effective" : ""}">
    <header>
      <div>
        <div class="segment-version">${esc(segment.version)} ${effective ? `<span class="pill on">effective</span>` : ""}</div>
        <div class="small muted">${segment.committedAt ? when(segment.committedAt) : "commit time not recorded"}</div>
      </div>
      <div class="segment-actions">
        <button type="button" data-trends-action="show-chart">View chart</button>
        <button type="button" data-trends-action="show-runs" data-version="${esc(segment.version)}">View runs</button>
      </div>
    </header>
    <div class="segment-facts">
      <div><span class="k">Sampling</span><strong>${esc(samplingText(segment.sampling))}</strong><span class="small muted">${Number.isFinite(segment.evalEvery) && segment.evalEvery > 0 ? `every ${trendsModel.fmtCount(segment.evalEvery)} steps` : "no cadence recorded"}</span></div>
      <div><span class="k">Steps</span><strong>${trendsModel.fmtCount(segment.stepsCompleted)}</strong><span class="small muted">${segment.resumedFromStep ? `resumed from ${trendsModel.fmtCount(segment.resumedFromStep)}` : "trained from step 0"}</span></div>
      <div><span class="k">Validation</span><strong>${segment.initialValidationLoss == null && segment.finalValidationLoss == null ? "—" : `${trendsModel.fmtLoss(segment.initialValidationLoss)} → ${trendsModel.fmtLoss(segment.finalValidationLoss)}`}</strong><span class="small muted">${best ? `best ${trendsModel.fmtLoss(best.loss)} · step ${trendsModel.fmtCount(best.step)}` : "no finite observation"}</span></div>
      <div><span class="k">Training</span><strong>${train.first == null && train.last == null ? "—" : `${trendsModel.fmtLoss(train.first)} → ${trendsModel.fmtLoss(train.last)}`}</strong><span class="small muted">recorded endpoints</span></div>
      <div><span class="k">Tokens seen</span><strong>${trendsModel.fmtCount(segment.tokensSeen)}</strong><span class="small muted">${Number.isFinite(segment.wallSeconds) ? `${trendsModel.formatDuration(segment.wallSeconds * 1000)} wall time` : "wall time not recorded"}</span></div>
      <div><span class="k">Parent version</span><strong>${esc(segment.parentVersion ?? "—")}</strong><span class="small muted">recorded parent, not necessarily same corpus</span></div>
    </div>
    <div class="segment-runs">
      <div class="k">Runs linked to this version <span class="muted small">${trendsModel.fmtCount(health.total)}</span></div>
      <div class="outcome-counts compact">${outcomeCountPills(health)}</div>
    </div>
    ${segment.stopReason ? `<div class="small muted">Stop reason: ${esc(segment.stopReason)}</div>` : ""}
    ${segment.stoppedEarly ? `<div class="small warn">Training stopped early.</div>` : ""}
  </article>`;
}

function renderLineageTab(m) {
  const segments = m.segments ?? [];
  const lineage = m.lineage ?? {};
  const runs = lineage.runs ?? trendsModel.summarizeEvents((m.events ?? []).filter((e) => e.inLineage));
  if (!segments.length) {
    return `<div class="panel"><div class="k">Lineage segments</div><div class="empty">No trained segments share this training-corpus hash.</div></div>`;
  }
  const single = segments.length === 1;
  const stepFrom = lineage.fromStep ?? m.chain?.fromStep ?? null;
  const stepTo = lineage.toStep ?? m.chain?.toStep ?? null;
  const committedFrom = lineage.committedFrom ?? segments.map((s) => s.committedAt).filter(Boolean).sort()[0] ?? null;
  const committedTo = lineage.committedTo ?? segments.map((s) => s.committedAt).filter(Boolean).sort().at(-1) ?? null;
  const outside = Number.isFinite(lineage.otherVersionsOutsideLineage) ? lineage.otherVersionsOutsideLineage : null;
  return `
    <div class="panel">
      <div class="panel-heading">
        <div>
          <div class="k">Lineage overview</div>
          <div class="small muted">A segment is a training session on the same recorded corpus hash. Different hashes are different measurements, not omitted segments.</div>
        </div>
        <div class="lineage-scope">${hashChip(m.datasetHash)}</div>
      </div>
      <div class="lineage-facts">
        <div><span class="k">Segments</span><strong>${trendsModel.fmtCount(segments.length)}</strong><span class="small muted">${single ? "single genuine segment" : "sequential trainings"}</span></div>
        <div><span class="k">Steps covered</span><strong>${stepFrom == null ? "—" : `${trendsModel.fmtCount(stepFrom)} → ${trendsModel.fmtCount(stepTo)}`}</strong><span class="small muted">cumulative lineage sequence</span></div>
        <div><span class="k">Committed</span><strong>${committedFrom ? when(committedFrom) : "—"}</strong><span class="small muted">${committedTo ? `to ${when(committedTo)}` : ""}</span></div>
        <div><span class="k">Runs in lineage</span><strong>${trendsModel.fmtCount(runs.total)}</strong><span class="small muted">${trendsModel.fmtCount(runs.counts?.promoted ?? 0)} promoted</span></div>
        ${Number.isFinite(lineage.committedVersionCount) ? `<div><span class="k">Committed versions</span><strong>${trendsModel.fmtCount(lineage.committedVersionCount)}</strong><span class="small muted">${Number.isFinite(lineage.distinctDatasetHashes) ? `${trendsModel.fmtCount(lineage.distinctDatasetHashes)} distinct corpus hashes` : ""}</span></div>` : ""}
      </div>
      <div class="lineage-note small muted">
        ${single
          ? `Only one committed version shares this training-corpus hash, so this is a genuine single-segment lineage rather than missing data.${Number.isFinite(outside) ? ` ${trendsModel.fmtCount(outside)} other committed version${outside === 1 ? "" : "s"} trained on a different corpus hash and are outside this segment.` : ""}`
          : `${trendsModel.fmtCount(segments.length)} segments share this corpus hash. Each trained from its own step 0; the chart uses a cumulative sequence axis so they do not overwrite each other.`}
      </div>
      <div class="segment-timeline ${single ? "single" : ""}">
        ${segments.map((segment) => segmentCard(m, segment)).join("")}
      </div>
    </div>`;
}

// ---------------------------------------------------------------- run events
function ensureTrendExtras({ force = false } = {}) {
  if (state.trendsExtrasLoading) return;
  if (!state.trends && !force) return;
  if (state.trendsExtras && !force) return;
  const m = state.trends;
  if (!m) return;
  if (!force && !trendsModel.runDetailsNeedHistory(m.events ?? [])) return;
  state.trendsExtrasLoading = true;
  state.trendsExtrasError = null;
  const box = document.getElementById("trendsRunExtrasStatus");
  if (box) box.innerHTML = `<span class="spinner"></span> Loading durable run details…`;
  api("/training-history")
    .then((history) => {
      state.trendsExtras = trendsModel.indexHistory(history);
      state.trendsExtrasError = null;
    })
    .catch((err) => {
      state.trendsExtrasError = err.message;
    })
    .finally(() => {
      state.trendsExtrasLoading = false;
      const status = document.getElementById("trendsRunExtrasStatus");
      if (status) {
        status.innerHTML = state.trendsExtrasError
          ? `<span class="warn">Run details unavailable: ${esc(state.trendsExtrasError)}</span>`
          : `<span class="ok">Durable run details loaded.</span>`;
      }
      refreshRunTable();
    });
}

function enrichedRunEvents(m) {
  const extras = {
    ...(state.trendsExtras ?? {}),
    evaluationSet: m?.evaluationSet ?? null,
  };
  return (m?.events ?? []).map((event) => trendsModel.buildRunDetail(event, extras));
}

function refreshRunTable() {
  const box = document.getElementById("trendsRunTable");
  if (!box || !state.trends) return;
  box.innerHTML = runTableMarkup(state.trends);
  const sort = document.getElementById("trendRunSort");
  if (sort) sort.value = state.trendsView.runSort;
  const pageSize = document.getElementById("trendRunPageSize");
  if (pageSize) pageSize.value = String(state.trendsView.runPageSize);
}

function nextSort(kind) {
  const current = state.trendsView.runSort;
  if (kind === "timestamp") return current === "newest" ? "oldest" : "newest";
  if (kind === "loss") return current === "loss-asc" ? "loss-desc" : "loss-asc";
  if (kind === "validation") return current === "validation-asc" ? "validation-desc" : "validation-asc";
  return "run-asc";
}

function sortButton(label, kind) {
  const active = kind === "timestamp"
    ? (state.trendsView.runSort === "newest" || state.trendsView.runSort === "oldest")
    : kind === "loss"
      ? (state.trendsView.runSort === "loss-asc" || state.trendsView.runSort === "loss-desc")
      : kind === "validation"
        ? (state.trendsView.runSort === "validation-asc" || state.trendsView.runSort === "validation-desc")
        : state.trendsView.runSort === "run-asc";
  const arrow = active
    ? (state.trendsView.runSort.endsWith("-desc") || state.trendsView.runSort === "newest" ? " ↓" : " ↑")
    : "";
  return `<button type="button" class="th-sort ${active ? "active" : ""}" data-trends-action="run-sort" data-sort="${esc(kind)}">${esc(label)}${arrow}</button>`;
}

function runDetailPanel(detail, m) {
  const row = (label, value) => `<div class="run-detail-item"><span class="k">${esc(label)}</span><span>${value}</span></div>`;
  const statusNote = detail.statusNote && (!detail.decisionReason || detail.outcome === "failed")
    ? `<div class="run-detail-reason"><div class="k">Stored run-event note</div><div class="prose">${esc(detail.statusNote)}</div></div>`
    : "";
  return `<div class="run-detail">
    <div class="run-detail-grid">
      ${row("Run ID", esc(detail.runId))}
      ${row("Model", esc(detail.modelId ?? "—"))}
      ${row("Version", esc(detail.version ?? "—"))}
      ${row("Parent version", esc(detail.parentVersion ?? "—"))}
      ${row("Outcome", outcomeBadge(detail.outcome))}
      ${row("Dataset", esc(detail.datasetId ?? "—"))}
      ${row("Started", when(detail.startedAt))}
      ${row("Ended", when(detail.endedAt))}
      ${row("Duration", trendsModel.formatDuration(detail.durationMs))}
      ${row("Frozen evaluation loss", lossCell(detail.loss))}
      ${row("Evaluation delta", Number.isFinite(detail.evaluationDelta) ? trendsModel.fmtLoss(detail.evaluationDelta) : "—")}
      ${row("Held-out validation loss", lossCell(detail.validationLoss))}
      ${row("Training steps", Number.isFinite(detail.trainingSteps) ? trendsModel.fmtCount(detail.trainingSteps) : "—")}
      ${row("Tokens seen", Number.isFinite(detail.tokensSeen) ? trendsModel.fmtCount(detail.tokensSeen) : "—")}
      ${row("Activated version", esc(detail.activatedVersion ?? "—"))}
      ${row("Checkpoint", detail.checkpointPath ? `<code class="path-chip" title="${esc(detail.checkpointPath)}">${esc(detail.checkpointPath)}</code>` : "—")}
      ${row("Training corpus", hashChip(detail.datasetHash))}
      ${row("Lineage", detail.inLineage ? "Inside selected lineage" : "Outside selected lineage")}
      ${row("Evaluation-set hash", detail.evaluationDatasetHash
        ? hashChip(detail.evaluationDatasetHash)
        : detail.citedHashes?.length
          ? `<span class="muted">not recorded as a field; ${trendsModel.fmtCount(detail.citedHashes.length)} hash(es) cited in the reason</span>`
          : `<span class="muted">not recorded</span>`)}
    </div>
    <div class="run-detail-reason"><div class="k">Stored decision reason</div>${detail.decisionReason ? `<div class="prose">${esc(detail.decisionReason)}</div>` : `<div class="muted">No stored decision reason for this run.</div>`}</div>
    ${statusNote}
    ${detail.citedHashes?.length ? `<div class="run-detail-hashes"><div class="k">Hashes cited in the recorded reason</div>${detail.citedHashes.map((h) => `<span class="hash-chip" title="${esc(h)}">${esc(shortHash(h))}</span>`).join(" ")}</div>` : ""}
    ${m?.evaluationSet?.files?.length ? `<div class="small muted run-detail-evalset">Current configured frozen evaluation set: ${m.evaluationSet.files.map((f) => `<code title="${esc(f.sha256)}">${esc(f.file)}</code>`).join(" · ")}. This is the current configuration, not necessarily this run's identity.</div>` : ""}
  </div>`;
}

function runTableMarkup(m) {
  const events = enrichedRunEvents(m);
  const filtered = trendsModel.filterRuns(events, state.trendsView);
  const sorted = trendsModel.sortRuns(filtered, state.trendsView.runSort);
  const page = trendsModel.paginateRuns(sorted, state.trendsView.runPage, state.trendsView.runPageSize);
  state.trendsView.runPage = page.page;
  const hasValidation = events.some((e) => Number.isFinite(e.validationLoss));
  const hasSteps = events.some((e) => Number.isFinite(e.trainingSteps));
  const hasDuration = events.some((e) => Number.isFinite(e.durationMs));
  const columns = 6 + (hasValidation ? 1 : 0) + (hasSteps ? 1 : 0);
  if (!events.length) {
    return `<div class="empty">No runs recorded for this store yet.</div>`;
  }
  const rows = page.items.map((detail) => {
    const expanded = state.trendsView.runExpanded === detail.runId;
    return `<tr class="run-row ${expanded ? "expanded" : ""}" data-run-id="${esc(detail.runId)}" data-trends-action="toggle-run">
      <td class="small">${esc(detail.runId)}${detail.modelId ? `<div class="muted">${esc(detail.modelId)}</div>` : ""}</td>
      <td class="small">${esc(detail.version ?? "—")}${detail.parentVersion ? `<div class="muted">← ${esc(detail.parentVersion)}</div>` : ""}</td>
      <td>${outcomeBadge(detail.outcome)}</td>
      <td class="num">${lossCell(detail.loss)}</td>
      ${hasValidation ? `<td class="num">${lossCell(detail.validationLoss)}</td>` : ""}
      ${hasSteps ? `<td class="num">${Number.isFinite(detail.trainingSteps) ? trendsModel.fmtCount(detail.trainingSteps) : `<span class="muted">—</span>`}</td>` : ""}
      <td class="small">${when(detail.trainedAt ?? detail.startedAt)}${hasDuration && Number.isFinite(detail.durationMs) ? `<div class="muted">${trendsModel.formatDuration(detail.durationMs)}</div>` : ""}</td>
      <td class="run-expand-cell"><span class="run-expand" aria-hidden="true">${expanded ? "▾" : "▸"}</span></td>
    </tr>
    ${expanded ? `<tr class="run-detail-row"><td colspan="${columns}">${runDetailPanel(detail, m)}</td></tr>` : ""}`;
  }).join("");

  return `<div class="run-table-wrap">
    <table class="data run-table">
      <thead><tr>
        <th>${sortButton("Run", "run")}</th>
        <th>Version</th>
        <th>Outcome</th>
        <th>${sortButton("Frozen loss", "loss")}</th>
        ${hasValidation ? `<th>${sortButton("Held-out validation", "validation")}</th>` : ""}
        ${hasSteps ? `<th>Steps</th>` : ""}
        <th>${sortButton("Timestamp", "timestamp")}</th>
        <th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <div class="run-pagination">
    <span class="small muted">Showing ${trendsModel.fmtCount(page.start)}–${trendsModel.fmtCount(page.end)} of ${trendsModel.fmtCount(page.total)}${filtered.length !== events.length ? ` (filtered from ${trendsModel.fmtCount(events.length)})` : ""}</span>
    <span class="pagination-controls">
      <button type="button" data-trends-action="run-page" data-page="prev" ${page.page <= 1 ? "disabled" : ""}>← Prev</button>
      <span class="small muted">Page ${trendsModel.fmtCount(page.page)} of ${trendsModel.fmtCount(page.pages)}</span>
      <button type="button" data-trends-action="run-page" data-page="next" ${page.page >= page.pages ? "disabled" : ""}>Next →</button>
    </span>
  </div>`;
}

function renderRunEventsTab(m) {
  const versions = [...new Set((m.events ?? []).map((e) => e.version).filter(Boolean))].sort();
  const view = state.trendsView;
  const needsHistory = trendsModel.runDetailsNeedHistory(m.events ?? []);
  if (!state.trendsExtras && !state.trendsExtrasLoading && needsHistory) {
    setTimeout(() => ensureTrendExtras(), 0);
  }
  const extrasStatus = state.trendsExtrasLoading
    ? `<span class="spinner"></span> Loading durable run details…`
    : state.trendsExtrasError
      ? `<span class="warn">Run details unavailable: ${esc(state.trendsExtrasError)}</span>`
      : state.trendsExtras
        ? `<span class="ok">Durable run details loaded.</span>`
        : needsHistory
          ? `<span class="muted">Durable reasons/steps load on demand.</span>`
          : `<span class="ok">Durable details included in this response.</span>`;
  return `<div class="panel">
    <div class="panel-heading">
      <div>
        <div class="k">Run events <span class="sm">${eventsSummary(m)}</span></div>
        <div class="small muted">Every recorded run, including runs that were rejected, failed or never produced a version.</div>
      </div>
      <div class="small" id="trendsRunExtrasStatus">${extrasStatus}</div>
    </div>
    <div class="run-toolbar">
      <input type="search" id="trendRunSearch" placeholder="Search run, version, model or dataset…" value="${esc(view.runQuery)}" />
      <select id="trendRunOutcome">
        <option value="">All outcomes</option>
        ${trendsModel.OUTCOMES.map((outcome) => `<option value="${esc(outcome)}" ${view.runOutcome === outcome ? "selected" : ""}>${esc(trendsModel.outcomeMeta(outcome).label)}</option>`).join("")}
      </select>
      <select id="trendRunVersion">
        <option value="">All versions</option>
        ${versions.map((version) => `<option value="${esc(version)}" ${view.runVersion === version ? "selected" : ""}>${esc(version)}</option>`).join("")}
      </select>
      <select id="trendRunSort" title="Sort runs">
        <option value="newest" ${view.runSort === "newest" ? "selected" : ""}>Newest first</option>
        <option value="oldest" ${view.runSort === "oldest" ? "selected" : ""}>Oldest first</option>
        <option value="loss-asc" ${view.runSort === "loss-asc" ? "selected" : ""}>Frozen loss ↑</option>
        <option value="loss-desc" ${view.runSort === "loss-desc" ? "selected" : ""}>Frozen loss ↓</option>
        <option value="validation-asc" ${view.runSort === "validation-asc" ? "selected" : ""}>Validation loss ↑</option>
        <option value="validation-desc" ${view.runSort === "validation-desc" ? "selected" : ""}>Validation loss ↓</option>
        <option value="run-asc" ${view.runSort === "run-asc" ? "selected" : ""}>Run ID ascending</option>
      </select>
      <select id="trendRunPageSize" title="Rows per page">
        ${[25, 50, 100, 250].map((size) => `<option value="${size}" ${view.runPageSize === size ? "selected" : ""}>${size} / page</option>`).join("")}
      </select>
      <button type="button" data-trends-action="run-clear">Clear filters</button>
      <button type="button" data-trends-action="run-refresh-details" ${state.trendsExtrasLoading ? "disabled" : ""}>Reload details</button>
    </div>
    <div id="trendsRunTable">${runTableMarkup(m)}</div>
  </div>`;
}

// ---------------------------------------------------------------- wiring
let trendsWired = false;
let trendsSearchTimer = null;

function ensureChartTooltip() {
  let el = document.getElementById("chartTooltip");
  if (!el) {
    el = document.createElement("div");
    el.id = "chartTooltip";
    el.className = "chart-tooltip hidden";
    document.body.appendChild(el);
  }
  return el;
}

function showChartTooltip(target, x, y) {
  const text = target?.getAttribute("data-tip");
  if (!text) return;
  const el = ensureChartTooltip();
  el.textContent = text;
  el.classList.remove("hidden");
  const pad = 14;
  const rect = el.getBoundingClientRect();
  const left = Math.min(window.innerWidth - rect.width - 8, Math.max(8, x + pad));
  const top = Math.min(window.innerHeight - rect.height - 8, Math.max(8, y + pad));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function hideChartTooltip() {
  document.getElementById("chartTooltip")?.classList.add("hidden");
}

function wireTrends() {
  if (trendsWired) return;
  trendsWired = true;
  main.addEventListener("click", (event) => {
    const action = event.target.closest("[data-trends-action]");
    if (!action) return;
    const kind = action.dataset.trendsAction;
    if (kind === "show-runs") {
      state.trendsTab = "events";
      state.trendsView.runVersion = action.dataset.version ?? "";
      state.trendsView.runPage = 1;
      renderTrends();
      ensureTrendExtras();
      return;
    }
    if (kind === "show-chart") {
      state.trendsTab = "chart";
      renderTrends();
      return;
    }
    if (kind === "toggle-guide") {
      state.trendsView.connectValidation = !state.trendsView.connectValidation;
      const y = window.scrollY;
      renderTrends();
      window.scrollTo(0, y);
      return;
    }
    if (kind === "x-mode") {
      state.trendsView.xMode = action.dataset.mode === "time" ? "time" : "sequence";
      const y = window.scrollY;
      renderTrends();
      window.scrollTo(0, y);
      return;
    }
    if (kind === "run-sort") {
      state.trendsView.runSort = nextSort(action.dataset.sort);
      state.trendsView.runPage = 1;
      refreshRunTable();
      return;
    }
    if (kind === "run-page") {
      state.trendsView.runPage += action.dataset.page === "next" ? 1 : -1;
      refreshRunTable();
      return;
    }
    if (kind === "run-clear") {
      state.trendsView.runQuery = "";
      state.trendsView.runOutcome = "";
      state.trendsView.runVersion = "";
      state.trendsView.runSort = "newest";
      state.trendsView.runPage = 1;
      state.trendsView.runExpanded = null;
      renderTrends();
      return;
    }
    if (kind === "run-refresh-details") {
      ensureTrendExtras({ force: true });
      return;
    }
    if (kind === "toggle-run") {
      if (event.target.closest("button, a, input, select, textarea") && !event.target.closest(".run-expand-cell")) return;
      const row = event.target.closest("tr[data-run-id]");
      const runId = row?.dataset.runId;
      if (!runId) return;
      state.trendsView.runExpanded = state.trendsView.runExpanded === runId ? null : runId;
      refreshRunTable();
    }
  });

  main.addEventListener("input", (event) => {
    if (event.target.id !== "trendRunSearch") return;
    state.trendsView.runQuery = event.target.value;
    state.trendsView.runPage = 1;
    clearTimeout(trendsSearchTimer);
    trendsSearchTimer = setTimeout(refreshRunTable, 140);
  });

  main.addEventListener("change", (event) => {
    if (event.target.id === "trendRunOutcome") state.trendsView.runOutcome = event.target.value;
    else if (event.target.id === "trendRunVersion") state.trendsView.runVersion = event.target.value;
    else if (event.target.id === "trendRunSort") state.trendsView.runSort = event.target.value;
    else if (event.target.id === "trendRunPageSize") state.trendsView.runPageSize = Number(event.target.value) || 50;
    else return;
    state.trendsView.runPage = 1;
    refreshRunTable();
  });

  main.addEventListener("pointerover", (event) => {
    const target = event.target.closest("[data-tip]");
    if (target) showChartTooltip(target, event.clientX, event.clientY);
  });
  main.addEventListener("pointermove", (event) => {
    const target = event.target.closest("[data-tip]");
    if (target) showChartTooltip(target, event.clientX, event.clientY);
  });
  main.addEventListener("pointerout", (event) => {
    if (event.target.closest("[data-tip]")) hideChartTooltip();
  });
  main.addEventListener("focusin", (event) => {
    const target = event.target.closest("[data-tip]");
    if (!target) return;
    const rect = target.getBoundingClientRect();
    showChartTooltip(target, rect.left + rect.width / 2, rect.top + rect.height / 2);
  });
  main.addEventListener("focusout", (event) => {
    if (event.target.closest("[data-tip]")) hideChartTooltip();
  });
}

// ------------------------------------------------------- learning & training
async function loadControl() {
  const [jobs, eligibility, teacher, versions] = await Promise.all([
    api("/jobs").catch((err) => ({ error: err.message, jobs: [] })),
    api("/training/eligibility").catch((err) => ({ error: err.message })),
    api("/teacher").catch((err) => ({ error: err.message })),
    api("/brain/versions").catch((err) => ({ error: err.message, available: false, versions: [] })),
  ]);
  state.control = { jobs: jobs.jobs ?? [], jobsError: jobs.error ?? null, eligibility, teacher, versions: versions.versions ?? [], versionsUnavailable: versions.available === false };
  state.versions = versions.versions ?? state.versions;
  renderControl();
}

function teacherPanel(t) {
  if (t?.error) return `<div class="panel notice"><div class="title warn">Teacher readiness unavailable</div><div class="small muted">${esc(t.error)}</div></div>`;
  const cls = t.ready ? "REVIEWED" : "REJECTED";
  return `<div class="panel">
    <div class="k">Teacher readiness (Ollama)</div>
    <div class="toolbar">${badge(cls, t.ready ? "ready" : "not ready")}
      <span class="small muted">model <code>${esc(t.model ?? "—")}</code> · mode ${esc(t.mode ?? "—")}</span></div>
    ${t.reason ? `<div class="small ${t.ready ? "muted" : "warn"}">${esc(t.reason)}</div>` : ""}
    <div class="small muted">digest ${esc(t.digest ?? "—")}${t.matchesExpectedDigest === null || t.matchesExpectedDigest === undefined ? "" : ` · pinned match ${t.matchesExpectedDigest}`}</div>
    ${t.tags?.length ? `<div class="small muted">installed: ${t.tags.map(esc).join(", ")}</div>` : ""}
  </div>`;
}

function activeJob(kind) {
  return (state.control?.jobs ?? []).find((j) => j.kind === kind && !j.terminal) ?? null;
}

/**
 * Compact, human-readable job progress. The stored value is a plain object of
 * varying shape per job kind; dumping `JSON.stringify` into the table cell made
 * the columns overflow the page. Render the meaningful counters instead, and
 * never a raw JSON blob.
 */
function progressText(p) {
  if (!p || typeof p !== "object") return esc(p ?? "");
  const rows = [
    ["cycle", v => `${v}`],
    ["target", v => (p.cycle === undefined ? `target ${v}` : `/${v}`)],
    ["mode", v => String(v)],
    ["rawDocs", v => `docs ${v}`],
    ["ingested", v => `ingested ${v}`],
    ["deduped", v => `deduped ${v}`],
    ["reviewed", v => `reviewed ${v}`],
    ["retired", v => `retired ${v}`],
    ["failed", v => `failed ${v}`],
    ["skippedCooldown", v => `cooling ${v}`],
    ["passes", v => `passes ${v}`],
    ["pending", v => `pending ${v}`],
    ["eligibleRemaining", v => `eligible ${v}`],
    ["trainable", v => `trainable ${v}`],
    ["corpusCeiling", v => `source ceiling ${v}`],
    ["runs", v => `runs ${v}`],
    ["improvement", v => `improvement ${v}`],
    ["promoted", v => (v ? "promoted" : null)],
    ["processedRawDocs", v => `raw ${v}/${p.rawDocs}`],
    ["failures", v => (v ? `failures ${v}` : null)],
    // Authoritative acquisition state + the honest transient signal. "source
    // exhausted" is shown ONLY when the classifier actually says EXHAUSTED; a
    // pass that found claimable work but no usable documents says so instead.
    ["acquisition", v => (v?.state ? `acq ${v.state}` : null)],
    ["noUsefulDocuments", v => (v ? "no usable documents this pass" : null)],
    ["sourceExhausted", v => (v ? "source exhausted" : null)],
  ];
  const out = [];
  for (const [key, fmt] of rows) {
    const v = p[key];
    if (v === undefined || v === null) continue;
    const s = fmt(v);
    if (s === null || s === undefined || s === "") continue;
    out.push(s);
  }
  return out.length ? esc(out.join(" · ")) : esc(JSON.stringify(p));
}

function renderControl() {
  const c = state.control;
  if (!c) return;
  const elig = c.eligibility ?? {};
  const learning = activeJob("learning");
  const training = activeJob("training");
  const review = activeJob("review");
  const fresh = activeJob("fresh-brain");
  const committed = (c.versions ?? []).filter((v) => v.committed);
  if (state.control.versionsUnavailable) { /* store unavailable — reported below */ }

  main.innerHTML = `
    <h2 class="section-title">Learning &amp; Training <span class="sm">${versionScope()}</span></h2>
    ${isReadOnly() ? `<div class="panel notice"><div class="title">Inspection-only workspace</div><div class="small muted">Managed lifecycle work runs only against the live development store. Start/stop controls are disabled here.</div></div>` : ""}
    ${c.jobsError ? `<div class="panel notice"><div class="title warn">Job supervisor unavailable</div><div class="small muted">${esc(c.jobsError)}</div></div>` : ""}
    ${teacherPanel(c.teacher)}

    <div class="cols">
      <div class="panel">
        <div class="k">Learning ${learning ? jobBadge(learning) : badge("INGESTED", "idle")}</div>
        <div class="small muted">Harvest the explicitly-configured sources, curate with the teacher, ingest and review. No autonomous source discovery.</div>
        <div class="toolbar" style="margin-top:8px">
          <select id="learnMode" ${roAttr()}>
            <option value="bounded">bounded (single pass)</option>
            <option value="continuous">continuous (poll)</option>
          </select>
          <label class="small muted">target articles <span class="muted" title="bounded mode only — continuous runs until an operator stop (empty sources are waited through, not treated as completion)">(bounded)</span></label>
          <input type="number" id="learnTarget" value="100" min="1" style="width:90px" ${roAttr()} />
          <label class="small muted">max raw docs (0=all)</label>
          <input type="number" id="learnRaw" value="0" min="0" style="width:90px" ${roAttr()} />
        </div>
        <div class="toolbar">
          <button id="learnStart" class="primary" ${roAttr()}>Start learning</button>
          <button id="learnPause" ${roAttr()} ${learning && (learning.status === "running" || learning.status === "waiting" || learning.status === "waiting-for-eligible") ? "" : "disabled"}>Pause</button>
          <button id="learnResume" ${roAttr()} ${learning && (learning.status === "paused" || learning.status === "pause-requested") ? "" : "disabled"}>Resume</button>
          <button id="learnStop" class="danger" ${roAttr()} ${learning ? "" : "disabled"}>Stop</button>
        </div>
      </div>

      <div class="panel">
        <div class="k">Training ${training ? jobBadge(training) : badge("INGESTED", "idle")}</div>
        <div class="small muted">Eligible reviewed+unconsumed now: <strong>${fmt(elig.trainable)}</strong> (min ${fmt(elig.minEligible)}).${elig.eligible ? "" : " One-shot refuses below the gate rather than training on nothing."}</div>
        <div class="toolbar" style="margin-top:8px">
          <select id="trainMode" ${roAttr()}>
            <option value="one-shot">one-shot</option>
            <option value="continuous">continuous (wait for material)</option>
          </select>
          <label class="small muted">parent</label>
          <select id="trainParent" ${roAttr()}>
            <option value="">active baseline</option>
            ${committed.map((v) => `<option value="${esc(v.version)}">${esc(v.version)}${v.parentVersion ? ` ← ${esc(v.parentVersion)}` : ""}</option>`).join("")}
          </select>
          <label class="small muted">min eligible</label>
          <input type="number" id="trainMin" value="1" min="1" style="width:80px" ${roAttr()} />
        </div>
        <div class="toolbar">
          <button id="trainStart" class="primary" ${roAttr()}>Start training</button>
          <button id="trainPause" ${roAttr()} ${training && (training.status === "running" || training.status === "waiting" || training.status === "waiting-for-eligible") ? "" : "disabled"}>Pause</button>
          <button id="trainResume" ${roAttr()} ${training && (training.status === "paused" || training.status === "pause-requested") ? "" : "disabled"}>Resume</button>
          <button id="trainStop" class="danger" ${roAttr()} ${training ? "" : "disabled"}>Stop</button>
        </div>
        <div class="small muted">The selected parent is validated fail-closed; an unknown/inconsistent version is refused, never swapped for the active pointer.</div>
      </div>
    </div>

    <div class="panel">
      <div class="k">Review backlog ${review ? jobBadge(review) : badge("INGESTED", "idle")}</div>
      <div class="small muted">Drain the pending review queue under the SAME cooldown/attempt policy as the learner — an override, never a bypass. The drain keeps visiting the whole queue (waiting through cooldowns if necessary) until no pending article is left untouched. Articles that exhaust their inconclusive teacher attempts are retired with an auditable transition; transient critic failures use a separate allowance.</div>
      <div class="toolbar" style="margin-top:8px">
        <label class="small muted">limit (0 = all)</label>
        <input type="number" id="reviewLimit" value="0" min="0" style="width:90px" ${roAttr()} />
        <button id="reviewStart" class="primary" ${roAttr()} ${review ? "disabled" : ""}>Drain review queue</button>
        <button id="reviewStop" class="danger" ${roAttr()} ${review ? "" : "disabled"}>Stop</button>
      </div>
      <div class="small muted">Also available server-free: <code>npm run review</code> (<code>--force=&lt;id&gt;</code> to reopen a retired article).</div>
    </div>

    <div class="panel">
      <div class="k">Fresh brain ${fresh ? jobBadge(fresh) : ""}</div>
      <div class="small muted">Create a genuinely randomly-initialised brain (no pretrained student weights), registered as an unpromoted candidate. It never activates itself.</div>
      <div class="toolbar" style="margin-top:8px">
        <label class="small muted">seed</label>
        <input type="number" id="freshSeed" value="0" style="width:100px" ${roAttr()} />
        <label class="small muted">config</label>
        <input type="text" id="freshConfig" placeholder="(configured default)" ${roAttr()} />
        <button id="freshStart" class="danger" ${roAttr()}>Create fresh brain</button>
      </div>
    </div>

    <div class="panel">
      <div class="k">Job history (durable, append-only)</div>
      <table><tr><th>Job</th><th>Kind</th><th>Mode</th><th>Status</th><th>Phase</th><th class="wrap">Progress</th><th>Created</th><th></th></tr>
        ${c.jobs.map((j) => `
          <tr>
            <td class="small wrap"><a href="#" data-job="${esc(j.jobId)}">${esc(j.jobId)}</a></td>
            <td>${esc(j.kind)}</td>
            <td class="small">${esc(j.mode ?? "—")}</td>
            <td>${jobBadge(j)}</td>
            <td class="small wrap">${esc(j.phase ?? "—")}</td>
            <td class="small wrap">${progressText(j.progress)}</td>
            <td class="small">${when(j.createdAt)}</td>
            <td>${j.terminal ? "" : [
              (j.status === "running" || j.status === "waiting" || j.status === "waiting-for-eligible") ? `<button data-pause="${esc(j.jobId)}" ${roAttr()}>Pause</button>` : "",
              (j.status === "paused" || j.status === "pause-requested") ? `<button data-resume="${esc(j.jobId)}" ${roAttr()}>Resume</button>` : "",
              `<button data-stop="${esc(j.jobId)}" class="danger" ${roAttr()}>Stop</button>`,
            ].filter(Boolean).join(" ")}</td>
          </tr>`).join("") || `<tr><td colspan="8" class="muted">No jobs yet.</td></tr>`}
      </table>
      ${c.jobs.some((j) => j.note || j.error || j.result) ? `<div class="small muted wrap" style="margin-top:8px">
        ${c.jobs.slice(0, 6).map((j) => `<div><strong>${esc(j.jobId)}</strong> ${esc(j.error ?? j.note ?? "")} ${j.result?.decision ? `· decision ${esc(j.result.decision)}` : ""}${j.result?.version ? `· ${esc(j.result.version)}` : ""}</div>`).join("")}
      </div>` : ""}
    </div>
    <div id="jobDetail"></div>
  `;
  wireControl();
}

const CONTROL_FORM_FIELDS = ["learnMode", "learnTarget", "learnRaw", "trainMode", "trainParent", "trainMin", "freshSeed", "freshConfig", "reviewLimit"];

/**
 * Restore the operator's last Learning & Training selections onto the freshly
 * rendered controls, then persist any further edits. Called once per render so
 * SSE/poll refreshes cannot reset a dropdown to its first option.
 */
function applyControlForm() {
  const f = state.controlForm ?? {};
  for (const id of CONTROL_FORM_FIELDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (f[id] !== undefined && f[id] !== null) el.value = f[id];
    const persist = () => { state.controlForm = { ...state.controlForm, [id]: el.value }; };
    el.addEventListener("change", persist);
    el.addEventListener("input", persist);
  }
}

function wireControl() {
  applyControlForm();
  // The target only bounds a single pass; a continuous run learns until an
  // operator stops it. Empty sources and review cooldowns are WAITS, not a
  // terminal "completed" outcome, so the job survives months unattended.
  const learnModeEl = document.getElementById("learnMode");
  const learnTargetEl = document.getElementById("learnTarget");
  const syncLearnTarget = () => {
    if (learnTargetEl) learnTargetEl.disabled = isReadOnly() || learnModeEl?.value === "continuous";
  };
  learnModeEl?.addEventListener("change", syncLearnTarget);
  syncLearnTarget();
  document.getElementById("reviewStart")?.addEventListener("click", async (e) => {
    if (isReadOnly()) return;
    e.target.disabled = true;
    try {
      await api("/review/start", { method: "POST", body: {
        mode: "drain",
        limit: Number(document.getElementById("reviewLimit").value) || 0,
      } });
      await loadControl();
    } catch (err) { alert(err.message); e.target.disabled = false; }
  });
  document.getElementById("reviewStop")?.addEventListener("click", async (e) => {
    if (isReadOnly()) return;
    e.target.disabled = true;
    try { await api("/review/stop", { method: "POST", body: {} }); await loadControl(); }
    catch (err) { alert(err.message); e.target.disabled = false; }
  });
  document.getElementById("learnStart")?.addEventListener("click", async (e) => {
    if (isReadOnly()) return;
    e.target.disabled = true;
    try {
      await api("/learning/start", { method: "POST", body: {
        mode: document.getElementById("learnMode").value,
        targetArticles: Number(document.getElementById("learnTarget").value),
        maxRawDocs: Number(document.getElementById("learnRaw").value),
      } });
      await loadControl();
    } catch (err) { alert(err.message); e.target.disabled = false; }
  });
  document.getElementById("learnStop")?.addEventListener("click", async (e) => {
    if (isReadOnly()) return;
    e.target.disabled = true;
    try { await api("/learning/stop", { method: "POST", body: {} }); await loadControl(); }
    catch (err) { alert(err.message); e.target.disabled = false; }
  });
  document.getElementById("learnPause")?.addEventListener("click", async (e) => {
    const j = activeJob("learning");
    if (isReadOnly() || !j) return;
    e.target.disabled = true;
    try { await api(`/jobs/${encodeURIComponent(j.jobId)}/pause`, { method: "POST", body: {} }); await loadControl(); }
    catch (err) { alert(err.message); e.target.disabled = false; }
  });
  document.getElementById("learnResume")?.addEventListener("click", async (e) => {
    const j = activeJob("learning");
    if (isReadOnly() || !j) return;
    e.target.disabled = true;
    try { await api(`/jobs/${encodeURIComponent(j.jobId)}/resume`, { method: "POST", body: {} }); await loadControl(); }
    catch (err) { alert(err.message); e.target.disabled = false; }
  });
  document.getElementById("trainStart")?.addEventListener("click", async (e) => {
    if (isReadOnly()) return;
    e.target.disabled = true;
    try {
      await api("/training/start", { method: "POST", body: {
        mode: document.getElementById("trainMode").value,
        parentVersion: document.getElementById("trainParent").value || null,
        minEligible: Number(document.getElementById("trainMin").value),
      } });
      await loadControl();
    } catch (err) { alert(err.message); e.target.disabled = false; }
  });
  document.getElementById("trainStop")?.addEventListener("click", async (e) => {
    if (isReadOnly()) return;
    e.target.disabled = true;
    try { await api("/training/stop", { method: "POST", body: {} }); await loadControl(); }
    catch (err) { alert(err.message); e.target.disabled = false; }
  });
  document.getElementById("trainPause")?.addEventListener("click", async (e) => {
    const j = activeJob("training");
    if (isReadOnly() || !j) return;
    e.target.disabled = true;
    try { await api(`/jobs/${encodeURIComponent(j.jobId)}/pause`, { method: "POST", body: {} }); await loadControl(); }
    catch (err) { alert(err.message); e.target.disabled = false; }
  });
  document.getElementById("trainResume")?.addEventListener("click", async (e) => {
    const j = activeJob("training");
    if (isReadOnly() || !j) return;
    e.target.disabled = true;
    try { await api(`/jobs/${encodeURIComponent(j.jobId)}/resume`, { method: "POST", body: {} }); await loadControl(); }
    catch (err) { alert(err.message); e.target.disabled = false; }
  });
  document.getElementById("freshStart")?.addEventListener("click", async (e) => {
    if (isReadOnly()) return;
    if (!confirm("Create a fresh, randomly-initialised brain version? It will NOT be activated.")) return;
    e.target.disabled = true;
    try {
      const body = { confirm: true, seed: Number(document.getElementById("freshSeed").value) };
      const cfg = document.getElementById("freshConfig").value.trim();
      if (cfg) body.config = cfg;
      await api("/brain/fresh", { method: "POST", body });
      await loadControl();
    } catch (err) { alert(err.message); e.target.disabled = false; }
  });
  for (const el of document.querySelectorAll("[data-stop]")) {
    el.addEventListener("click", async () => {
      if (isReadOnly()) return;
      try { await api(`/jobs/${encodeURIComponent(el.dataset.stop)}/stop`, { method: "POST", body: {} }); await loadControl(); }
      catch (err) { alert(err.message); }
    });
  }
  for (const el of document.querySelectorAll("[data-pause]")) {
    el.addEventListener("click", async () => {
      if (isReadOnly()) return;
      try { await api(`/jobs/${encodeURIComponent(el.dataset.pause)}/pause`, { method: "POST", body: {} }); await loadControl(); }
      catch (err) { alert(err.message); }
    });
  }
  for (const el of document.querySelectorAll("[data-resume]")) {
    el.addEventListener("click", async () => {
      if (isReadOnly()) return;
      try { await api(`/jobs/${encodeURIComponent(el.dataset.resume)}/resume`, { method: "POST", body: {} }); await loadControl(); }
      catch (err) { alert(err.message); }
    });
  }
  for (const el of document.querySelectorAll("[data-job]")) {
    el.addEventListener("click", (e) => { e.preventDefault(); openJob(el.dataset.job); });
  }
  // Restore the selected job from URL hash after the job list is rendered.
  // This handles full page reloads, hash changes, and initial page load.
  restoreJobFromHashIfValid();
}

async function openJob(jobId, { silent = false } = {}) {
  const box = document.getElementById("jobDetail");
  if (!box) return;
  state.openJobId = jobId;
  writeJobHash(jobId);
  markSelectedJob(jobId);
  if (!silent) box.innerHTML = `<div class="panel loading">Loading job…</div>`;
  try {
    const d = await api(`/jobs/${encodeURIComponent(jobId)}`);
    // The view may have moved on (tab switch, another job opened) while this
    // request was in flight; never paint a stale job over the current one.
    if (state.openJobId !== jobId) return;
    const current = document.getElementById("jobDetail");
    if (!current) return;
    current.innerHTML = `
      <div class="panel">
        <div class="toolbar"><strong>${esc(jobId)}</strong> ${badge(d.job.status, d.job.status)}
          <span class="small muted">${esc(d.job.kind)} · ${esc(d.job.mode)}</span>
          <span style="flex:1"></span><button data-close-job>close</button></div>
        ${d.job.error ? `<div class="small bad">${esc(d.job.error)}</div>` : ""}
        ${d.job.note ? `<div class="small muted">${esc(d.job.note)}</div>` : ""}
        ${renderWaitDiagnostics(d.job.meta)}
        ${d.job.result ? `<pre class="small">${esc(JSON.stringify(d.job.result, null, 2))}</pre>` : ""}
        <div class="k" style="margin-top:8px">Log</div>
        <div class="log-box small">${(d.log ?? []).map((l) => `<div><span class="muted">${when(l.at)}</span> [${esc(l.stream)}] ${esc(l.text)}</div>`).join("") || `<div class="muted">no log lines</div>`}</div>
      </div>`;
    current.querySelector("[data-close-job]")?.addEventListener("click", () => closeJob());
  } catch (err) {
    if (state.openJobId !== jobId) return;
    const current = document.getElementById("jobDetail");
    if (current) current.innerHTML = `<div class="panel notice"><span class="bad">${esc(err.message)}</span></div>`;
  }
}

/** Closing is explicit: only the operator's `close` clears the selection. */
function closeJob() {
  state.openJobId = null;
  writeJobHash(null);
  markSelectedJob(null);
  const box = document.getElementById("jobDetail");
  if (box) box.innerHTML = "";
}

/** Highlight the selected row so the open panel is attributable at a glance. */
function markSelectedJob(jobId) {
  for (const el of document.querySelectorAll("[data-job]")) {
    const on = jobId !== null && el.dataset.job === jobId;
    el.classList.toggle("selected", on);
    if (on) el.setAttribute("aria-current", "true");
    else el.removeAttribute("aria-current");
  }
}

// --------------------------------------------------------------------- SSE
function connectSSE() {
  if (!window.EventSource) return;
  const es = new EventSource(`${API}/events?since=${state.seq}`);
  let debounce = null;
  const schedule = () => { clearTimeout(debounce); debounce = setTimeout(() => refresh(), 350); };
  es.addEventListener("hello", (e) => {
    state.live = true; updatePills();
    try {
      const d = JSON.parse(e.data);
      const restarted = Number.isFinite(d.currentSeq) && d.currentSeq < state.seq;
      if (d.gap || restarted) refresh();
      if (Number.isFinite(d.currentSeq)) state.seq = d.currentSeq;
    } catch {}
  });
  es.addEventListener("change", (e) => {
    try { const d = JSON.parse(e.data); state.seq = Math.max(state.seq, d.seq ?? 0); } catch {}
    schedule();
  });
  es.addEventListener("resync", () => refresh());
  es.onerror = () => { state.live = false; updatePills(); };
}

// -------------------------------------------------------------------- boot
/**
 * Optional deep link for screenshots and operator links:
 *   /admin/?tab=trends&sub=chart
 * The URL only affects the initial view; normal navigation is unchanged.
 */
function applyInitialView() {
  const params = new URLSearchParams(window.location.search);
  const tab = params.get("tab");
  const sub = params.get("sub");
  if (tab && [...document.querySelectorAll("#tabs button")].some((b) => b.dataset.tab === tab)) {
    state.tab = tab;
  }
  if (state.tab === "trends" && ["trend", "chart", "lineage", "events"].includes(sub)) {
    state.trendsTab = sub;
  }
  for (const b of document.querySelectorAll("#tabs button")) {
    b.classList.toggle("active", b.dataset.tab === state.tab);
  }
}

// Restore job selection from URL hash on initial page load
applyInitialView();
restoreJobFromHashIfValid();
watchJobHash();

for (const b of document.querySelectorAll("#tabs button")) b.addEventListener("click", () => setTab(b.dataset.tab));
document.getElementById("workspaceSelect")?.addEventListener("change", (e) => selectWorkspace(e.target.value));
document.getElementById("modelVersion")?.addEventListener("change", (e) => setPinnedVersion(e.target.value));
loadWorkspaces().catch((err) => {
  main.innerHTML = `<div class="panel notice"><div class="title bad">Cannot load workspaces</div><div class="muted">${esc(err.message)}</div></div>`;
});
connectSSE();
setInterval(() => { if (!state.live) updatePills(); }, 5000);
