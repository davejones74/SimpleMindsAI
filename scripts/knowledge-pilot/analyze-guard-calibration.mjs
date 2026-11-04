#!/usr/bin/env node
/** Read-only calibration analysis over recorded paired evaluation evidence. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { decideWorkingAdvancement } from "../../src/training/working-guard.js";

const REG = process.env.REGISTRY_DIR ?? "/var/lib/simpleminds/data/registry";

async function loadEvidence(rel) {
  if (!rel) return null;
  try { return JSON.parse(await readFile(path.join(REG, rel), "utf8")); } catch { return null; }
}

function groupsFrom(evidence) {
  const map = new Map();
  for (const d of evidence?.perDocument ?? []) {
    const key = String(d.group ?? d.articleId ?? "unknown");
    const tokens = Number(d.tokens) || 0;
    const loss = Number(d.loss);
    if (!Number.isFinite(loss) || tokens <= 0) continue;
    const g = map.get(key) ?? { group: key, tokens: 0, weighted: 0, documents: 0 };
    g.tokens += tokens;
    g.weighted += loss * tokens;
    g.documents += 1;
    map.set(key, g);
  }
  return [...map.values()].map((g) => ({ group: g.group, tokens: g.tokens, documents: g.documents, loss: g.weighted / g.tokens }));
}

function result(evidence, version) {
  if (!evidence) return null;
  return {
    ok: Number.isFinite(Number(evidence.evaluationLoss)),
    version,
    loss: Number(evidence.evaluationLoss),
    groups: groupsFrom(evidence),
    perDocument: evidence.perDocument ?? [],
    datasetHash: evidence.evaluationSet?.fileHash ?? null,
  };
}

function quantiles(values) {
  const sorted = [...values].sort((a,b)=>a-b);
  const q = (p) => sorted.length ? sorted[Math.min(sorted.length-1, Math.max(0, Math.floor((sorted.length-1)*p)))] : null;
  return { min: sorted[0] ?? null, p25: q(.25), median: q(.5), p75: q(.75), p90: q(.9), max: sorted.at(-1) ?? null };
}

const rows = [];
const evalRows = (await readFile(path.join(REG, "evaluations.ndjson"), "utf8")).split("\n").filter(Boolean).map(JSON.parse);
const byRun = new Map();
for (const row of evalRows) {
  if (!row.runId) continue;
  const entry = byRun.get(row.runId) ?? {};
  entry[row.kind] = row;
  byRun.set(row.runId, entry);
}
const decisions = new Map();
for (const line of (await readFile(path.join(REG, "model-events.ndjson"), "utf8")).split("\n").filter(Boolean)) {
  const e = JSON.parse(line); decisions.set(e.modelId, e.status);
}
const models = new Map();
for (const line of (await readFile(path.join(REG, "models.ndjson"), "utf8")).split("\n").filter(Boolean)) {
  const m = JSON.parse(line); models.set(m.modelId, m);
}
for (const [runId, kinds] of byRun.entries()) {
  if (!kinds.baseline || !kinds.candidate) continue;
  const baseEv = await loadEvidence(kinds.baseline.evidenceFile);
  const candEv = await loadEvidence(kinds.candidate.evidenceFile);
  const parent = result(baseEv, kinds.baseline.version);
  const candidate = result(candEv, kinds.candidate.version);
  if (!parent || !candidate || !parent.ok || !candidate.ok || !candidate.groups.length) continue;
  const modelId = kinds.candidate.modelId ?? null;
  const status = modelId ? decisions.get(modelId) ?? null : null;
  const defaultDecision = decideWorkingAdvancement({ parent, candidate, stable: parent, thresholds: { maxRegressionNats: 0.05, maxGroupRegressionNats: 0.15, maxDriftNats: 0.10, minGroupTokens: 100, maxRegressedGroupShare: 0.75, minGroups: 5 } });
  const wideDecision = decideWorkingAdvancement({ parent, candidate, stable: parent, thresholds: { maxRegressionNats: 0.10, maxGroupRegressionNats: 0.20, maxDriftNats: 0.10, minGroupTokens: 100, maxRegressedGroupShare: 0.75, minGroups: 5 } });
  rows.push({ runId, version: candidate.version, status, parentLoss: parent.loss, candidateLoss: candidate.loss, regression: candidate.loss-parent.loss, default: defaultDecision.decision, defaultReason: defaultDecision.reason, wide: wideDecision.decision, wideReason: wideDecision.reason, metrics: defaultDecision.metrics });
}
const rejected = rows.filter(r=>r.status==='rejected');
const promoted = rows.filter(r=>r.status==='promoted');
const out = {
  schema:'sma/working-guard-calibration@1',
  at:new Date().toISOString(),
  registry:REG,
  runsWithPairedEvidence:rows.length,
  statusCounts: rows.reduce((a,r)=>{a[r.status??'unknown']=(a[r.status??'unknown']??0)+1;return a;},{}),
  defaultThresholds:{maxRegressionNats:0.05,maxGroupRegressionNats:0.15,maxDriftNats:0.10,minGroupTokens:100,maxRegressedGroupShare:0.75,minGroups:5},
  wideThresholds:{maxRegressionNats:0.10,maxGroupRegressionNats:0.20,maxDriftNats:0.10,minGroupTokens:100,maxRegressedGroupShare:0.75,minGroups:5},
  rejectedAcceptedByDefault: rejected.filter(r=>r.default==='accepted').length,
  rejectedAcceptedByWide: rejected.filter(r=>r.wide==='accepted').length,
  promotedAcceptedByDefault: promoted.filter(r=>r.default==='accepted').length,
  promotedAcceptedByWide: promoted.filter(r=>r.wide==='accepted').length,
  rejectedOverallRegression: quantiles(rejected.map(r=>r.regression)),
  rejectedWorstGroup: quantiles(rejected.map(r=>r.metrics?.worstGroup?.improvement ?? 0)),
  rows,
};
console.log(JSON.stringify(out,null,2));
