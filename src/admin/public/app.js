const API = "/api/admin";

const state = {
  tab: "dashboard",
  overview: null,
  articles: { items: [], nextCursor: null, filters: {} },
  selectedArticle: null,
  chat: { messages: [], identity: null, sending: false },
  mission: null,
  strategy: null,
  cycles: null,
  history: null,
  live: false,
  seq: 0,
};

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v) => (v === null || v === undefined ? "—" : typeof v === "number" ? (Number.isInteger(v) ? v.toLocaleString() : v.toFixed(3)) : String(v));
const when = (iso) => (iso ? new Date(iso).toLocaleString() : "—");
const badge = (cls, text) => `<span class="badge ${esc(cls)}">${esc(text)}</span>`;

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(API + path, {
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
    state.overview = await api("/overview");
    state.seq = Math.max(state.seq, state.overview.changeSeq ?? 0);
    updatePills();
    if (state.tab === "dashboard") renderDashboard();
    if (state.tab === "articles") await loadArticles();
    if (state.tab === "chat") await loadChat();
    if (state.tab === "mission") await loadMission();
    if (state.tab === "cycles") await loadCycles();
    if (state.tab === "history") await loadHistory();
  } catch (err) {
    main.innerHTML = `<div class="panel notice"><div class="title bad">Portal error</div><div class="muted">${esc(err.message)}</div></div>`;
  }
}

function updatePills() {
  const py = state.overview?.pythonStore;
  const store = document.getElementById("storePill");
  if (!py || !py.available) {
    store.className = "pill warn";
    store.textContent = py ? "python store: unavailable" : "store: —";
    store.title = py?.reason ?? "";
  } else {
    store.className = "pill";
    store.textContent = `python store: ${py.versions.length} version(s)`;
  }
  const live = document.getElementById("livePill");
  live.className = `pill ${state.live ? "online" : "offline"}`;
  live.textContent = state.live ? "live ●" : "live ○";
}

