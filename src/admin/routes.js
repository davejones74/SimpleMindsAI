import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changeFeed as defaultFeed } from "./change-feed.js";
import { readPythonStore } from "./python-store.js";
import { createMissionService } from "./services/mission.js";
import { createStrategyService } from "./services/strategy.js";
import { createReviewCyclesService } from "./services/review-cycles.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Admin portal backend — REST + SSE mounted onto the EXISTING server.
 *
 * Every mutation goes through a validated Node service (ArticleStore,
 * governance services) and then emits a change-feed event. The browser NEVER
 * writes files and NEVER reads them directly; it only calls these endpoints.
 * SSE carries live deltas; the REST `/overview` is the authoritative snapshot a
 * client re-reads whenever it reconnects or is told to resync.
 */
export function attachAdmin({ app, store, registry, governance, chat, changeFeed = defaultFeed, pythonStorePath = null, logger = console }) {
  const mission = createMissionService({ governance });
  const strategy = createStrategyService({ governance });
  const reviewCycles = createReviewCyclesService({ governance, mission, strategy });

  const router = express.Router();
  router.use(express.json({ limit: "2mb" }));

  const ok = (res, data) => res.json(data ?? { ok: true });
  const fail = (res, err, code = 400) => res.status(code).json({ error: err?.message ?? String(err) });

  const asyncRoute = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => fail(res, err));

  const emit = (type, data) => changeFeed.emit(type, data);

  // ------------------------------------------------------------- overview
  router.get("/overview", asyncRoute(async (_req, res) => {
    await mission.init();
    await strategy.init();
    const stats = store.getStats();
    const py = readPythonStore(pythonStorePath);
    const activeModel = registry.getActiveModel();
    const cycles = reviewCycles.list();
    await reviewCycles.ensureForConsumption(stats.uniqueConsumed);
    ok(res, {
      generatedAt: new Date().toISOString(),
      articles: stats,
      legacy: store.legacyInfo(),
      pythonStore: py,
      registry: {
        activeModel: activeModel
          ? { modelId: activeModel.modelId, status: activeModel.status, createdAt: activeModel.createdAt }
          : null,
        runCount: registry.listRuns().length,
        snapshotCount: registry.listSnapshots().length,
        evaluationCount: registry.listEvaluations().length,
      },
      mission: { primary: mission.primary(), secondary: mission.secondary() },
      strategy: strategy.active(),
      reviewCycles: cycles,
      currentReviewCycle: reviewCycles.current(),
      reviewInterval: reviewCycles.interval(),
      changeSeq: changeFeed.currentSeq(),
    });
  }));

  // ------------------------------------------------------------- articles
  router.get("/articles", asyncRoute(async (req, res) => {
    const { after = null, limit = 50, status, importance, consumed, domain } = req.query;
    ok(res, store.articlesPage({
      after,
      limit: Number(limit) || 50,
      status: status || undefined,
      importance: importance || undefined,
      consumed: consumed === undefined ? undefined : consumed === "true",
      domain: domain || undefined,
    }));
  }));

  router.get("/articles/:articleId", asyncRoute(async (req, res) => {
    const a = store.getArticle(req.params.articleId);
    if (!a) return fail(res, new Error("unknown article"), 404);
    ok(res, { ...a, reviews: store.reviewsFor(a.articleId), events: store.events.filter((e) => e.articleId === a.articleId) });
  }));

  router.post("/articles/select-for-review", asyncRoute(async (req, res) => {
    const ids = await store.selectForReview({ limit: Number(req.body?.limit) || 500 });
    emit("articles.selected", { count: ids.length });
    ok(res, { selected: ids });
  }));

  router.post("/articles/:articleId/importance", asyncRoute(async (req, res) => {
    const a = await store.setImportance(req.params.articleId, req.body?.importance);
    emit("article.updated", { articleId: a.articleId, field: "importance", value: a.importance });
    ok(res, a);
  }));

  router.post("/articles/:articleId/status", asyncRoute(async (req, res) => {
    const a = await store.setStatus(req.params.articleId, req.body?.status, { reason: req.body?.reason ?? null });
    emit("articles.status", { articleId: a.articleId, status: a.status });
    ok(res, a);
  }));

  router.post("/articles/:articleId/request-review", asyncRoute(async (req, res) => {
    const a = await store.requestReview(req.params.articleId, { reason: req.body?.reason ?? null });
    emit("articles.review-requested", { articleId: a.articleId });
    ok(res, a);
  }));

  router.post("/articles/:articleId/review", asyncRoute(async (req, res) => {
    const b = req.body ?? {};
    const result = await store.recordReview({
      articleId: req.params.articleId,
      verdict: b.verdict,
      score: b.score,
      rationale: b.rationale,
      authority: b.authority ?? "human",
      reviewerModel: b.reviewerModel,
      reviewerVersion: b.reviewerVersion,
      rubricVersion: b.rubricVersion,
      suggestedImportance: b.suggestedImportance,
      reviewCycleId: b.reviewCycleId,
    });
    emit("article.reviewed", { articleId: req.params.articleId, applied: result.applied, status: result.article.status });
    ok(res, result);
  }));

  // ---------------------------------------------------------------- chat
  router.get("/chat/identity", asyncRoute(async (_req, res) => ok(res, chat.identity())));
  router.post("/chat", asyncRoute(async (req, res) => {
    const message = String(req.body?.message ?? "").trim();
    if (!message) return fail(res, new Error("message required"));
    try {
      const out = await chat.respond(message);
      emit("chat.message", { at: out.at ?? new Date().toISOString() });
      ok(res, out);
    } catch (err) {
      fail(res, err, chat.isUnavailable(err) ? 503 : 502);
    }
  }));

  // -------------------------------------------------------------- mission
  router.get("/mission", asyncRoute(async (_req, res) => {
    await mission.init();
    ok(res, { primary: mission.primary(), secondary: mission.secondary(), versions: mission.versions("secondary"), proposals: pendingProposals(governance, "mission") });
  }));
  router.post("/mission/secondary", asyncRoute(async (req, res) => {
    await mission.init();
    const rec = await mission.applyDirect("secondary", { text: req.body?.text, rationale: req.body?.rationale });
    emit("mission.updated", { kind: "secondary", version: rec.version });
    ok(res, rec);
  }));
  router.post("/mission/primary", asyncRoute(async (req, res) => {
    await mission.init();
    const rec = await mission.applyDirect("primary", { text: req.body?.text, rationale: req.body?.rationale, actor: req.body?.actor ?? "operator" });
    emit("mission.updated", { kind: "primary", version: rec.version });
    ok(res, rec);
  }));
  router.post("/mission/proposals", asyncRoute(async (req, res) => {
    await mission.init();
    const rec = await mission.proposeChange("secondary", { text: req.body?.text, rationale: req.body?.rationale });
    emit("mission.proposed", { proposalId: rec.proposalId });
    ok(res, rec);
  }));
  router.post("/mission/proposals/:proposalId/approve", asyncRoute(async (req, res) => {
    await mission.init();
    const rec = await mission.approveProposal(req.params.proposalId, { reviewCycleId: req.body?.reviewCycleId });
    emit("mission.updated", { kind: "secondary", version: rec.version, fromProposal: req.params.proposalId });
    ok(res, rec);
  }));
  router.post("/mission/proposals/:proposalId/reject", asyncRoute(async (req, res) => {
    const rec = await mission.rejectProposal(req.params.proposalId, { reason: req.body?.reason });
    emit("mission.proposal-rejected", { proposalId: rec.proposalId });
    ok(res, rec);
  }));

  // ------------------------------------------------------------- strategy
  router.get("/strategy", asyncRoute(async (_req, res) => {
    await strategy.init();
    ok(res, { active: strategy.active(), versions: strategy.versions(), proposals: pendingProposals(governance, "strategy") });
  }));
  router.post("/strategy", asyncRoute(async (req, res) => {
    await strategy.init();
    const rec = await strategy.applyDirect({ strategy: req.body?.strategy, rationale: req.body?.rationale });
    emit("strategy.updated", { version: rec.version });
    ok(res, rec);
  }));
  router.post("/strategy/proposals", asyncRoute(async (req, res) => {
    await strategy.init();
    const rec = await strategy.proposeChange({ strategy: req.body?.strategy, rationale: req.body?.rationale });
    emit("strategy.proposed", { proposalId: rec.proposalId });
    ok(res, rec);
  }));
  router.post("/strategy/proposals/:proposalId/approve", asyncRoute(async (req, res) => {
    await strategy.init();
    const rec = await strategy.approveProposal(req.params.proposalId, { reviewCycleId: req.body?.reviewCycleId });
    emit("strategy.updated", { version: rec.version, fromProposal: req.params.proposalId });
    ok(res, rec);
  }));
  router.post("/strategy/proposals/:proposalId/reject", asyncRoute(async (req, res) => {
    const rec = await strategy.rejectProposal(req.params.proposalId, { reason: req.body?.reason });
    emit("strategy.proposal-rejected", { proposalId: rec.proposalId });
    ok(res, rec);
  }));

  // -------------------------------------------------------- review cycles
  router.get("/review-cycles", asyncRoute(async (_req, res) => {
    const stats = store.getStats();
    await reviewCycles.ensureForConsumption(stats.uniqueConsumed);
    ok(res, { interval: reviewCycles.interval(), cycles: reviewCycles.list(), uniqueConsumed: stats.uniqueConsumed });
  }));
  router.post("/review-cycles/ensure", asyncRoute(async (req, res) => {
    const uniqueConsumed = Number(req.body?.uniqueConsumed ?? store.getStats().uniqueConsumed);
    const rec = await reviewCycles.ensureForConsumption(uniqueConsumed);
    if (rec) emit("review-cycle.opened", { reviewCycleId: rec.reviewCycleId });
    ok(res, { cycle: rec });
  }));
  router.post("/review-cycles/:reviewCycleId/close", asyncRoute(async (req, res) => {
    const rec = await reviewCycles.close(req.params.reviewCycleId, { notes: req.body?.notes, proposalIds: req.body?.proposalIds });
    emit("review-cycle.closed", { reviewCycleId: req.params.reviewCycleId });
    ok(res, rec);
  }));

  // ---------------------------------------------------- training history
  router.get("/training-history", asyncRoute(async (_req, res) => {
    const py = readPythonStore(pythonStorePath);
    const runs = registry.listRuns();
    const models = registry.listModels();
    const checkpointVersions = new Set(
      models
        .map((m) => m.checkpointPath)
        .filter(Boolean)
        .map((p) => path.basename(path.dirname(p))),
    );
    const pyVersions = new Set(py.versions.map((v) => v.version));
    const discrepancies = [];
    if (!py.available) discrepancies.push({ kind: "python-store-unavailable", detail: py.reason });
    else {
      for (const v of pyVersions) if (!checkpointVersions.has(v)) discrepancies.push({ kind: "python-version-not-in-registry", version: v });
      for (const v of checkpointVersions) if (!pyVersions.has(v)) discrepancies.push({ kind: "registry-version-not-in-python-store", version: v });
    }
    ok(res, {
      registry: {
        runs: runs.map(toRun),
        models,
        evaluations: registry.listEvaluations(),
        activeModel: registry.getActiveModel(),
      },
      pythonStore: py,
      discrepancies,
    });
  }));

  // ------------------------------------------------------------------ SSE
  router.get("/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const since = Number(req.query.since ?? 0) || 0;
    const { gap, events } = changeFeed.replay(since);
    res.write(`event: hello\ndata: ${JSON.stringify({ gap, currentSeq: changeFeed.currentSeq() })}\n\n`);
    if (gap) res.write(`event: resync\ndata: {"reason":"missed-window"}\n\n`);
    for (const e of events) res.write(`event: change\ndata: ${JSON.stringify(e)}\n\n`);
    const unsubscribe = changeFeed.subscribe((e) => res.write(`event: change\ndata: ${JSON.stringify(e)}\n\n`));
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.use("/api/admin", router);
  app.use("/admin", express.static(path.join(__dirname, "public")));
  app.get("/admin/*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

  logger.log?.(`admin portal mounted at /admin (api: /api/admin)`);
  return { router, mission, strategy, reviewCycles, changeFeed };
}

/**
 * Proposals are an append-only log of decisions; a proposal is one logical
 * record whose current status is the last line that mentions its id. Project
 * before filtering, or an approved proposal would still appear pending.
 */
function projectProposals(governance) {
  const byId = new Map();
  for (const rec of governance.list("proposals")) {
    byId.set(rec.proposalId, { ...(byId.get(rec.proposalId) ?? {}), ...rec });
  }
  return [...byId.values()];
}

function pendingProposals(governance, target) {
  return projectProposals(governance).filter((p) => p.target === target && p.status === "pending");
}

function toRun(r) {
  const baselineLoss = r.baselineEvaluation?.loss;
  const trainedLoss = r.trainedEvaluation?.loss;
  const lossDelta = Number.isFinite(baselineLoss) && Number.isFinite(trainedLoss) ? baselineLoss - trainedLoss : null;
  return {
    runId: r.runId,
    status: r.status,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    baseModel: r.baseModel,
    resultModelId: r.resultModelId,
    datasetId: r.datasetId,
    datasetVersion: r.datasetVersion,
    recordCount: r.recordCount,
    trainerKind: r.trainerKind,
    examplesProcessed: r.examplesProcessed,
    baselineScore: r.baselineEvaluation?.score100 ?? r.baselineEvaluation?.score,
    trainedScore: r.trainedEvaluation?.score100 ?? r.trainedEvaluation?.score,
    // Loss gate (authoritative for the real brain) — surfaced for the Observatory.
    baselineLoss: Number.isFinite(r.baselineEvaluation?.loss) ? r.baselineEvaluation.loss : null,
    trainedLoss: Number.isFinite(r.trainedEvaluation?.loss) ? r.trainedEvaluation.loss : null,
    lossDelta: Number.isFinite(r.baselineEvaluation?.loss) && Number.isFinite(r.trainedEvaluation?.loss)
      ? r.baselineEvaluation.loss - r.trainedEvaluation.loss
      : null,
    evaluationDelta: r.evaluationDelta,
    promotionStatus: r.promotionStatus,
    activatedVersion: r.activatedVersion ?? null,
    tokensSeen: r.trainedEvaluation?.tokensSeen ?? r.runLinkage?.tokensSeen ?? null,
    datasetHash: r.runLinkage?.datasetHash ?? null,
    pythonVersion: r.runLinkage?.pythonVersion ?? r.baseModelVersion ?? null,
    parentVersion: r.runLinkage?.parentVersion ?? null,
    // Full Node->Python lineage; checkpoint path/version is a secondary check.
    runLinkage: r.runLinkage ?? null,
  };
}
