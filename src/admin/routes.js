import express from "express";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changeFeed as defaultFeed } from "./change-feed.js";
import { readPythonStore, readPythonTrainState } from "./python-store.js";
import { createWorkspaceRegistry } from "./workspace.js";
import { probeTeacher } from "./teacher.js";
import {
  bestCheckpoint,
  classifyTrend,
  deriveSeries,
  downsample,
  mergeChain,
  selectEffectiveVersion,
} from "./metrics.js";
import { config } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Admin portal backend — REST + SSE mounted onto the EXISTING server.
 *
 * Every mutation goes through a validated Node service (ArticleStore,
 * governance services) and then emits a change-feed event. The browser NEVER
 * writes files and NEVER reads them directly; it only calls these endpoints.
 * SSE carries live deltas; the REST `/overview` is the authoritative snapshot a
 * client re-reads whenever it reconnects or is told to resync.
 *
 * Workspaces: the portal is bound to ONE live, writable store (`development`,
 * the process store). Extra workspaces are allow-listed in config and opened
 * READ-ONLY; a request selects one with `?workspace=<id>` (or the
 * `x-sma-workspace` header). Inspection-only workspaces refuse every mutation
 * with 403 and never run seeding writes on read endpoints.
 */
export function attachAdmin({ app, store, registry, governance, chat, changeFeed = defaultFeed, pythonStorePath = null, workspaces = [], supervisor = null, logger = console }) {
  const workspaceRegistry = createWorkspaceRegistry({ store, registry, governance, chat, pythonStorePath, workspaces });

  const router = express.Router();
  router.use(express.json({ limit: "2mb" }));

  const ok = (res, data) => res.json(data ?? { ok: true });
  const fail = (res, err, code = err?.statusCode ?? 400) => res.status(code).json({ error: err?.message ?? String(err) });

  const asyncRoute = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => fail(res, err));

  const emit = (type, data) => changeFeed.emit(type, data);

  // Long-running lifecycle work (learning/training/fresh-brain) is owned by a
  // single supervisor bound to the live writable development store. Inspection
  // workspaces can read job history but never start or stop work.
  const requireSupervisor = (res) => {
    if (!supervisor) {
      res.status(503).json({ error: "job supervisor is not available in this deployment" });
      return null;
    }
    return supervisor;
  };

  const identity = (w, py) => ({
    id: w.id,
    label: w.label,
    kind: w.kind,
    readOnly: w.readOnly,
    root: py?.root ?? w.paths?.pythonStore ?? null,
    activeVersion: py?.activeVersion ?? null,
  });

  // -------------------------------------------------------- workspace list
  // Registered BEFORE the resolver so the catalogue is itself workspace-free.
  router.get("/workspaces", asyncRoute(async (_req, res) => {
    ok(res, { default: workspaceRegistry.defaultId, workspaces: workspaceRegistry.list() });
  }));

  // Resolve the selected workspace for every other route. Default keeps the
  // existing single-store behaviour: `development`.
  router.use((req, res, next) => {
    const id = String(req.query.workspace ?? req.get("x-sma-workspace") ?? workspaceRegistry.defaultId);
    workspaceRegistry.get(id)
      .then((w) => { req.workspace = w; next(); })
      .catch((err) => fail(res, err));
  });

  // A mutation attempted against an inspection-only workspace is refused with a
  // clear reason — never silently routed to the development store.
  const blockWrites = (req, res, next) => {
    if (req.workspace?.readOnly) {
      return res.status(403).json({ error: `workspace '${req.workspace.id}' is inspection-only; this action is disabled` });
    }
    next();
  };

  // ------------------------------------------------------------- overview
  router.get("/overview", asyncRoute(async (req, res) => {
    const w = req.workspace;
    // Seeding is a write: only the development workspace may do it. An
    // inspection view reports whatever the store actually contains.
    if (!w.readOnly) {
      await w.mission.init();
      await w.strategy.init();
    }
    const stats = w.services.store.getStats();
    const py = readPythonStore(w.pythonStorePath);
    const activeModel = w.services.registry.getActiveModel();
    const cycles = w.reviewCycles.list();
    if (!w.readOnly) await w.reviewCycles.ensureForConsumption(stats.uniqueConsumed);
    ok(res, {
      generatedAt: new Date().toISOString(),
      workspace: identity(w, py),
      articles: stats,
      legacy: w.services.store.legacyInfo(),
      pythonStore: py,
      registry: {
        activeModel: activeModel
          ? { modelId: activeModel.modelId, status: activeModel.status, createdAt: activeModel.createdAt }
          : null,
        runCount: w.services.registry.listRuns().length,
        snapshotCount: w.services.registry.listSnapshots().length,
        evaluationCount: w.services.registry.listEvaluations().length,
      },
      mission: { primary: w.mission.primary(), secondary: w.mission.secondary() },
      strategy: w.strategy.active(),
      reviewCycles: cycles,
      currentReviewCycle: w.reviewCycles.current(),
      reviewInterval: w.reviewCycles.interval(),
      changeSeq: changeFeed.currentSeq(),
    });
  }));

  // ------------------------------------------------------------- articles
  router.get("/articles", asyncRoute(async (req, res) => {
    const { after = null, limit = 50, status, importance, consumed, domain } = req.query;
    ok(res, req.workspace.services.store.articlesPage({
      after,
      limit: Number(limit) || 50,
      status: status || undefined,
      importance: importance || undefined,
      consumed: consumed === undefined ? undefined : consumed === "true",
      domain: domain || undefined,
    }));
  }));

  router.get("/articles/:articleId", asyncRoute(async (req, res) => {
    const s = req.workspace.services.store;
    const a = s.getArticle(req.params.articleId);
    if (!a) return fail(res, new Error("unknown article"), 404);
    ok(res, { ...a, reviews: s.reviewsFor(a.articleId), events: s.events.filter((e) => e.articleId === a.articleId) });
  }));

  router.post("/articles/select-for-review", blockWrites, asyncRoute(async (req, res) => {
    const ids = await req.workspace.services.store.selectForReview({ limit: Number(req.body?.limit) || 500 });
    emit("articles.selected", { count: ids.length });
    ok(res, { selected: ids });
  }));

  router.post("/articles/:articleId/importance", blockWrites, asyncRoute(async (req, res) => {
    const a = await req.workspace.services.store.setImportance(req.params.articleId, req.body?.importance);
    emit("article.updated", { articleId: a.articleId, field: "importance", value: a.importance });
    ok(res, a);
  }));

  router.post("/articles/:articleId/status", blockWrites, asyncRoute(async (req, res) => {
    const a = await req.workspace.services.store.setStatus(req.params.articleId, req.body?.status, { reason: req.body?.reason ?? null });
    emit("articles.status", { articleId: a.articleId, status: a.status });
    ok(res, a);
  }));

  router.post("/articles/:articleId/request-review", blockWrites, asyncRoute(async (req, res) => {
    const a = await req.workspace.services.store.requestReview(req.params.articleId, { reason: req.body?.reason ?? null });
    emit("articles.review-requested", { articleId: a.articleId });
    ok(res, a);
  }));

  router.post("/articles/:articleId/review", blockWrites, asyncRoute(async (req, res) => {
    const b = req.body ?? {};
    const result = await req.workspace.services.store.recordReview({
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
  router.get("/chat/identity", asyncRoute(async (req, res) => ok(res, req.workspace.services.chat.identity())));
  router.post("/chat", blockWrites, asyncRoute(async (req, res) => {
    const message = String(req.body?.message ?? "").trim();
    if (!message) return fail(res, new Error("message required"));
    try {
      const out = await req.workspace.services.chat.respond(message);
      emit("chat.message", { at: out.at ?? new Date().toISOString() });
      ok(res, out);
    } catch (err) {
      fail(res, err, req.workspace.services.chat.isUnavailable(err) ? 503 : 502);
    }
  }));

  // -------------------------------------------------------------- mission
  router.get("/mission", asyncRoute(async (req, res) => {
    const w = req.workspace;
    if (!w.readOnly) await w.mission.init();
    ok(res, { primary: w.mission.primary(), secondary: w.mission.secondary(), versions: w.mission.versions("secondary"), proposals: pendingProposals(w.services.governance, "mission") });
  }));
  router.post("/mission/secondary", blockWrites, asyncRoute(async (req, res) => {
    await req.workspace.mission.init();
    const rec = await req.workspace.mission.applyDirect("secondary", { text: req.body?.text, rationale: req.body?.rationale });
    emit("mission.updated", { kind: "secondary", version: rec.version });
    ok(res, rec);
  }));
  router.post("/mission/primary", blockWrites, asyncRoute(async (req, res) => {
    await req.workspace.mission.init();
    const rec = await req.workspace.mission.applyDirect("primary", { text: req.body?.text, rationale: req.body?.rationale, actor: req.body?.actor ?? "operator" });
    emit("mission.updated", { kind: "primary", version: rec.version });
    ok(res, rec);
  }));
  router.post("/mission/proposals", blockWrites, asyncRoute(async (req, res) => {
    await req.workspace.mission.init();
    const rec = await req.workspace.mission.proposeChange("secondary", { text: req.body?.text, rationale: req.body?.rationale });
    emit("mission.proposed", { proposalId: rec.proposalId });
    ok(res, rec);
  }));
  router.post("/mission/proposals/:proposalId/approve", blockWrites, asyncRoute(async (req, res) => {
    await req.workspace.mission.init();
    const rec = await req.workspace.mission.approveProposal(req.params.proposalId, { reviewCycleId: req.body?.reviewCycleId });
    emit("mission.updated", { kind: "secondary", version: rec.version, fromProposal: req.params.proposalId });
    ok(res, rec);
  }));
  router.post("/mission/proposals/:proposalId/reject", blockWrites, asyncRoute(async (req, res) => {
    const rec = await req.workspace.mission.rejectProposal(req.params.proposalId, { reason: req.body?.reason });
    emit("mission.proposal-rejected", { proposalId: rec.proposalId });
    ok(res, rec);
  }));

  // ------------------------------------------------------------- strategy
  router.get("/strategy", asyncRoute(async (req, res) => {
    const w = req.workspace;
    if (!w.readOnly) await w.strategy.init();
    ok(res, { active: w.strategy.active(), versions: w.strategy.versions(), proposals: pendingProposals(w.services.governance, "strategy") });
  }));
  router.post("/strategy", blockWrites, asyncRoute(async (req, res) => {
    await req.workspace.strategy.init();
    const rec = await req.workspace.strategy.applyDirect({ strategy: req.body?.strategy, rationale: req.body?.rationale });
    emit("strategy.updated", { version: rec.version });
    ok(res, rec);
  }));
  router.post("/strategy/proposals", blockWrites, asyncRoute(async (req, res) => {
    await req.workspace.strategy.init();
    const rec = await req.workspace.strategy.proposeChange({ strategy: req.body?.strategy, rationale: req.body?.rationale });
    emit("strategy.proposed", { proposalId: rec.proposalId });
    ok(res, rec);
  }));
  router.post("/strategy/proposals/:proposalId/approve", blockWrites, asyncRoute(async (req, res) => {
    await req.workspace.strategy.init();
    const rec = await req.workspace.strategy.approveProposal(req.params.proposalId, { reviewCycleId: req.body?.reviewCycleId });
    emit("strategy.updated", { version: rec.version, fromProposal: req.params.proposalId });
    ok(res, rec);
  }));
  router.post("/strategy/proposals/:proposalId/reject", blockWrites, asyncRoute(async (req, res) => {
    const rec = await req.workspace.strategy.rejectProposal(req.params.proposalId, { reason: req.body?.reason });
    emit("strategy.proposal-rejected", { proposalId: rec.proposalId });
    ok(res, rec);
  }));

  // -------------------------------------------------------- review cycles
  router.get("/review-cycles", asyncRoute(async (req, res) => {
    const w = req.workspace;
    const stats = w.services.store.getStats();
    if (!w.readOnly) await w.reviewCycles.ensureForConsumption(stats.uniqueConsumed);
    ok(res, { interval: w.reviewCycles.interval(), cycles: w.reviewCycles.list(), uniqueConsumed: stats.uniqueConsumed });
  }));
  router.post("/review-cycles/ensure", blockWrites, asyncRoute(async (req, res) => {
    const w = req.workspace;
    const uniqueConsumed = Number(req.body?.uniqueConsumed ?? w.services.store.getStats().uniqueConsumed);
    const rec = await w.reviewCycles.ensureForConsumption(uniqueConsumed);
    if (rec) emit("review-cycle.opened", { reviewCycleId: rec.reviewCycleId });
    ok(res, { cycle: rec });
  }));
  router.post("/review-cycles/:reviewCycleId/close", blockWrites, asyncRoute(async (req, res) => {
    const rec = await req.workspace.reviewCycles.close(req.params.reviewCycleId, { notes: req.body?.notes, proposalIds: req.body?.proposalIds });
    emit("review-cycle.closed", { reviewCycleId: req.params.reviewCycleId });
    ok(res, rec);
  }));

  // --------------------------------------------------------- trends & metrics
  // Effective version resolution: explicit ?version= wins, else the active
  // committed version, else the latest committed trainable version. Only the
  // selected version's own lineage is read in full (versions sharing its
  // packing dataset hash), so the endpoint stays cheap on multi-version stores.
  router.get("/metrics", asyncRoute(async (req, res) => {
    const w = req.workspace;
    const py = readPythonStore(w.pythonStorePath);
    const requested = req.query.version ? String(req.query.version) : null;
    if (!py.available) {
      ok(res, { workspace: identity(w, py), available: false, reason: py.reason ?? "python store unavailable", segments: [], markers: [] });
      return;
    }
    if (py.versions.length === 0) {
      ok(res, { workspace: identity(w, py), available: true, reason: "no committed versions yet", segments: [], markers: [] });
      return;
    }
    const sel = selectEffectiveVersion(py.versions, { requested, active: py.active, allowNotFound: true });
    if (!sel) return fail(res, new Error(`unknown version: ${requested}`), 404);
    const selected = py.versions.find((v) => v.version === sel.effective);
    const thresholds = config.trend;
    const maxPoints = 1000;

    const chainHash = selected?.trainState?.datasetHash ?? null;
    const lineage = py.versions.filter(
      (v) => v.committed && v.trainState?.datasetHash === chainHash,
    );
    const segments = lineage.map((v) => ({
      version: v.version,
      committedAt: v.committedAt ?? null,
      ...deriveSeries(readPythonTrainState(v.version, w.pythonStorePath) ?? null),
    }));

    const validationChain = mergeChain(
      segments.map((s) => ({ version: s.version, series: s.validationSeries })),
      maxPoints,
    );
    const trainingChain = mergeChain(
      segments.map((s) => ({ version: s.version, series: s.trainingSeries })),
      maxPoints,
    );

    // Markers: frozen eval-set benchmark records of artifacts in this lineage.
    // Join runs to their durable candidate model (runLinkage is not persisted
    // on the immutable run line), so a restarted process still shows the
    // promotion point and its frozen-set loss.
    const modelsByRun = new Map(
      w.services.registry.listModels().filter((m) => m.trainingRunId).map((m) => [m.trainingRunId, m]),
    );
    const markers = [];
    for (const r of w.services.registry.listRuns()) {
      const cand = modelsByRun.get(r.runId) ?? null;
      const version = r.runLinkage?.pythonVersion ?? cand?.meta?.pythonVersion ?? null;
      if (!version || !lineage.some((v) => v.version === version)) continue;
      const loss = Number.isFinite(r.trainedEvaluation?.loss)
        ? r.trainedEvaluation.loss
        : (Number.isFinite(cand?.evaluationScore) ? cand.evaluationScore : NaN);
      if (!Number.isFinite(loss)) continue;
      markers.push({
        runId: r.runId,
        version,
        loss: Number(loss),
        status: r.status,
        promotionStatus: r.promotionStatus ?? cand?.status ?? null,
        activatedVersion: r.activatedVersion ?? (cand?.status === "promoted" ? cand.meta.pythonVersion : null),
        trainedAt: r.completedAt ?? r.startedAt ?? null,
        datasetHash: r.runLinkage?.datasetHash ?? cand?.meta?.datasetHash ?? null,
        tokensSeen: r.trainedEvaluation?.tokensSeen ?? cand?.meta?.tokensSeen ?? null,
      });
    }

    const training = segments.map((s) => ({
      version: s.version,
      points: downsample(s.trainingSeries, maxPoints),
    }));

    ok(res, {
      workspace: identity(w, py),
      available: true,
      generatedAt: new Date().toISOString(),
      storePath: py.root,
      requestedVersion: sel.requested,
      effectiveVersion: sel.effective,
      isDefaultVersion: sel.default,
      thresholds,
      datasetHash: chainHash,
      segments: segments.map((s) => ({
        version: s.version,
        committedAt: s.committedAt,
        stepsCompleted: s.stepsCompleted,
        resumedFromStep: s.resumedFromStep,
        evalEvery: s.evalEvery,
        sampling: s.sampling,
        initialValidationLoss: s.initialValidationLoss,
        finalValidationLoss: s.finalValidationLoss,
      })),
      chain: {
        points: validationChain.points,
        fromStep: validationChain.from,
        toStep: validationChain.to,
      },
      training,
      markers,
      best: bestCheckpoint(
        segments
          .map((s) => {
            const ts = readPythonTrainState(s.version, w.pythonStorePath) ?? {};
            return {
              version: s.version,
              loss: s.finalValidationLoss,
              datasetHash: ts?.packing?.datasetHash ?? null,
              stepsCompleted: s.stepsCompleted,
            };
          })
          .concat(markers.map((m) => ({ version: m.version, loss: m.loss, datasetHash: m.datasetHash, runId: m.runId, source: "frozen-eval-set" }))),
      ),
      trend: classifyTrend(validationChain.points, trainingChain.points, thresholds),
    });
  }));

  // ---------------------------------------------------- training history
  router.get("/training-history", asyncRoute(async (req, res) => {
    const w = req.workspace;
    const py = readPythonStore(w.pythonStorePath);
    const runs = w.services.registry.listRuns();
    const models = w.services.registry.listModels();
    // Durable join: the run completion patch is intentionally NOT written back
    // to runs.ndjson (the registration line is immutable; terminal state lives
    // in run-events). The promotion decision and frozen-set score are durably
    // recorded on the candidate model + its model-event, so join through it to
    // keep the view truthful after a restart.
    const modelsByRun = new Map(models.filter((m) => m.trainingRunId).map((m) => [m.trainingRunId, m]));
    // A registry model's `checkpointPath` points at the version DIRECTORY
    // (e.g. ...\store\v004), so the version name is basename(checkpointPath),
    // not basename(dirname(...)) — the latter yields the store dir ("store")
    // and produced false discrepancy warnings. Prefer the explicit
    // `meta.pythonVersion` when present.
    const checkpointVersions = new Set(
      models
        .map((m) => m.meta?.pythonVersion ?? (m.checkpointPath ? path.basename(m.checkpointPath) : null))
        .filter(Boolean),
    );
    const pyVersions = new Set(py.versions.map((v) => v.version));
    const discrepancies = [];
    if (!py.available) discrepancies.push({ kind: "python-store-unavailable", detail: py.reason });
    else {
      for (const v of pyVersions) if (!checkpointVersions.has(v)) discrepancies.push({ kind: "python-version-not-in-registry", version: v });
      for (const v of checkpointVersions) if (!pyVersions.has(v)) discrepancies.push({ kind: "registry-version-not-in-python-store", version: v });
    }
    ok(res, {
      workspace: identity(w, py),
      registry: {
        runs: runs.map((r) => toRun(r, modelsByRun.get(r.runId) ?? null)),
        models,
        evaluations: w.services.registry.listEvaluations(),
        activeModel: w.services.registry.getActiveModel(),
      },
      pythonStore: py,
      evaluationSet: evaluationSetSummary(w),
      discrepancies,
    });
  }));

  // ------------------------------------------------------------ jobs / learning
  router.get("/jobs", asyncRoute(async (_req, res) => {
    const sup = requireSupervisor(res);
    if (!sup) return;
    ok(res, { jobs: sup.listJobs() });
  }));

  router.get("/jobs/:jobId", asyncRoute(async (req, res) => {
    const sup = requireSupervisor(res);
    if (!sup) return;
    const job = sup.getJob(req.params.jobId);
    if (!job) return fail(res, new Error(`unknown job ${req.params.jobId}`), 404);
    ok(res, { job, log: sup.getLog(req.params.jobId, { limit: 200 }) });
  }));

  router.get("/jobs/:jobId/log", asyncRoute(async (req, res) => {
    const sup = requireSupervisor(res);
    if (!sup) return;
    ok(res, { jobId: req.params.jobId, log: sup.getLog(req.params.jobId, { after: req.query.after ?? null, limit: Number(req.query.limit) || 500 }) });
  }));

  router.post("/jobs/:jobId/stop", blockWrites, asyncRoute(async (req, res) => {
    const sup = requireSupervisor(res);
    if (!sup) return;
    const job = await sup.stop(req.params.jobId);
    emit("job.status", { jobId: job.jobId, status: job.status });
    ok(res, { job });
  }));

  router.post("/learning/start", blockWrites, asyncRoute(async (req, res) => {
    const sup = requireSupervisor(res);
    if (!sup) return;
    const job = await sup.startLearning({
      mode: req.body?.mode,
      targetArticles: req.body?.targetArticles,
      maxRawDocs: req.body?.maxRawDocs,
      maxCycles: req.body?.maxCycles,
    });
    ok(res, { job });
  }));

  router.post("/learning/stop", blockWrites, asyncRoute(async (req, res) => {
    const sup = requireSupervisor(res);
    if (!sup) return;
    const active = sup.activeJobOfKind("learning");
    if (!active) return ok(res, { job: null, note: "no active learning job" });
    const job = await sup.stop(active.jobId);
    ok(res, { job });
  }));

  router.post("/training/start", blockWrites, asyncRoute(async (req, res) => {
    const sup = requireSupervisor(res);
    if (!sup) return;
    const job = await sup.startTraining({
      mode: req.body?.mode,
      parentVersion: req.body?.parentVersion ?? null,
      minEligible: req.body?.minEligible,
    });
    ok(res, { job });
  }));

  router.post("/training/stop", blockWrites, asyncRoute(async (req, res) => {
    const sup = requireSupervisor(res);
    if (!sup) return;
    const active = sup.activeJobOfKind("training");
    if (!active) return ok(res, { job: null, note: "no active training job" });
    const job = await sup.stop(active.jobId);
    ok(res, { job });
  }));

  router.get("/training/eligibility", asyncRoute(async (req, res) => {
    const stats = req.workspace.services.store.getStats();
    const minEligible = Number(req.query.minEligible) || config.jobs.training.minEligible;
    ok(res, {
      workspace: req.workspace.id,
      trainable: stats.trainable,
      minEligible,
      eligible: stats.trainable >= minEligible,
    });
  }));

  router.post("/brain/fresh", blockWrites, asyncRoute(async (req, res) => {
    const sup = requireSupervisor(res);
    if (!sup) return;
    const job = await sup.freshBrain({
      confirm: req.body?.confirm === true,
      config: req.body?.config,
      seed: req.body?.seed,
    });
    ok(res, { job });
  }));

  // ------------------------------------------------- teacher + brain versions
  router.get("/teacher", asyncRoute(async (_req, res) => {
    const result = await probeTeacher({
      endpoint: config.ollamaEndpoint,
      model: config.ollamaModel,
      expectedDigest: config.ollamaModelDigest,
      fixture: config.ollamaFixture,
      timeoutMs: config.ollamaReadinessTimeoutMs,
    });
    ok(res, result);
  }));

  router.get("/brain/versions", asyncRoute(async (req, res) => {
    const w = req.workspace;
    const py = readPythonStore(w.pythonStorePath);
    ok(res, {
      workspace: identity(w, py),
      available: py.available,
      reason: py.reason ?? null,
      activeVersion: py.activeVersion ?? null,
      versions: (py.versions ?? []).map((v) => ({
        version: v.version,
        committed: Boolean(v.committed),
        committedAt: v.committedAt ?? null,
        artifactName: v.artifactName ?? null,
        artifactNameError: v.artifactNameError ?? null,
        parentVersion: v.trainState?.parentVersion ?? null,
        stepsCompleted: v.trainState?.stepsCompleted ?? null,
        initialValidationLoss: v.initialValidationLoss ?? null,
        finalValidationLoss: v.finalValidationLoss ?? null,
      })),
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
  return { router, workspaceRegistry, changeFeed, supervisor };
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

/** Read-only, best-effort summary of the frozen evaluation set on disk. */
function evaluationSetSummary(w) {
  const dir = w.paths?.evaluation ?? (w.kind === "development" ? config.paths.evaluation : null);
  if (!dir || !existsSync(dir)) return null;
  try {
    const files = readdirSync(dir)
      .filter((f) => statSync(path.join(dir, f)).isFile())
      .sort()
      .map((f) => {
        const buf = readFileSync(path.join(dir, f));
        return { file: f, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
      });
    return { dir, files };
  } catch {
    return null;
  }
}

function toRun(r, candidate = null) {
  const meta = candidate?.meta ?? {};
  const runLink = r.runLinkage ?? null;
  const baselineLoss = Number.isFinite(r.baselineEvaluation?.loss) ? r.baselineEvaluation.loss : null;
  const candidateLoss = Number.isFinite(r.trainedEvaluation?.loss) ? r.trainedEvaluation.loss : null;
  const trainedLoss = candidateLoss ?? (Number.isFinite(candidate?.evaluationScore) ? candidate.evaluationScore : null);
  const pythonVersion = runLink?.pythonVersion ?? meta.pythonVersion ?? r.baseModelVersion ?? null;
  const parentVersion = runLink?.parentVersion ?? meta.parentVersion ?? null;
  const promotionStatus = r.promotionStatus ?? candidate?.status ?? null;
  return {
    runId: r.runId,
    status: r.status,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    baseModel: r.baseModel,
    resultModelId: r.resultModelId ?? candidate?.modelId ?? null,
    datasetId: r.datasetId,
    datasetVersion: r.datasetVersion,
    recordCount: r.recordCount,
    trainerKind: r.trainerKind,
    examplesProcessed: r.examplesProcessed,
    baselineScore: r.baselineEvaluation?.score100 ?? r.baselineEvaluation?.score,
    trainedScore: r.trainedEvaluation?.score100 ?? r.trainedEvaluation?.score,
    // Loss gate (authoritative for the real brain) — surfaced for the Observatory.
    baselineLoss,
    trainedLoss,
    lossDelta: baselineLoss != null && trainedLoss != null ? baselineLoss - trainedLoss : null,
    evaluationDelta: r.evaluationDelta,
    promotionStatus,
    activatedVersion: r.activatedVersion ?? (candidate?.status === "promoted" ? meta.pythonVersion ?? null : null),
    tokensSeen: r.trainedEvaluation?.tokensSeen ?? runLink?.tokensSeen ?? meta.tokensSeen ?? null,
    datasetHash: runLink?.datasetHash ?? meta.datasetHash ?? null,
    pythonVersion,
    parentVersion,
    // Full Node->Python lineage; checkpoint path/version is a secondary check.
    runLinkage: runLink,
    // Durable candidate lineage, surfaced even when the run record predates the
    // in-memory completion patch. `note` is the registry's recorded promotion
    // rationale (includes the frozen-set baseline loss).
    candidate: candidate
      ? {
          modelId: candidate.modelId,
          status: candidate.status,
          evaluationScore: candidate.evaluationScore ?? null,
          checkpointPath: candidate.checkpointPath ?? null,
          parentModelId: candidate.parentModelId ?? null,
          datasetId: candidate.datasetId ?? null,
          avgTrainLoss: meta.avgLoss ?? null,
          datasetHash: meta.datasetHash ?? null,
          tokensSeen: meta.tokensSeen ?? null,
          pythonVersion: meta.pythonVersion ?? null,
          parentVersion: meta.parentVersion ?? null,
          adopted: meta.adopted ?? null,
          createdAt: candidate.createdAt ?? null,
          note: candidate.note ?? null,
          at: candidate.at ?? null,
        }
      : null,
  };
}