function render() {
  if (state.tab === "dashboard") renderDashboard();
  else if (state.tab === "articles") renderArticles();
  else if (state.tab === "chat") renderChat();
  else if (state.tab === "mission") renderMission();
  else if (state.tab === "cycles") renderCycles();
  else if (state.tab === "history") renderHistory();
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
    <h2 class="section-title">Dashboard</h2>
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
      <button id="selectReview" class="primary">Run review selection</button>
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
        <td>${badge(x.importance.toUpperCase(), x.importance)}${x.suggestedImportance ? ` <span class="small muted">sugg ${esc(x.suggestedImportance)}</span>` : ""}</td>
        <td>${badge(x.status, x.status)}</td>
        <td>${x.trainable ? "✔" : "—"}</td>
        <td>${x.consumedAt ? `<span title="${esc(x.consumedRef ?? "")}">${when(x.consumedAt)}</span>` : "—"}</td>
        <td class="actions">
          <button data-imp="${esc(x.articleId)}" data-val="Important">Mark Important</button>
          <button data-req="${esc(x.articleId)}">Request review</button>
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
    e.target.textContent = "selecting…";
    try { const r = await api("/articles/select-for-review", { method: "POST", body: { limit: 500 } }); alert(`Queued ${r.selected.length} article(s) for review.`); await refresh(); }
    catch (err) { alert(err.message); }
  });
  for (const el of document.querySelectorAll("[data-open]")) {
    el.addEventListener("click", (e) => { e.preventDefault(); openArticle(el.dataset.open); });
  }
  for (const el of document.querySelectorAll("[data-req]")) {
    el.addEventListener("click", async () => {
      try { await api(`/articles/${encodeURIComponent(el.dataset.req)}/request-review`, { method: "POST", body: {} }); await loadArticles(); }
      catch (err) { alert(err.message); }
    });
  }
  for (const el of document.querySelectorAll("[data-imp]")) {
    el.addEventListener("click", async () => {
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
      <div class="toolbar" style="margin-top:12px">
        <label class="small muted">Importance</label>
        <select id="dImp">${["NORMAL", "IMPORTANT", "CRITICAL"].map((v) => `<option ${a.importance.toUpperCase() === v ? "selected" : ""}>${v}</option>`).join("")}</select>
        <button id="dSetImp">Set importance</button>
        <span style="flex:1"></span>
        <button id="dApprove" class="primary">Human approve</button>
        <button id="dReject" class="danger">Human reject</button>
        <button id="dPending">Set pending</button>
      </div>
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
    const importance = document.getElementById("dImp").value;
    try { await api(`/articles/${encodeURIComponent(a.articleId)}/importance`, { method: "POST", body: { importance } }); await openArticle(a.articleId); await loadArticles(); }
    catch (err) { alert(err.message); }
  });
  const review = (verdict) => async () => {
    try {
      await api(`/articles/${encodeURIComponent(a.articleId)}/review`, { method: "POST", body: { verdict, authority: "human" } });
      await openArticle(a.articleId); await loadArticles();
    } catch (err) { alert(err.message); }
  };
  document.getElementById("dApprove")?.addEventListener("click", review("approve"));
  document.getElementById("dReject")?.addEventListener("click", review("reject"));
  document.getElementById("dPending")?.addEventListener("click", async () => {
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
    <h2 class="section-title">Live Chat</h2>
    <div class="panel">
      <div class="toolbar">
        <span class="k">Student</span>
        ${badge(id.available ? "REVIEWED" : "REJECTED", id.available ? "available" : "unavailable")}
        <span class="muted small">mode: ${esc(id.mode ?? "—")} · version: ${esc(id.version ?? "none")}</span>
      </div>
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
    <div class="cols">
      <div class="panel">
        <div class="k">Primary mission ${badge("seed", "operator-only")}</div>
        <div class="prose">${esc(m.primary?.text ?? "—")}</div>
        <div class="small muted">version ${m.primary?.version ?? "—"} · AI cannot modify this; only an audited operator action can.</div>
        <textarea id="primaryText" placeholder="Amend primary mission (audited)…"></textarea>
        <button id="primaryApply" class="danger">Amend primary mission</button>
      </div>
      <div class="panel">
        <div class="k">Secondary mission (evolvable)</div>
        <div class="prose">${esc(m.secondary?.text ?? "—")}</div>
        <textarea id="secondaryText">${esc(m.secondary?.text ?? "")}</textarea>
        <div class="toolbar">
          <input type="text" id="secondaryRationale" placeholder="rationale (recorded with the version)" />
          <button id="secondaryApply" class="primary">Save as new version</button>
          <button id="secondaryPropose">Propose AI change</button>
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
              <button data-approve-mission="${esc(p.proposalId)}" class="primary">Approve</button>
              <button data-reject-mission="${esc(p.proposalId)}" class="danger">Reject</button>
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
        <textarea id="strategyText">${esc(JSON.stringify(s.active?.strategy ?? {}, null, 2))}</textarea>
        <div class="toolbar">
          <input type="text" id="strategyRationale" placeholder="rationale" />
          <button id="strategyApply" class="primary">Save as new version</button>
          <button id="strategyPropose">Propose update</button>
        </div>
      </div>
      <div class="panel">
        <div class="k">Pending strategy proposals (${s.proposals.length})</div>
        ${s.proposals.length ? s.proposals.map((p) => `
          <div class="history-item ai">
            <pre>${esc(JSON.stringify(p.strategy, null, 2))}</pre>
            <div class="small muted">${esc(p.rationale ?? "")} · ${when(p.at)}</div>
            <div class="toolbar">
              <button data-approve-strategy="${esc(p.proposalId)}" class="primary">Approve</button>
              <button data-reject-strategy="${esc(p.proposalId)}" class="danger">Reject</button>
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
    try {
      await api("/mission/secondary", { method: "POST", body: { text: document.getElementById("secondaryText").value, rationale: document.getElementById("secondaryRationale").value } });
      await loadMission();
    } catch (err) { alert(err.message); }
  });
  document.getElementById("secondaryPropose")?.addEventListener("click", async () => {
    try {
      await api("/mission/proposals", { method: "POST", body: { text: document.getElementById("secondaryText").value, rationale: document.getElementById("secondaryRationale").value } });
      await loadMission();
    } catch (err) { alert(err.message); }
  });
  document.getElementById("primaryApply")?.addEventListener("click", async () => {
    const text = document.getElementById("primaryText").value;
    if (!confirm("Amend the primary mission? This is an audited operator action.")) return;
    try { await api("/mission/primary", { method: "POST", body: { text, rationale: "operator amendment" } }); await loadMission(); }
    catch (err) { alert(err.message); }
  });
  for (const el of document.querySelectorAll("[data-approve-mission]")) {
    el.addEventListener("click", async () => { try { await api(`/mission/proposals/${encodeURIComponent(el.dataset.approveMission)}/approve`, { method: "POST", body: {} }); await loadMission(); } catch (err) { alert(err.message); } });
  }
  for (const el of document.querySelectorAll("[data-reject-mission]")) {
    el.addEventListener("click", async () => { try { await api(`/mission/proposals/${encodeURIComponent(el.dataset.rejectMission)}/reject`, { method: "POST", body: {} }); await loadMission(); } catch (err) { alert(err.message); } });
  }
  document.getElementById("strategyApply")?.addEventListener("click", async () => {
    try {
      const strategy = JSON.parse(document.getElementById("strategyText").value);
      await api("/strategy", { method: "POST", body: { strategy, rationale: document.getElementById("strategyRationale").value } });
      await loadMission();
    } catch (err) { alert(`invalid strategy JSON or server error: ${err.message}`); }
  });
  document.getElementById("strategyPropose")?.addEventListener("click", async () => {
    try {
      const strategy = JSON.parse(document.getElementById("strategyText").value);
      await api("/strategy/proposals", { method: "POST", body: { strategy, rationale: document.getElementById("strategyRationale").value } });
      await loadMission();
    } catch (err) { alert(`invalid strategy JSON or server error: ${err.message}`); }
  });
  for (const el of document.querySelectorAll("[data-approve-strategy]")) {
    el.addEventListener("click", async () => { try { await api(`/strategy/proposals/${encodeURIComponent(el.dataset.approveStrategy)}/approve`, { method: "POST", body: {} }); await loadMission(); } catch (err) { alert(err.message); } });
  }
  for (const el of document.querySelectorAll("[data-reject-strategy]")) {
    el.addEventListener("click", async () => { try { await api(`/strategy/proposals/${encodeURIComponent(el.dataset.rejectStrategy)}/reject`, { method: "POST", body: {} }); await loadMission(); } catch (err) { alert(err.message); } });
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
            <td>${cy.status === "open" ? `<button data-close-cycle="${esc(cy.reviewCycleId)}" class="primary">Close</button>` : ""}</td>
          </tr>`).join("") || `<tr><td colspan="9" class="muted">No cycles yet (need ${fmt(c.interval)} consumed articles to open the first).</td></tr>`}
      </table>
    </div>`;
  for (const el of document.querySelectorAll("[data-close-cycle]")) {
    el.addEventListener("click", async () => {
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
    <h2 class="section-title">Training History</h2>
    ${h.discrepancies.length ? `<div class="panel notice">
      <div class="title warn">${h.discrepancies.length} discrepancy(ies) between Node registry and Python store — reported, not silently reconciled</div>
      <ul class="small">${h.discrepancies.map((d) => `<li>${esc(d.kind)}${d.version ? ` — ${esc(d.version)}` : ""}${d.detail ? ` (${esc(d.detail)})` : ""}</li>`).join("")}</ul>
    </div>` : `<div class="panel"><span class="ok">Registry and Python store agree.</span> <span class="small muted">Node = orchestration/audit; Python = committed artifacts.</span></div>`}

    <div class="cols">
      <div class="panel">
        <div class="k">Training runs (Node registry)</div>
        <table><tr><th>Run</th><th>Status</th><th>Records</th><th>Score (base→trained)</th><th>Loss (base→trained)</th><th>Δ</th><th>Started</th></tr>
          ${r.runs.slice().reverse().map((run) => `
            <tr><td class="small">${esc(run.runId)}</td>
            <td>${badge(run.promotionStatus === "promoted" ? "REVIEWED" : run.promotionStatus === "rejected" ? "REJECTED" : "PENDING_REVIEW", run.status)}</td>
            <td>${fmt(run.recordCount)}</td>
            <td>${run.baselineScore == null && run.trainedScore == null ? "—" : `${fmt(run.baselineScore)} → ${fmt(run.trainedScore)}`}</td>
            <td>${run.baselineLoss == null && run.trainedLoss == null ? "—" : `${fmt(run.baselineLoss)} → ${fmt(run.trainedLoss)}`}</td>
            <td>${run.evaluationDelta == null ? "—" : `${run.evaluationDelta > 0 ? "+" : ""}${run.evaluationDelta.toFixed(3)}`}</td>
            <td class="small">${when(run.startedAt)}</td></tr>`).join("") || `<tr><td colspan="7" class="muted">No runs yet. Run <code>npm run train</code>.</td></tr>`}
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
  `;
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
refresh();
connectSSE();
setInterval(() => { if (!state.live) updatePills(); }, 5000);
