const API = "/api/admin";

const state = {
  tab: "dashboard",
  workspaces: [],
  workspace: null, // selected workspace id
  workspaceInfo: null, // descriptor for the selected workspace
  overview: null,
  articles: { items: [], nextCursor: null, filters: {} },
  selectedArticle: null,
  chat: { messages: [], identity: null, sending: false },
  mission: null,
  strategy: null,
  cycles: null,
  history: null,
  trends: null,
  control: null, // { jobs, eligibility, teacher, versions }
  jobDetail: null,
  // Shared model-version selector: pinned per workspace, independent of the
  // active pointer and of a running job's training parent.
  versions: [],
  selectedVersion: null,
  live: false,
  seq: 0,
};

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v) => (v === null || v === undefined ? "—" : typeof v === "number" ? (Number.isInteger(v) ? v.toLocaleString() : v.toFixed(3)) : String(v));
const when = (iso) => (iso ? new Date(iso).toLocaleString() : "—");
const badge = (cls, text) => `<span class="badge ${esc(cls)}">${esc(text)}</span>`;

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
  sel.innerHTML = [
    `<option value="">active/default</option>`,
    ...committed.map((v) => `<option value="${esc(v.version)}">${esc(v.version)}${v.parentVersion ? ` ← ${esc(v.parentVersion)}` : ""}</option>`),
  ].join("");
  sel.value = state.selectedVersion ?? "";
}

function setPinnedVersion(version) {
  state.selectedVersion = version || null;
  writePinnedVersion(state.workspace, state.selectedVersion);
  render();
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
      ${statCard("Trainable now", a.trainable)}
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
        <div class="small muted" style="margin-top:8px">Only REVIEWED &amp; unconsumed articles are trainable.</div>
      </div>
      <div class="panel">
        <div class="k">By domain / importance</div>
        <table><tr><th>Domain</th><th>Count</th></tr>
          ${(a.byDomain ?? []).slice(0, 12).map((d) => `<tr><td>${esc(d.domain)}</td><td>${fmt(d.count)}</td></tr>`).join("") || `<tr><td colspan="2" class="muted">no data</td></tr>`}
        </table>
        <div class="small" style="margin-top:8px">
          Normal ${fmt(a.byImportance.Normal)} · Important ${fmt(a.byImportance.Important)} · Critical ${fmt(a.byImportance.Critical)}
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
      <div class="k">Python brain store</div>
      ${renderPythonStore(o.pythonStore)}
    </div>
    ${legacy.length ? `<div class="panel notice"><div class="title warn">Legacy pair-buffer files detected</div>
      <div class="small muted">Read-only, never a source of truth:</div>
      <ul class="small">${legacy.map((l) => `<li>${esc(l.file)} — ${l.count ?? "?"} line(s)</li>`).join("")}</ul></div>` : ""}
  `;
}

function storeStatus() {
  const py = state.overview?.pythonStore;
  if (!py) return "";
  if (!py.available) return badge("warn", "unavailable");
  return py.activeVersion ? badge("REVIEWED", `active ${py.activeVersion}`) : badge("PENDING_REVIEW", "no active version");
}

function renderPythonStore(py) {
  if (!py) return `<div class="muted">—</div>`;
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
    <table style="margin-top:8px"><tr><th>Version</th><th>State</th><th>Loss</th><th>Steps</th><th>Tokens</th><th>Params</th><th>Committed</th></tr>
    ${rows || `<tr><td colspan="7" class="muted">no versions yet</td></tr>`}</table>
    <div class="small muted" style="margin-top:6px">Read-only reader. “—” means the metric is unavailable, not zero.</div>`;
}

// ---------------------------------------------------------------- articles
async function loadArticles() {
  const f = state.articles.filters;
  const q = new URLSearchParams();
  q.set("limit", "50");
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
      <input type="text" data-filter="domain" placeholder="domain…" value="${esc(f.domain ?? "")}" />
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
  return `<table><tr><th>Article</th><th>Domain</th><th>Importance</th><th>Status</th><th>Trainable</th><th>Consumed</th><th>Actions</th></tr>
    ${items.map((x) => `
      <tr data-id="${esc(x.articleId)}">
        <td style="max-width:420px"><a href="#" data-open="${esc(x.articleId)}">${esc((x.text ?? "").slice(0, 110))}${(x.text ?? "").length > 110 ? "…" : ""}</a>
          <div class="small muted">${esc(x.articleId)}</div></td>
        <td>${esc(x.domain ?? "—")}</td>
        <td>${badge(x.importance.toUpperCase(), x.importance)}${x.suggestedImportance ? ` ${badge(`suggested ${String(x.suggestedImportance).toUpperCase()}`, `sugg: ${x.suggestedImportance}`)}` : ""}</td>
        <td>${badge(x.status, x.status)}</td>
        <td>${x.trainable ? "✔" : "—"}</td>
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
  renderChat();
}

