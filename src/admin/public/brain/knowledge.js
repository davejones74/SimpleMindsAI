const API = "/api/admin/knowledge-accumulation";
const state = { data: null, loading: false, error: null };

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}[char]));

const fmt = (value, digits = 0) => {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  const n = Number(value);
  return Number.isInteger(n) && digits === 0 ? n.toLocaleString() : n.toFixed(digits);
};

const pct = (value, digits = 1) => (
  value === null || value === undefined || Number.isNaN(Number(value)) ? "—" : `${(Number(value) * 100).toFixed(digits)}%`
);

const when = (value) => (value ? new Date(value).toLocaleString() : "—");

const tag = (value, tone = "") => `<span class="ka-tag ${tone}">${esc(value)}</span>`;

const statusTone = (value) => {
  const text = String(value ?? "").toLowerCase();
  if (["promoted", "accepted", "running", "available", "ready"].includes(text)) return "good";
  if (["rejected", "failed", "stopped", "over-budget", "blocked"].includes(text)) return "bad";
  if (["waiting", "inconclusive", "paused", "within-budget", "calculated"].includes(text)) return "warn";
  return "";
};

function metricCard(label, value, { sub = null, tone = "", source = "current" } = {}) {
  return `<div class="ka-card">
    <div class="ka-card-head"><span>${esc(label)}</span>${tag(source, "source")}</div>
    <div class="ka-value ${esc(tone)}">${value}</div>
    ${sub ? `<div class="ka-sub">${sub}</div>` : ""}
  </div>`;
}

function tokenBar(fresh, replay, validation) {
  const f = Number(fresh) || 0;
  const r = Number(replay) || 0;
  const v = Number(validation) || 0;
  const total = Math.max(1, f + r + v);
  return `<div class="ka-stack" role="img" aria-label="Fresh ${fmt(f)} tokens, replay ${fmt(r)} tokens, validation ${fmt(v)} tokens">
    <span class="ka-stack-fresh" style="width:${(f / total) * 100}%"></span>
    <span class="ka-stack-replay" style="width:${(r / total) * 100}%"></span>
    <span class="ka-stack-validation" style="width:${(v / total) * 100}%"></span>
  </div>
  <div class="ka-legend">
    <span><i class="ka-dot fresh"></i>Fresh ${fmt(f)}</span>
    <span><i class="ka-dot replay"></i>Replay ${fmt(r)}</span>
    <span><i class="ka-dot validation"></i>Validation ${fmt(v)}</span>
  </div>`;
}

function historyRows(rows, kind) {
  if (!Array.isArray(rows) || !rows.length) return `<div class="ka-empty">No recorded ${esc(kind)} history.</div>`;
  return `<div class="ka-table-wrap"><table class="ka-table">
    <thead><tr><th>Run</th><th>Decision</th><th>Version</th><th>Δ loss</th><th>Optimizer</th><th>When</th></tr></thead>
    <tbody>${rows.slice().reverse().map((row) => `<tr>
      <td>${esc(row.runId ?? "—")}</td>
      <td>${tag(row.workingDecision ?? row.promotionStatus ?? row.status ?? "—", statusTone(row.workingDecision ?? row.promotionStatus ?? row.status))}</td>
      <td>${esc(row.workingVersion ?? row.version ?? "—")}${row.workingParentVersion ? ` ← ${esc(row.workingParentVersion)}` : ""}</td>
      <td>${row.evaluationDelta === null || row.evaluationDelta === undefined ? "—" : esc(fmt(row.evaluationDelta, 4))}</td>
      <td>${esc(row.optimizerMode ?? "—")}</td>
      <td>${esc(when(row.completedAt ?? row.startedAt ?? row.at))}</td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

export function renderKnowledge(data) {
  if (!data) return `<div class="ka-empty">No knowledge-accumulation telemetry.</div>`;
  const pointers = data.pointers ?? {};
  const stable = data.stable ?? {};
  const working = data.working ?? {};
  const optimizer = data.optimizer ?? {};
  const corpus = data.corpus ?? {};
  const training = data.training ?? {};
  const validation = data.validation ?? {};
  const authoritative = validation.authoritative ?? null;
  const guard = data.groupEvaluation ?? {};
  const drift = data.drift ?? {};
  const lifecycle = data.lifecycle ?? {};
  const decision = data.stableDecision ?? {};
  const counts = data.counts ?? {};
  const funnel = data.funnel ?? {};
  const licence = data.licence ?? {};
  const learning = data.learningEffectiveness ?? {};
  const freshTokens = corpus.fresh?.tokens;
  const replayTokens = corpus.replay?.tokens;
  const validationTokens = corpus.validation?.tokens;
  const totalTraining = Number(freshTokens) + Number(replayTokens);
  const optimizerState = optimizer.statePresent
    ? `${fmt(optimizer.stateBytes)} bytes · ${esc(when(optimizer.stateModifiedAt))}`
    : "state file missing";
  const trainerBlockCount = lifecycle.trainingJob?.meta?.blockCount;
  const trainerWaiting = String(lifecycle.trainingJob?.status ?? "").toLowerCase() === "waiting";
  const validationState = trainerWaiting
    ? (lifecycle.waitingNote ?? "Trainer is waiting for a complete prospective validation block.")
    : validation.available
      ? `${fmt(validation.validationArticleCount)} validation article(s), ${fmt(validation.validationClusterCount)} cluster(s), ${fmt(validation.prospectiveTokens)} estimated tokens`
      : (validation.error?.message ?? "No prospective validation cohort available.");
  return `<div class="ka-headline">
    <div>
      <div class="ka-kicker">Production telemetry</div>
      <div class="ka-title">Knowledge accumulation</div>
      <div class="ka-sub">Snapshot ${esc(when(data.at))}. Historical rows are labelled; calculated availability is derived from current store and validator state.</div>
    </div>
    <div class="ka-headline-chips">
      ${tag(`active ${stable.version ?? pointers.active?.version ?? "—"}`, "good")}
      ${tag(`working ${working.version ?? pointers.working?.version ?? "—"}`, "warn")}
      ${tag(`last-good ${working.lastGoodVersion ?? pointers.lastGood?.version ?? "—"}`, "neutral")}
      ${tag(lifecycle.waitingReason ?? "training active", statusTone(lifecycle.waitingReason ? "waiting" : "running"))}
    </div>
  </div>

  <div class="ka-grid ka-grid-4">
    ${metricCard("Stable serving", esc(stable.version ?? "—"), { sub: `${esc(stable.artifactName ?? "—")}<br>${esc(stable.activatedAt ? `activated ${when(stable.activatedAt)}` : "activation time unavailable")}`, source: "current" })}
    ${metricCard("Working checkpoint", esc(working.version ?? "—"), { sub: `${esc(working.artifactName ?? "—")}<br>${esc(working.advancementCount ?? 0)} advances · ${esc(working.rejectionCount ?? 0)} rejections`, tone: "warn", source: "current" })}
    ${metricCard("Cumulative drift", esc(fmt(drift.current, 4)), { sub: `max ${esc(fmt(drift.max, 4))} · ${esc(drift.status ?? "unknown")}${drift.rollback ? " · rollback recorded" : ""}`, tone: statusTone(drift.status), source: "current" })}
    ${metricCard("Optimizer continuity", esc(optimizer.mode ?? "—"), { sub: `parent ${esc(optimizer.parentVersion ?? "—")} · ${esc(optimizer.stepsCompleted ?? "—")} steps<br>${esc(optimizerState)}`, tone: optimizer.statePresent ? "good" : "bad", source: "metadata" })}
  </div>

  <div class="ka-grid ka-grid-2">
    <section class="ka-panel">
      <div class="ka-panel-title">Training corpus mix <span class="ka-tag source">measured</span></div>
      ${totalTraining > 0 ? tokenBar(freshTokens, replayTokens, validationTokens) : `<div class="ka-empty">No completed training run corpus telemetry.</div>`}
      <div class="ka-kv">
        <span>Measured replay share</span><strong>${pct(corpus.replayShare)}</strong>
        <span>Configured target</span><strong>${pct(corpus.configuredReplayPercent)}</strong>
        <span>Pre-partition estimate</span><strong>${pct(corpus.prePartitionEstimate)}</strong>
        <span>Training tokens</span><strong>${fmt(totalTraining)}</strong>
        <span>Source</span><strong>${esc(corpus.runId ?? "—")}</strong>
      </div>
      ${corpus.replayShare !== null && corpus.configuredReplayPercent !== null && corpus.replayShare > corpus.configuredReplayPercent / 100
        ? `<div class="ka-note warn">Measured replay is above the configured target for this run. The post-partition correction trims replay against the final fresh stream; the next completed run is the authoritative test.</div>`
        : `<div class="ka-note">Measured values are from the trainer preflight; no pre-partition estimate is presented as a final proportion.</div>`}
    </section>

    <section class="ka-panel">
      <div class="ka-panel-title">Training run <span class="ka-tag source">measured</span></div>
      <div class="ka-kv">
        <span>Run</span><strong>${esc(training.runId ?? "—")}</strong>
        <span>Status</span><strong>${tag(training.status ?? "—", statusTone(training.status))}</strong>
        <span>Steps / planned</span><strong>${fmt(training.steps)} / ${fmt(training.plannedSteps)}</strong>
        <span>Tokens presented</span><strong>${fmt(training.tokensPresented)}</strong>
        <span>Unique tokens</span><strong>${fmt(training.uniqueTokens)}</strong>
        <span>Training wall time</span><strong>${training.wallSeconds === null || training.wallSeconds === undefined ? "—" : `${fmt(training.wallSeconds, 3)} s`}</strong>
        <span>Throughput</span><strong>${training.tokensPerSecond === null || training.tokensPerSecond === undefined ? "—" : `${fmt(training.tokensPerSecond, 1)} tok/s`}</strong>
        <span>Optimizer</span><strong>${esc(training.optimizerMode ?? "—")}${training.carryOptimizerFrom ? ` ← ${esc(training.carryOptimizerFrom)}` : ""}</strong>
      </div>
      <div class="ka-note">${esc(decision.explanation ?? "No stable decision explanation recorded for the latest run.")}</div>
    </section>
  </div>

  <div class="ka-grid ka-grid-2">
    <section class="ka-panel">
      <div class="ka-panel-title">Prospective validation availability <span class="ka-tag calculated">calculated</span></div>
      <div class="ka-kv">
        <span>Node partition</span><strong>${tag(validation.available ? "built" : "waiting", validation.available ? "good" : "warn")}</strong>
        <span>Trainer blocks</span><strong>${trainerWaiting ? tag(`0 / ${fmt(validation.requiredTokensForOneBlock)} tokens`, "warn") : tag(fmt(trainerBlockCount), "neutral")}</strong>
        <span>Prospective clusters</span><strong>${fmt(validation.prospectiveClusters)}</strong>
        <span>Validation articles</span><strong>${fmt(validation.validationArticleCount)}</strong>
        <span>Required clusters</span><strong>${fmt(validation.requiredClusters)}</strong>
        <span>One-block token floor</span><strong>${fmt(validation.requiredTokensForOneBlock)}</strong>
        <span>Largest cluster estimate</span><strong>${fmt(validation.largestProspectiveClusterTokens)}</strong>
        <span>Actual tokens</span><strong>${authoritative ? fmt(authoritative.actualTokens) : "—"}</strong>
        <span>Actual blocks</span><strong>${authoritative ? `${fmt(authoritative.actualBlocks)} / ${fmt(authoritative.targetBlocks)}` : "—"}</strong>
        <span>Actual shortfall</span><strong class="${authoritative && authoritative.shortfallBlocks > 0 ? "bad" : ""}">${authoritative ? fmt(authoritative.shortfallBlocks) : "—"}</strong>
        <span>Training job</span><strong>${tag(lifecycle.trainingJob?.status ?? "—", statusTone(lifecycle.trainingJob?.status))}</strong>
        <span>Phase</span><strong>${esc(lifecycle.trainingJob?.phase ?? "—")}</strong>
      </div>
      <div class="ka-note ${trainerWaiting || validation.waiting ? "warn" : ""}">${esc(validationState)} ${authoritative ? "Tokenizer-measured block counts are authoritative; see Actual blocks." : "Calculated availability can overestimate tokenizer blocks; the trainer block count is authoritative."}</div>
    </section>

    <section class="ka-panel">
      <div class="ka-panel-title">Working guard and stable decision <span class="ka-tag source">measured</span></div>
      <div class="ka-kv">
        <span>Working decision</span><strong>${tag(guard.decision ?? "—", statusTone(guard.decision))}</strong>
        <span>Groups compared</span><strong>${fmt(guard.metrics?.groupsCompared)}</strong>
        <span>Negative groups</span><strong>${fmt(guard.metrics?.negativeGroups)}</strong>
        <span>Groups over 0.15</span><strong>${fmt(guard.metrics?.regressedGroups)}</strong>
        <span>Groups over 0.05</span><strong>${fmt(guard.metrics?.groupsOverTolerance)}</strong>
        <span>Worst group</span><strong>${esc(guard.metrics?.worstGroup?.group ?? "—")} ${guard.metrics?.worstGroup ? `(${esc(fmt(guard.metrics.worstGroup.improvement, 4))})` : ""}</strong>
        <span>Stable decision</span><strong>${tag(decision.decision ?? "—", statusTone(decision.decision))}</strong>
        <span>Stable delta</span><strong>${fmt(decision.delta, 4)} ${decision.noiseBand === null || decision.noiseBand === undefined ? "" : `±${fmt(decision.noiseBand, 4)}`}</strong>
      </div>
      <div class="ka-note">${esc(guard.reason ?? decision.explanation ?? "No guard explanation recorded.")}</div>
      <div class="ka-subhead">Per-group evaluation changes <span class="ka-tag historical">measured</span></div>
      ${groupChangesTable(guard.changes)}
    </section>
  </div>

  <div class="ka-grid ka-grid-3">
    <section class="ka-panel">
      <div class="ka-panel-title">Knowledge-to-trainability funnel <span class="ka-tag calculated">calculated</span></div>
      <div class="ka-kv">
        <span>Articles</span><strong>${fmt(funnel.totalArticles)}</strong>
        <span>Reviewed</span><strong>${fmt(funnel.reviewed)}</strong>
        <span>Unique consumed</span><strong>${fmt(funnel.uniqueConsumed)}</strong>
        <span>Replay pool</span><strong>${fmt(funnel.replayEligible)}</strong>
        <span>Fresh trainable</span><strong>${fmt(funnel.trainable)}</strong>
        <span>Retired</span><strong>${fmt(funnel.retired)}</strong>
        <span>Approved → retired</span><strong>${fmt(funnel.approvedRetired)}</strong>
        <span>Consumed approved → retired</span><strong>${fmt(funnel.consumedApprovedRetired)}</strong>
        <span>…not replayable</span><strong class="${funnel.consumedApprovedRetiredNotReplayable > 0 ? "bad" : ""}">${fmt(funnel.consumedApprovedRetiredNotReplayable)}</strong>
      </div>
      <div class="ka-note">Counts are live store totals. “Fresh trainable” is the only material a new run can consume as new knowledge.</div>
    </section>
    <section class="ka-panel">
      <div class="ka-panel-title">Source licence provenance <span class="ka-tag calculated">calculated</span></div>
      <div class="ka-kv">
        <span>Safe</span><strong>${fmt(licence.safe)}</strong>
        <span>Uncertain</span><strong>${fmt(licence.uncertain)}</strong>
        <span>Restricted</span><strong>${fmt(licence.restricted)}</strong>
        <span>Unknown</span><strong>${fmt(licence.unknown)}</strong>
        <span>Unresolved</span><strong>${fmt(licence.unresolved)}</strong>
      </div>
      <div class="ka-note">Licence resolution is recorded at ingest. It is advisory unless LICENCE_ENFORCEMENT=enforce; unknown and uncertain material is never assumed safe.</div>
    </section>
    <section class="ka-panel">
      <div class="ka-panel-title">Cumulative learning effect <span class="ka-tag measured">measured</span></div>
      <div class="ka-kv">
        <span>Working advances</span><strong>${fmt(learning.summary?.advances)}</strong>
        <span>Measured</span><strong>${fmt(learning.summary?.measured)}</strong>
        <span>Net Δ vs stable</span><strong class="${Number(learning.summary?.netDeltaVsStable) > 0 ? "bad" : "good"}">${fmt(learning.summary?.netDeltaVsStable, 4)}</strong>
        <span>Best Δ</span><strong>${fmt(learning.summary?.bestDeltaVsStable, 4)} · ${esc(learning.summary?.bestVersion ?? "—")}</strong>
        <span>Worst Δ</span><strong>${fmt(learning.summary?.worstDeltaVsStable, 4)} · ${esc(learning.summary?.worstVersion ?? "—")}</strong>
        <span>Regressions</span><strong>${fmt(learning.summary?.regressionsVsStable)} / ${fmt(learning.summary?.measured)}</strong>
        <span>Drift velocity</span><strong>${fmt(learning.summary?.driftVelocity, 4)} nats/advance</strong>
        <span>Sealed prospective</span><strong>${learning.prospective ? tag("present", "good") : tag("not configured", "warn")}</strong>
        <span>Retention probe</span><strong>${learning.retention ? tag("present", "good") : tag("not configured", "warn")}</strong>
      </div>
      <div class="ka-note">Working advancement is not a learning result. Only a sealed prospective benchmark and retention probe can demonstrate generalisation and retention.</div>
    </section>
  </div>

  <div class="ka-grid ka-grid-2">
    <section class="ka-panel">
      <div class="ka-panel-title">Working advancement history <span class="ka-tag historical">historical</span></div>
      ${historyRows(working.advancementHistory, "working advancement")}
    </section>
    <section class="ka-panel">
      <div class="ka-panel-title">Stable promotion history <span class="ka-tag historical">historical</span></div>
      ${promotionTable(stable.promotionHistory, stable)}
    </section>
  </div>

  <section class="ka-panel">
    <div class="ka-panel-title">Working learning trajectory <span class="ka-tag measured">measured</span></div>
    ${learningTrajectoryTable(learning.trajectory)}
  </section>

  <div class="ka-footer">
    <span>${tag(`${counts.runs ?? 0} runs`, "neutral")} ${tag(`${counts.workingAdvances ?? 0} working advances`, "warn")} ${tag(`${counts.stablePromotions ?? 0} stable promotions`, "good")} ${tag(`${counts.stableRejections ?? 0} stable rejections`, "bad")} ${tag(`${counts.stableInconclusive ?? 0} inconclusive`, "warn")}</span>
    <span>${esc(data.optimizer?.source ?? "")}</span>
  </div>`;
}

function learningTrajectoryTable(rows) {
  if (!Array.isArray(rows) || !rows.length) return `<div class="ka-empty">No working trajectory recorded.</div>`;
  return `<div class="ka-table-wrap"><table class="ka-table">
    <thead><tr><th>Run</th><th>Version</th><th>Candidate loss</th><th>Δ vs stable</th><th>Fresh tokens</th><th>Replay share</th></tr></thead>
    <tbody>${rows.slice().reverse().map((row) => `<tr>
      <td>${esc(row.runId ?? "—")}</td>
      <td>${esc(row.version ?? "—")}${row.parentVersion ? ` ← ${esc(row.parentVersion)}` : ""}</td>
      <td>${fmt(row.candidateLoss, 6)}</td>
      <td class="${Number(row.deltaVsStable) > 0 ? "bad" : "good"}">${fmt(row.deltaVsStable, 6)}</td>
      <td>${fmt(row.freshTokens)}</td>
      <td>${pct(row.replayShare)}</td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function groupChangesTable(changes) {
  if (!changes) return `<div class="ka-empty">Per-group evidence unavailable for this run.</div>`;
  const rows = (changes.worst ?? []).slice(0, 6);
  const best = (changes.best ?? []).slice(0, 3);
  const line = (row) => `<div class="ka-group-row">
    <span class="ka-group-name" title="${esc(row.group)}">${esc(String(row.group ?? "").replace(/^https?:\/\//, ""))}</span>
    <span class="${row.improvement < 0 ? "bad" : "good"}">${row.improvement > 0 ? "+" : ""}${fmt(row.improvement, 4)}</span>
    <span class="ka-group-tokens">${fmt(row.tokens)} tok</span>
  </div>`;
  return `<div class="ka-group-grid">
    <div><div class="ka-group-label">Largest regressions</div>${rows.map(line).join("")}</div>
    <div><div class="ka-group-label">Largest improvements</div>${best.map(line).join("")}</div>
  </div>`;
}

function promotionTable(rows, stable) {
  if (!Array.isArray(rows) || !rows.length) return `<div class="ka-empty">No stable promotions recorded.</div>`;
  return `<div class="ka-table-wrap"><table class="ka-table">
    <thead><tr><th>Run</th><th>Version</th><th>Promoted</th><th>When</th></tr></thead>
    <tbody>${rows.slice().reverse().map((row) => `<tr>
      <td>${esc(row.runId ?? "—")}</td>
      <td>${esc(row.workingVersion ?? stable.version ?? "—")}</td>
      <td>${tag("promoted", "good")}</td>
      <td>${esc(when(row.completedAt ?? row.startedAt ?? row.at))}</td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

async function refresh() {
  const body = document.getElementById("knowledgeBody");
  const subtitle = document.getElementById("knowledgeSubtitle");
  if (!body || state.loading) return;
  state.loading = true;
  if (subtitle) subtitle.textContent = "Reading production telemetry…";
  try {
    const response = await fetch(API, { headers: { accept: "application/json" } });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`);
    state.data = data;
    state.error = null;
    body.innerHTML = renderKnowledge(data);
    if (subtitle) subtitle.textContent = `Live snapshot ${when(data.at)} · no SSE, no training mutation`;
  } catch (error) {
    state.error = error;
    body.innerHTML = `<div class="ka-empty bad">Knowledge telemetry unavailable: ${esc(error.message)}</div>`;
    if (subtitle) subtitle.textContent = "Telemetry unavailable";
  } finally {
    state.loading = false;
  }
}

function setOpen(open) {
  const panel = document.getElementById("knowledgePanel");
  const toggle = document.getElementById("knowledgeToggle");
  if (!panel || !toggle) return;
  panel.classList.toggle("hidden", !open);
  toggle.setAttribute("aria-expanded", String(open));
  toggle.classList.toggle("active", open);
  if (open) refresh();
}

function init() {
  if (typeof document === "undefined") return;
  const toggle = document.getElementById("knowledgeToggle");
  const close = document.getElementById("knowledgeClose");
  const refreshButton = document.getElementById("knowledgeRefresh");
  toggle?.addEventListener("click", () => setOpen(document.getElementById("knowledgePanel")?.classList.contains("hidden") !== false));
  close?.addEventListener("click", () => setOpen(false));
  refreshButton?.addEventListener("click", () => refresh());
  document.addEventListener("keydown", (event) => {
    if (event.key.toLowerCase() === "k" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const panel = document.getElementById("knowledgePanel");
      if (!panel || panel.classList.contains("hidden")) setOpen(true);
    }
  });
}

init();