function renderChat() {
  const c = state.chat;
  const id = c.identity ?? {};
  main.innerHTML = `
    <h2 class="section-title">Live Chat <span class="sm">${versionScope()}</span></h2>
    <div class="panel">
      <div class="toolbar">
        <span class="k">Student</span>
        ${badge(id.available ? "REVIEWED" : "REJECTED", id.available ? "available" : "unavailable")}
        <span class="muted small">mode: ${esc(id.mode ?? "—")} · serving version: ${esc(id.version ?? "none")}</span>
      </div>
      <div class="small muted" style="margin:-2px 0 8px">Conversations are pinned to the serving checkpoint named above; the version selector changes only which version's history/metrics you inspect, not what answers here.</div>
      ${!id.available ? `<div class="small warn">No committed student version is active. The chat has no teacher fallback — this is reported honestly rather than faked.</div>` : ""}
      <div class="chat">
        <div class="log" id="chatLog">
          ${c.messages.length ? c.messages.map((m) => `
            <div class="msg ${esc(m.role)}">${esc(m.text)}<span class="meta">${esc(m.meta ?? "")}</span></div>`).join("") : `<div class="msg system">Say something to the current brain.</div>`}
        </div>
        <div class="compose">
          <input id="chatInput" placeholder="Message the brain…" ${id.available ? "" : "disabled"} />
          <button id="chatSend" class="primary" ${id.available ? "" : "disabled"}>Send</button>
        </div>
      </div>
    </div>`;
  const send = async () => {
    const input = document.getElementById("chatInput");
    const text = input.value.trim();
    if (!text) return;
    c.messages.push({ role: "user", text, meta: new Date().toLocaleTimeString() });
    input.value = "";
    renderChat();
    document.getElementById("chatLog").scrollTop = 1e9;
    try {
      const r = await api("/chat", { method: "POST", body: { message: text } });
      c.messages.push({ role: "brain", text: r.reply, meta: `v${r.version ?? "?"} · ${new Date().toLocaleTimeString()}` });
    } catch (err) {
      c.messages.push({ role: "system", text: `error: ${err.message}`, meta: "" });
    }
    renderChat();
    document.getElementById("chatLog").scrollTop = 1e9;
  };
  document.getElementById("chatSend")?.addEventListener("click", send);
  document.getElementById("chatInput")?.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
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
  main.innerHTML = `
    <h2 class="section-title">Training History <span class="sm">${versionScope()}</span></h2>
    <div class="small muted" style="margin:-6px 0 12px">
      workspace <strong>${esc(h.workspace?.id ?? "—")}</strong>${h.workspace?.readOnly ? " (inspection-only)" : ""} ·
      python store <code>${esc(h.pythonStore?.root ?? "—")}</code>
    </div>
    ${h.discrepancies.length ? `<div class="panel notice">
      <div class="title warn">${h.discrepancies.length} discrepancy(ies) between Node registry and Python store — reported, not silently reconciled</div>
      <ul class="small">${h.discrepancies.map((d) => `<li>${esc(d.kind)}${d.version ? ` — ${esc(d.version)}` : ""}${d.detail ? ` (${esc(d.detail)})` : ""}</li>`).join("")}</ul>
    </div>` : `<div class="panel"><span class="ok">Registry and Python store agree.</span> <span class="small muted">Node = orchestration/audit; Python = committed artifacts.</span></div>`}

    <div class="cols">
      <div class="panel">
        <div class="k">Training runs (Node registry)</div>
        <table><tr><th>Run</th><th>Status</th><th>Records</th><th>Versions (parent→candidate)</th><th>Promotion</th><th>Score (base→trained)</th><th>Loss (base→trained)</th><th>Δ</th><th>Started</th></tr>
          ${r.runs.slice().reverse().map((run) => `
            ${(() => { const prom = run.promotionStatus ?? run.status; return `
            <tr><td class="small">${esc(run.runId)}${run.candidate?.modelId ? `<div class="muted">${esc(run.candidate.modelId)}</div>` : ""}</td>
            <td>${badge(prom === "promoted" ? "REVIEWED" : prom === "rejected" ? "REJECTED" : "PENDING_REVIEW", run.status)}</td>
            <td>${fmt(run.recordCount)}</td>
            <td class="small">${run.pythonVersion ? `${run.parentVersion ? `${esc(run.parentVersion)} → ` : ""}${esc(run.pythonVersion)}` : "—"}
              ${run.datasetHash ? `<div class="muted" title="${esc(run.datasetHash)}">data ${esc(shortHash(run.datasetHash))}</div>` : ""}</td>
            <td class="small">${esc(run.promotionStatus ?? "—")}${run.activatedVersion ? `<div class="muted">active ${esc(run.activatedVersion)}</div>` : ""}</td>
            <td>${run.baselineScore == null && run.trainedScore == null ? "—" : `${fmt(run.baselineScore)} → ${fmt(run.trainedScore)}`}</td>
            <td>${run.baselineLoss == null && run.trainedLoss == null ? "—" : `${fmt(run.baselineLoss)} → ${fmt(run.trainedLoss)}`}
              ${run.candidate?.avgTrainLoss != null ? `<div class="muted" title="mean training-tail loss (candidate meta)">train avg ${fmt(run.candidate.avgTrainLoss)}</div>` : ""}
              ${run.candidate?.note ? `<div class="muted" title="${esc(run.candidate.note)}">promotion note ⓘ</div>` : ""}</td>
            <td>${run.lossDelta == null ? "—" : `${run.lossDelta > 0 ? "+" : ""}${run.lossDelta.toFixed(3)}`}</td>
            <td class="small">${when(run.startedAt)}</td></tr>`; })()}`).join("") || `<tr><td colspan="9" class="muted">No runs yet. Run <code>npm run train</code>.</td></tr>`}
        </table>
      </div>
      <div class="panel">
        <div class="k">Models (Node registry)</div>
        <table><tr><th>Model</th><th>Kind</th><th>Status</th><th>Score</th></tr>
          ${r.models.slice().reverse().map((m) => `
            <tr><td class="small">${esc(m.modelId)}</td><td>${esc(m.kind)}</td>
            <td>${badge(m.status === "promoted" ? "REVIEWED" : m.status === "rejected" ? "REJECTED" : "PENDING_REVIEW", m.status)}</td>
            <td>${fmt(m.evaluationScore)}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">No models.</td></tr>`}
        </table>
        <div class="small muted" style="margin-top:6px">active: ${esc(r.activeModel?.modelId ?? "none")}</div>
      </div>
    </div>

    <div class="panel">
      <div class="k">Python brain store (authoritative for committed artifacts) <span class="sm">${storeStatus()}</span></div>
      ${renderPythonStore(h.pythonStore)}
    </div>

    ${h.evaluationSet ? `<div class="panel">
      <div class="k">Frozen evaluation set (identity)</div>
      <div class="small muted">${esc(h.evaluationSet.dir)}</div>
      <table><tr><th>File</th><th>Bytes</th><th>sha256</th></tr>
        ${h.evaluationSet.files.map((f) => `<tr><td>${esc(f.file)}</td><td>${f.bytes}</td><td class="small" title="${esc(f.sha256)}">${esc(shortHash(f.sha256))}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">No files.</td></tr>`}
      </table>
      <div class="small muted">The frozen hold-out the promotion gate scores against — never used for training.</div>
    </div>` : ""}
  `;
}

// ------------------------------------------------------- trends & metrics
async function loadTrends() {
  state.trends = await api(`/metrics${state.selectedVersion ? `?version=${encodeURIComponent(state.selectedVersion)}` : ""}`);
  renderTrends();
}

const TREND_LABEL = {
  insufficient_evidence: "Insufficient evidence",
  improving: "Improving",
  plateauing: "Plateauing",
  potentially_overfitting: "Potentially overfitting",
  worsening: "Worsening",
};
const TREND_BADGE = {
  insufficient_evidence: "PENDING_REVIEW",
  improving: "REVIEWED",
  plateauing: "PENDING_REVIEW",
  potentially_overfitting: "overfit",
  worsening: "REJECTED",
};

function trendCard(k, vHtml) {
  return `<div class="card"><div class="k">${esc(k)}</div><div class="v">${vHtml}</div></div>`;
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
  const body =
    !m.available
      ? `<div class="panel notice"><div class="title bad">Store unavailable</div><div class="muted">${esc(m.reason ?? "python store unavailable")}</div></div>`
      : m.reason
        ? `<div class="panel notice"><div class="muted">${esc(m.reason)}</div></div>`
        : trendsBody(m);
  main.innerHTML = `<h2 class="section-title">Trends &amp; Metrics <span class="sm">${versionScope()}</span></h2>${body}`;
}

function trendsBody(m) {
  const t = m.trend ?? {};
  const verdict = t.verdict ?? "insufficient_evidence";
  const label = TREND_LABEL[verdict] ?? verdict;
  const seg = (m.segments ?? []).find((s) => s.version === m.effectiveVersion);
  const ev = t.evidence ?? {};
  const valLost = ev.first == null && ev.last == null ? "—" : `${fmt(ev.first)} → ${fmt(ev.last)}`;
  const best = (m.best ?? []).filter((b) => Number.isFinite(b.loss));
  const thresholds = m.thresholds ?? {};
  return `
    <div class="grid">
      ${trendCard("Trend", badge(TREND_BADGE[verdict] ?? "PENDING_REVIEW", label))}
      ${trendCard("Validation loss", `${valLost}${ev.best == null ? "" : ` <span class="muted small">best ${fmt(ev.best)}</span>`}`)}
      ${trendCard("Steps covered", m.chain?.fromStep == null ? "—" : `${fmt(m.chain.fromStep)} → ${fmt(m.chain.toStep)}`)}
      ${trendCard("Effective version", `${esc(m.effectiveVersion ?? "—")} ${samplingLabel(seg?.sampling)}`)}
      ${trendCard("Best checkpoint", best.length ? best.map((b) => `${esc(b.version ?? b.runId ?? "?")} <span class="muted small">${fmt(b.loss)} <span title="${esc(b.datasetHash ?? "")}">${esc(shortHash(b.datasetHash) ?? "unkeyed")}</span></span>`).join("<br>") : "—")}
    </div>
    <div class="panel">
      <div class="k">Why ${label.toLowerCase()}</div>
      <div class="prose">${esc(t.reason ?? "No classification reason recorded.")}</div>
      <div class="small muted" style="margin-top:6px">
        Evidence: ${fmt(ev.points)} finite validation sample(s) · first step ${fmt(ev.firstStep)} → last step ${fmt(ev.lastStep)} ·
        thresholds minPoints ${fmt(thresholds.minPoints)} · improve ≥ ${fmt(thresholds.improveDrop)} · worsen ≥ ${fmt(thresholds.worsenRise)} · overfit val ≥ ${fmt(thresholds.overfitValRise)}
      </div>
    </div>
    <div class="panel">
      <div class="k">Loss over training steps ${m.datasetHash ? `<span class="small muted">(dataset ${esc(shortHash(m.datasetHash))})</span>` : ""}</div>
      ${lossSvg(m)}
      <div class="small muted" style="margin-top:8px">
        Validation is measured on the held-out tail of the SAME corpus (token-weighted mean cross-entropy over the full vocabulary); training loss is the in-run mean per step. They are only ever compared within one dataset hash. ${seg?.sampling !== "periodic" ? `This version recorded only the opening and closing validations — set <code>TRAIN_EVAL_EVERY</code> ≥ 1 to sample a full curve.` : ""}
      </div>
    </div>
    <div class="cols">
      <div class="panel">
        <div class="k">Lineage segments</div>
        ${segmentsTable(m)}
      </div>
      <div class="panel">
        <div class="k">Frozen eval-set checkpoints (data/evaluation)</div>
        ${markersTable(m)}
      </div>
    </div>
  `;
}

function segmentsTable(m) {
  const segs = m.segments ?? [];
  if (!segs.length) return `<div class="muted small">No trained segments in this lineage.</div>`;
  return `<table><tr><th>Version</th><th>Sampling</th><th>Eval every</th><th>Steps</th><th>Val loss init → final</th><th>Committed</th></tr>
    ${segs.map((s) => `
      <tr>
        <td>${esc(s.version)}${s.version === m.effectiveVersion ? ` ${badge("REVIEWED", "effective")}` : ""}${s.resumedFromStep != null ? ` <span class="small muted" title="resumed from ${s.resumedFromStep}">↳</span>` : ""}</td>
        <td>${samplingLabel(s.sampling)}</td>
        <td>${fmt(s.evalEvery)}</td>
        <td>${fmt(s.stepsCompleted)}</td>
        <td>${s.initialValidationLoss == null && s.finalValidationLoss == null ? "—" : `${fmt(s.initialValidationLoss)} → ${fmt(s.finalValidationLoss)}`}</td>
        <td class="small">${when(s.committedAt)}</td>
      </tr>`).join("")}</table>`;
}

function markersTable(m) {
  const mk = m.markers ?? [];
  if (!mk.length) return `<div class="muted small">No frozen eval-set benchmark records for this lineage yet.</div>`;
  return `<table><tr><th>Version</th><th>Loss</th><th>Status</th><th>Trained</th></tr>
    ${mk.slice().reverse().map((x) => `
      <tr><td>${esc(x.version)}</td><td>${fmt(x.loss)}</td>
      <td>${badge(x.promotionStatus === "promoted" ? "REVIEWED" : x.promotionStatus === "rejected" ? "REJECTED" : "PENDING_REVIEW", x.promotionStatus ?? x.status ?? "?")}</td>
      <td class="small">${when(x.trainedAt)}</td></tr>`).join("")}</table>`;
}

function lossSvg(m) {
  const W = 760, H = 300, P = { l: 64, r: 20, t: 18, b: 40 };
  const valPts = (m.chain?.points ?? []).filter((p) => Number.isFinite(p.loss));
  const trainPts = (m.training ?? []).flatMap((s) => (s.points ?? []).filter((p) => Number.isFinite(p.loss)));
  const markers = (m.markers ?? [])
    .map((mk) => {
      const seg = (m.segments ?? []).find((s) => s.version === mk.version);
      const step = seg && Number.isInteger(seg.stepsCompleted) ? seg.stepsCompleted - 1 : null;
      return { ...mk, step };
    })
    .filter((mk) => mk.step !== null);
  const losses = [...valPts, ...trainPts, ...markers].map((p) => p.loss).filter(Number.isFinite);
  if (losses.length < 2) return `<div class="empty">No finite loss series recorded for this version. Train with <code>config.trainEvalEvery ≥ 1</code> to record a curve.</div>`;
  const steps = [...valPts, ...trainPts, ...markers].map((p) => p.step).filter((s) => Number.isInteger(s));
  if (!steps.length) return `<div class="empty">No step axis recorded.</div>`;
  let min = Math.min(...losses), max = Math.max(...losses);
  const range = max - min;
  if (!(range > 0)) { const pad = Math.max(Math.abs(max) * 0.02, 1e-4); min -= pad; max += pad; }
  const xMin = Math.min(...steps), xMax = Math.max(...steps);
  const xSpan = xMax - xMin || 1;
  const sx = (s) => P.l + ((s - xMin) / xSpan) * (W - P.l - P.r);
  const sy = (v) => P.t + ((max - v) / (max - min || 1)) * (H - P.t - P.b);
  const path = (pts) => pts.map((p, i) => `${i ? "L" : "M"}${sx(p.step).toFixed(1)},${sy(p.loss).toFixed(1)}`).join(" ");
  const diamond = (x, y) => `${x},${(y - 5).toFixed(1)} ${(x + 5).toFixed(1)},${y.toFixed(1)} ${x},${(y + 5).toFixed(1)} ${(x - 5).toFixed(1)},${y.toFixed(1)}`;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => max - f * (max - min));
  const xTicks = xMax === xMin ? [xMin] : [0, 0.25, 0.5, 0.75, 1].map((f) => xMin + f * (xSpan));
  return `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Training vs validation loss over training steps" style="width:100%;height:auto">
      ${yTicks.map((v) => `<line x1="${P.l}" y1="${sy(v).toFixed(1)}" x2="${W - P.r}" y2="${sy(v).toFixed(1)}" stroke="var(--border)" stroke-dasharray="2 4"/><text x="${P.l - 8}" y="${(sy(v) + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--muted)">${v.toFixed(2)}</text>`).join("")}
      ${xTicks.map((s) => `<text x="${sx(s).toFixed(1)}" y="${H - 10}" text-anchor="middle" font-size="10" fill="var(--muted)">${Math.round(s)}</text>`).join("")}
      <text x="${P.l}" y="${H - 26}" font-size="10" fill="var(--muted)">step</text>
      ${trainPts.length ? `<path d="${path(trainPts)}" fill="none" stroke="var(--accent-2)" stroke-width="1.2" stroke-dasharray="4 3"/>` : ""}
      ${trainPts.map((p) => `<circle cx="${sx(p.step).toFixed(1)}" cy="${sy(p.loss).toFixed(1)}" r="1.4" fill="var(--accent-2)"><title>training step ${p.step}: loss ${fmt(p.loss)}</title></circle>`).join("")}
      ${valPts.length ? `<path d="${path(valPts)}" fill="none" stroke="var(--accent)" stroke-width="2"/>` : ""}
      ${valPts.map((p) => `<circle cx="${sx(p.step).toFixed(1)}" cy="${sy(p.loss).toFixed(1)}" r="2" fill="var(--accent)"><title>validation step ${p.step}: loss ${fmt(p.loss)}${p.version ? ` · ${esc(p.version)}` : ""}</title></circle>`).join("")}
      ${markers.map((mk) => `<polygon points="${diamond(sx(mk.step), sy(mk.loss))}" fill="var(--bad)"><title>frozen eval-set checkpoint ${esc(mk.version)}: loss ${fmt(mk.loss)}${mk.promotionStatus ? ` · ${esc(mk.promotionStatus)}` : ""}</title></polygon>`).join("")}
      <rect x="${W - 248}" y="0" width="248" height="38" fill="var(--panel)" opacity="0.92"/>
      <line x1="${W - 238}" y1="12" x2="${W - 220}" y2="12" stroke="var(--accent)" stroke-width="2"/><text x="${W - 212}" y="16" font-size="10" fill="var(--muted)">validation (held-out)</text>
      <line x1="${W - 238}" y1="28" x2="${W - 220}" y2="28" stroke="var(--accent-2)" stroke-width="1.2" stroke-dasharray="4 3"/><text x="${W - 212}" y="32" font-size="10" fill="var(--muted)">training</text>
    </svg>
    ${markers.length ? `<div class="small muted">◆ = frozen eval-set benchmark (data/evaluation), dataset ${esc(shortHash(m.markers[0].datasetHash) ?? "unkeyed")} — plotted at each version's final step, not in-training.</div>` : ""}`;
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

function renderControl() {
  const c = state.control;
  if (!c) return;
  const elig = c.eligibility ?? {};
  const learning = activeJob("learning");
  const training = activeJob("training");
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
        <div class="k">Learning ${learning ? badge("PENDING_REVIEW", learning.status) : badge("INGESTED", "idle")}</div>
        <div class="small muted">Harvest the explicitly-configured sources, curate with the teacher, ingest and review. No autonomous source discovery.</div>
        <div class="toolbar" style="margin-top:8px">
          <select id="learnMode" ${roAttr()}>
            <option value="bounded">bounded (single pass)</option>
            <option value="continuous">continuous (poll)</option>
          </select>
          <label class="small muted">target articles</label>
          <input type="number" id="learnTarget" value="100" min="1" style="width:90px" ${roAttr()} />
          <label class="small muted">max raw docs (0=all)</label>
          <input type="number" id="learnRaw" value="0" min="0" style="width:90px" ${roAttr()} />
        </div>
        <div class="toolbar">
          <button id="learnStart" class="primary" ${roAttr()}>Start learning</button>
          <button id="learnStop" class="danger" ${roAttr()} ${learning ? "" : "disabled"}>Stop</button>
        </div>
      </div>

      <div class="panel">
        <div class="k">Training ${training ? badge("PENDING_REVIEW", training.status) : badge("INGESTED", "idle")}</div>
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
          <button id="trainStop" class="danger" ${roAttr()} ${training ? "" : "disabled"}>Stop</button>
        </div>
        <div class="small muted">The selected parent is validated fail-closed; an unknown/inconsistent version is refused, never swapped for the active pointer.</div>
      </div>
    </div>

    <div class="panel">
      <div class="k">Fresh brain ${fresh ? badge("PENDING_REVIEW", fresh.status) : ""}</div>
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
      <table><tr><th>Job</th><th>Kind</th><th>Mode</th><th>Status</th><th>Phase</th><th>Progress</th><th>Created</th><th></th></tr>
        ${c.jobs.map((j) => `
          <tr>
            <td class="small"><a href="#" data-job="${esc(j.jobId)}">${esc(j.jobId)}</a></td>
            <td>${esc(j.kind)}</td>
            <td class="small">${esc(j.mode ?? "—")}</td>
            <td>${badge(j.terminal ? (j.status === "completed" ? "REVIEWED" : j.status === "failed" ? "REJECTED" : "PENDING_REVIEW") : "PENDING_REVIEW", j.status)}</td>
            <td class="small">${esc(j.phase ?? "—")}</td>
            <td class="small">${esc(j.progress ? JSON.stringify(j.progress) : "—")}</td>
            <td class="small">${when(j.createdAt)}</td>
            <td>${j.terminal ? "" : `<button data-stop="${esc(j.jobId)}" class="danger" ${roAttr()}>Stop</button>`}</td>
          </tr>`).join("") || `<tr><td colspan="8" class="muted">No jobs yet.</td></tr>`}
      </table>
      ${c.jobs.some((j) => j.note || j.error || j.result) ? `<div class="small muted" style="margin-top:8px">
        ${c.jobs.slice(0, 6).map((j) => `<div><strong>${esc(j.jobId)}</strong> ${esc(j.error ?? j.note ?? "")} ${j.result?.decision ? `· decision ${esc(j.result.decision)}` : ""}${j.result?.version ? `· ${esc(j.result.version)}` : ""}</div>`).join("")}
      </div>` : ""}
    </div>
    <div id="jobDetail"></div>
  `;
  wireControl();
}

function wireControl() {
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
  for (const el of document.querySelectorAll("[data-job]")) {
    el.addEventListener("click", (e) => { e.preventDefault(); openJob(el.dataset.job); });
  }
}

async function openJob(jobId) {
  const box = document.getElementById("jobDetail");
  box.innerHTML = `<div class="panel loading">Loading job…</div>`;
  try {
    const d = await api(`/jobs/${encodeURIComponent(jobId)}`);
    box.innerHTML = `
      <div class="panel">
        <div class="toolbar"><strong>${esc(jobId)}</strong> ${badge(d.job.status, d.job.status)}
          <span class="small muted">${esc(d.job.kind)} · ${esc(d.job.mode)}</span>
          <span style="flex:1"></span><button data-close-job>close</button></div>
        ${d.job.error ? `<div class="small bad">${esc(d.job.error)}</div>` : ""}
        ${d.job.note ? `<div class="small muted">${esc(d.job.note)}</div>` : ""}
        ${d.job.result ? `<pre class="small">${esc(JSON.stringify(d.job.result, null, 2))}</pre>` : ""}
        <div class="k" style="margin-top:8px">Log</div>
        <div class="log-box small">${(d.log ?? []).map((l) => `<div><span class="muted">${when(l.at)}</span> [${esc(l.stream)}] ${esc(l.text)}</div>`).join("") || `<div class="muted">no log lines</div>`}</div>
      </div>`;
    box.querySelector("[data-close-job]")?.addEventListener("click", () => (box.innerHTML = ""));
  } catch (err) {
    box.innerHTML = `<div class="panel notice"><span class="bad">${esc(err.message)}</span></div>`;
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
    try { const d = JSON.parse(e.data); if (d.gap) refresh(); state.seq = Math.max(state.seq, d.currentSeq ?? 0); } catch {}
  });
  es.addEventListener("change", (e) => {
    try { const d = JSON.parse(e.data); state.seq = Math.max(state.seq, d.seq ?? 0); } catch {}
    schedule();
  });
  es.addEventListener("resync", () => refresh());
  es.onerror = () => { state.live = false; updatePills(); };
}

// -------------------------------------------------------------------- boot
for (const b of document.querySelectorAll("#tabs button")) b.addEventListener("click", () => setTab(b.dataset.tab));
document.getElementById("workspaceSelect")?.addEventListener("change", (e) => selectWorkspace(e.target.value));
document.getElementById("modelVersion")?.addEventListener("change", (e) => setPinnedVersion(e.target.value));
loadWorkspaces().catch((err) => {
  main.innerHTML = `<div class="panel notice"><div class="title bad">Cannot load workspaces</div><div class="muted">${esc(err.message)}</div></div>`;
});
connectSSE();
setInterval(() => { if (!state.live) updatePills(); }, 5000);
