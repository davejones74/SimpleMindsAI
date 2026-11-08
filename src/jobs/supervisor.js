import { JobStore, JOB_STATUS, isTerminal, validateTransition } from "./job-store.js";
import { runLearningCycle } from "./learning.js";
import { runTrainingOnce } from "./training.js";
import { createFreshBrain } from "./fresh-brain.js";
import { reviewPendingArticles } from "./review-pass.js";
import { selectTrainer } from "../training/trainer-interface.js";
import { runPython } from "../brain/python-cli.js";
import { OllamaClient } from "../services/ollama-client.js";
import { ReviewScorer } from "../reward/reward-scorer.js";
import { config } from "../config.js";
import { abortError, isAbort } from "./cancel.js";
import { ACQUISITION_STATE, backoffDeadline } from "../discovery/acquisition-state.js";
import { TrainingTelemetry } from "../telemetry/training-telemetry.js";

export class JobConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "JobConflictError";
    this.statusCode = 409;
  }
}

export class JobNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "JobNotFoundError";
    this.statusCode = 404;
  }
}

const KIND_TITLES = { learning: "Learning", training: "Training", "fresh-brain": "Fresh brain", review: "Review backlog" };

/**
 * Connectivity failures — a loss of internet, an unreachable teacher or source,
 * or a timeout. These are TRANSIENT. A CONTINUOUS learning/training job logs the
 * failure and keeps running (retrying on the normal poll interval) instead of
 * pausing or recording "source exhausted" (which would be a lie: the sources are
 * fine, we simply could not reach them). A one-shot job keeps the historical
 * pause-and-retry-on-resume behaviour. HTTP status errors (FETCH_STATUS:
 * 404/500) and content-type refusals are NOT transient and keep their existing
 * fail-closed behaviour.
 */
const NETWORK_FAILURE_RE =
  /^(fetch_network|fetch_timeout|fetch_dns|econnrefused|econnreset|enotfound|eai_again|etimedout|ehostunreach|enetunreach|epipe|und_err_connect_timeout|und_err_headers_timeout|und_err_socket)$/i;

function isNetworkFailure(failure) {
  const reason = String(failure?.reason ?? "").toLowerCase();
  if (!reason) return false;
  if (NETWORK_FAILURE_RE.test(reason)) return true;
  return /network|getaddrinfo|socket hang up|offline|connection refused|timed out/.test(reason);
}

function isNetworkError(err) {
  if (!err) return false;
  return isNetworkFailure({ reason: err.code }) || isNetworkFailure({ reason: err.message });
}

/**
 * Errors that mean "there is not enough (or not the right composition of)
 * trainable material right now" rather than "training is broken". A CONTINUOUS
 * training job waits and retries these indefinitely; a one-shot job surfaces
 * them as a clear terminal failure. `INSUFFICIENT_CORPUS` is raised by the
 * Python corpus preflight (the snapshot is shorter than one block),
 * `INSUFFICIENT_VALIDATION` by the disjoint-validation holdout, and
 * `NO_ELIGIBLE_MATERIAL` by the empty snapshot guard; `INSUFFICIENT_ELIGIBLE`
 * comes from the run-level eligibility gate. `REPLAY_SHARE_EXCEEDED` and
 * `INSUFFICIENT_TRAINING_STEPS` are composition/size shortfalls that new fresh
 * material resolves (a larger fresh delta dilutes replay and raises the step
 * count), so a continuous job waits for more instead of dying.
 */
const NO_MATERIAL_CODES = new Set([
  "INSUFFICIENT_CORPUS",
  "INSUFFICIENT_TRAINING_DATA",
  "INSUFFICIENT_VALIDATION",
  "NO_ELIGIBLE_MATERIAL",
  "INSUFFICIENT_ELIGIBLE",
  "REPLAY_SHARE_EXCEEDED",
  "INSUFFICIENT_TRAINING_STEPS",
  "INSUFFICIENT_SOURCE_DIVERSITY",
  "INSUFFICIENT_FRESH_DATA",
]);

const MATERIAL_WAIT = {
  INSUFFICIENT_CORPUS: { phase: "waiting-for-corpus", reason: "corpus-too-small" },
  INSUFFICIENT_TRAINING_DATA: { phase: "waiting-for-corpus", reason: "corpus-below-minimum" },
  INSUFFICIENT_VALIDATION: { phase: "waiting-for-validation", reason: "insufficient-validation-material" },
  INSUFFICIENT_ELIGIBLE: { phase: "waiting-for-eligible", reason: "insufficient-eligible-material" },
  NO_ELIGIBLE_MATERIAL: { phase: "waiting-for-eligible", reason: "insufficient-eligible-material" },
  REPLAY_SHARE_EXCEEDED: { phase: "waiting-for-fresh-material", reason: "replay-share-exceeded" },
  INSUFFICIENT_TRAINING_STEPS: { phase: "waiting-for-training-steps", reason: "insufficient-training-steps" },
  INSUFFICIENT_SOURCE_DIVERSITY: { phase: "waiting-for-diverse-material", reason: "insufficient-source-diversity" },
  INSUFFICIENT_FRESH_DATA: { phase: "waiting-for-fresh-data", reason: "insufficient-fresh-tokens" },
};

/**
 * JobSupervisor — owns the long-running lifecycle work the Observatory starts.
 *
 * Design rules:
 *   - ONE active job per kind. A duplicate start is a 409, not a second run.
 *   - Jobs are durable: creation, transitions, progress and output are appended
 *     to the JobStore. On boot, `reconcile()` resolves any job the previous
 *     process left non-terminal. Continuous learning/training and any review
 *     drain are RESUMED from their durable state; a one-shot job whose work
 *     actually finished before the crash is reported `completed`, and one that
 *     did not is reported `interrupted` with diagnostics. An operator stop is
 *     completed as `stopped`, and an operator pause is preserved as `paused`:
 *     only deliberate operator intent survives instead of being overwritten by
 *     a process restart.
 *   - Cancellation is cooperative first (a stop flag the loops honour), then a
 *     bounded grace window, and only then a forced process-tree kill.
 *
 * It is bound to the live writable `development` store; jobs never run against
 * an inspection workspace.
 */
export class JobSupervisor {
  constructor({
    store,
    registry,
    governance = null,
    changeFeed = null,
    dir = config.paths.registry,
    pythonStorePath = config.pythonStore ?? null,
    pythonBin = config.pythonBin ?? undefined,
    logger = console,
    ollama = null,
    scorer = null,
    crawl = null,
    discovery = null,
    domainRegistry = null,
    runPython: runPythonFn = runPython,
    trainerFactory = null,
    trainingDeps = {},
    learningDeps = {},
    clock = () => Date.now(),
    telemetry = null,
  } = {}) {
    this.store = store;
    this.registry = registry;
    this.governance = governance;
    this.changeFeed = changeFeed;
    this.dir = dir;
    this.pythonStorePath = pythonStorePath;
    this.pythonBin = pythonBin;
    this.logger = logger;
    this.ollama = ollama ?? new OllamaClient();
    this.scorer = scorer ?? new ReviewScorer({ ollama: this.ollama });
    this.crawl = crawl;
    this.discovery = discovery;
    this.domainRegistry = domainRegistry;
    this.runPython = runPythonFn;
    this.trainerFactory = trainerFactory ?? ((signal, extra = {}) => selectTrainer({ signal, ...extra }));
    this.trainingDeps = trainingDeps;
    this.learningDeps = learningDeps;
    this.clock = clock;
    this.telemetry = telemetry ?? new TrainingTelemetry({
      emit: (snapshot) => this.changeFeed?.emit("training.telemetry", snapshot),
      now: clock,
      maxPoints: config.telemetry.historyPoints,
      publishIntervalMs: config.telemetry.publishIntervalMs,
      staleAfterMs: Math.max(config.telemetry.staleAfterMs, config.telemetry.intervalMs * 2),
    });

    this.jobStore = null;
    this.closing = false;
    this.controls = new Map(); // jobId -> { controller, shouldStop, shouldPause, shutdown, promise }
    this.lastProgressAt = new Map();
  }

  async init({ reconcile = true } = {}) {
    this.jobStore = await JobStore.open(this.dir);
    if (reconcile) await this.reconcile();
    return this;
  }

  // ------------------------------------------------------------- read side
  listJobs() {
    return this.jobStore ? this.jobStore.listJobs().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)) : [];
  }

  getJob(jobId) {
    return this.jobStore ? this.jobStore.getJob(jobId) : null;
  }

  getLog(jobId, opts) {
    return this.jobStore ? this.jobStore.getLog(jobId, opts) : [];
  }

  /** Authoritative reconnect snapshot for live training telemetry. */
  telemetrySnapshot() {
    return this.telemetry.snapshot();
  }

  activeJobOfKind(kind) {
    return this.listJobs().find((j) => j.kind === kind && !j.terminal) ?? null;
  }

  snapshotResolvedConfig() {
    return {
      trainerKind: config.trainerKind,
      teacher: { model: config.ollamaModel, endpoint: config.ollamaEndpoint, fixture: config.ollamaFixture },
      crawl: this.effectiveCrawl(),
      pythonStore: this.pythonStorePath ?? null,
      pollIntervalMs: config.jobs.pollIntervalMs,
      stopGraceMs: config.jobs.stopGraceMs,
    };
  }

  /**
   * The crawl context the learning job will ACTUALLY use. Resolved config must
   * match reality: reporting `mode: real` while the job runs fixtures was the
   * exact disconnected-wiring defect this accessor exists to prevent.
   */
  effectiveCrawl() {
    if (this.discovery?.descriptor) {
      const d = this.discovery.descriptor();
      return {
        mode: d.mode ?? config.crawlMode,
        urls: Array.isArray(d.urls) ? d.urls.length : config.crawlUrls.length,
        policy: d.policy ?? null,
        source: "discovery",
      };
    }
    const c = this.crawl;
    if (c && typeof c === "object") {
      return {
        mode: c.mode ?? config.crawlMode,
        urls: Array.isArray(c.urls) ? c.urls.length : config.crawlUrls.length,
        source: "discovery",
      };
    }
    return { mode: config.crawlMode, urls: config.crawlUrls.length, source: "config" };
  }

  // ------------------------------------------------------------ write side
  async startLearning({ mode = "bounded", targetArticles, maxRawDocs, maxCycles = 0 } = {}) {
    const m = mode === "continuous" ? "continuous" : "bounded";
    return this.#start("learning", {
      mode: m,
      params: {
        targetArticles: Number.isFinite(targetArticles) ? targetArticles : config.jobs.learning.targetArticles,
        maxRawDocs: Number.isFinite(maxRawDocs) ? maxRawDocs : config.jobs.learning.maxRawDocs,
        maxCycles: Number.isFinite(maxCycles) ? maxCycles : 0,
      },
    });
  }

  async startTraining({ mode = "one-shot", parentVersion = null, minEligible } = {}) {
    const m = mode === "continuous" ? "continuous" : "one-shot";
    return this.#start("training", {
      mode: m,
      params: {
        parentVersion: parentVersion ?? null,
        minEligible: Number.isFinite(minEligible) ? minEligible : config.jobs.training.minEligible,
      },
    });
  }

  /**
   * Explicit backlog drain. It reviews the CURRENT pending queue under the same
   * policy/cooldown/attempt rules as the perpetual learner — it does not bypass
   * them — and reports pending / eligible / cooling / retired / failed counts
   * honestly. `limit` caps the number of NEW reviews in one pass (0 = unbounded).
   */
  async startReview({ mode = "drain", limit = 0 } = {}) {
    const m = mode === "continuous" ? "continuous" : "drain";
    return this.#start("review", {
      mode: m,
      params: { limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0 },
    });
  }

  async freshBrain({ confirm = false, config: engine, seed = 0 } = {}) {
    if (confirm !== true) {
      const err = new Error("fresh-brain requires explicit confirmation (confirm: true)");
      err.statusCode = 400;
      throw err;
    }
    return this.#start("fresh-brain", { mode: "one-shot", params: { engine: engine ?? config.initConfig, seed } });
  }

  async stop(jobId) {
    const job = this.getJob(jobId);
    if (!job) throw new JobNotFoundError(`unknown job ${jobId}`);
    if (isTerminal(job.status)) return job;
    const control = this.controls.get(jobId);
    if (!validateTransition(job.status, JOB_STATUS.STOP_REQUESTED)) {
      throw new Error(`illegal status transition: ${job.status} -> ${JOB_STATUS.STOP_REQUESTED}`);
    }
    await this.#event(jobId, { status: JOB_STATUS.STOP_REQUESTED, note: "stop requested" });
    if (!control) {
      // Nothing is executing it (should not happen while non-terminal).
      if (!validateTransition(JOB_STATUS.STOP_REQUESTED, JOB_STATUS.STOPPED)) {
        throw new Error(`illegal status transition: ${JOB_STATUS.STOP_REQUESTED} -> ${JOB_STATUS.STOPPED}`);
      }
      await this.#event(jobId, { status: JOB_STATUS.STOPPED, note: "stopped before it began" });
      return this.getJob(jobId);
    }
    control.shouldStop = true; // cooperative: loops stop starting new work
    const settled = await this.#waitFor(control.promise, config.jobs.stopGraceMs);
    if (!settled) {
      await this.#event(jobId, { status: JOB_STATUS.STOPPING, note: "grace elapsed; forcing process-tree termination" });
      control.controller.abort(); // force: aborts the in-flight Python child tree
      await this.#waitFor(control.promise, config.jobs.stopGraceMs);
    }
    return this.getJob(jobId);
  }

  /**
   * Pause — request that the job stop starting new units of work and reach a
   * documented safe boundary before reporting `paused`.  Does NOT claim the
   * worker is paused while it is still actively modifying state.
   *
   * Returns immediately; the job's loop honours the pause flag and transitions
   * to PAUSED once it has persisted sufficient progress for resumption.
   * If the job type does not support safe mid-operation pause, the method
   * returns an honest limitation.
   */
  async pause(jobId) {
    const job = this.getJob(jobId);
    if (!job) throw new JobNotFoundError(`unknown job ${jobId}`);
    if (isTerminal(job.status)) {
      return this.getJob(jobId); // nothing to pause
    }
    if (job.status === JOB_STATUS.PAUSED || job.status === JOB_STATUS.PAUSE_REQUESTED) {
      return this.getJob(jobId); // already paused or pausing
    }
    const control = this.controls.get(jobId);
    if (!control) {
      // No worker is executing it; we can still record the pause request.
      // The job will transition to PAUSED when next started or reconciled.
      if (!validateTransition(job.status, JOB_STATUS.PAUSE_REQUESTED)) {
        throw new Error(`illegal status transition: ${job.status} -> ${JOB_STATUS.PAUSE_REQUESTED}`);
      }
      await this.#event(jobId, { status: JOB_STATUS.PAUSE_REQUESTED, note: "pause requested but no active worker", meta: { pauseReason: "operator" } });
      return this.getJob(jobId);
    }
    if (!validateTransition(job.status, JOB_STATUS.PAUSE_REQUESTED)) {
      throw new Error(`illegal status transition: ${job.status} -> ${JOB_STATUS.PAUSE_REQUESTED}`);
    }
    control.shouldPause = true; // distinct from shouldStop: does NOT exit
    await this.#event(jobId, { status: JOB_STATUS.PAUSE_REQUESTED, note: "pause requested", meta: { pauseReason: "operator" } });
    return this.getJob(jobId);
  }

  /**
   * Resume — clear the pause request and revalidate prerequisites.  The job
   * may resume from a persisted cursor or checkpoint if supported; otherwise
   * an honest limitation is reported.
   */
  async resume(jobId) {
    const job = this.getJob(jobId);
    if (!job) throw new JobNotFoundError(`unknown job ${jobId}`);
    const control = this.controls.get(jobId);
    if (!control) {
      // No active control; try to lookup from job history and re-initialise.
      // Job was started with queued->running; remain in running state across cycles.
      // Skip re-validation of running->running which is illegal per transition rules.
      if (job.status !== JOB_STATUS.RUNNING && !validateTransition(job.status, JOB_STATUS.RUNNING)) {
        throw new Error(`illegal status transition: ${job.status} -> ${JOB_STATUS.RUNNING}`);
      }
      await this.#event(jobId, { status: JOB_STATUS.RUNNING, note: "resuming from saved state" });
      return this.getJob(jobId);
    }
    control.shouldPause = false;
    control.networkPaused = false; // clears an automatic network pause too
    if (job.status === JOB_STATUS.RUNNING) {
      return this.getJob(jobId); // nothing to emit; the worker is already running
    }
    if (!validateTransition(job.status, JOB_STATUS.RUNNING)) {
      throw new Error(`illegal status transition: ${job.status} -> ${JOB_STATUS.RUNNING}`);
    }
    await this.#event(jobId, { status: JOB_STATUS.RUNNING, note: "resumed" });
    return this.getJob(jobId);
  }

  async #start(kind, { mode, params }) {
    if (!this.jobStore) throw new Error("JobSupervisor.init() was not called");
    if (this.closing) throw new Error("JobSupervisor is shutting down");
    const existing = this.activeJobOfKind(kind);
    if (existing) {
      throw new JobConflictError(`a ${kind} job is already active (${existing.jobId}, ${existing.status})`);
    }
    const job = await this.jobStore.createJob({ kind, title: KIND_TITLES[kind] ?? kind, mode, params });
    if (kind === "training") {
      this.telemetry.beginJob({ jobId: job.jobId, mode, at: this.clock() });
    }
    const controller = new AbortController();
    const control = { controller, shouldStop: false, shouldPause: false, networkPaused: false, shutdown: false, promise: null };
    this.controls.set(job.jobId, control);
    control.promise = this.#run(job, params, control).finally(() => this.controls.delete(job.jobId));
    this.changeFeed?.emit("job.started", { jobId: job.jobId, kind, mode });
    return job;
  }

  async #run(job, params, control) {
    const { jobId } = job;
    const log = (stream, text) => {
      const line = String(text ?? "");
      if (!line) return;
      void this.jobStore.appendLog(jobId, { stream, text: line }).catch(() => {});
      this.changeFeed?.emit("job.log", { jobId, stream, text: line });
    };
    const onPhase = (phase) => {
      void this.#event(jobId, { status: JOB_STATUS.RUNNING, phase, note: null }).catch(() => {});
      this.changeFeed?.emit("job.progress", { jobId, phase });
    };
    const onProgress = (progress) => this.#progress(jobId, progress);
    try {
      const job = this.getJob(jobId);
      // A recovered job may already be recorded RUNNING (the process died while
      // it was executing). Treat that as an idempotent resume, not an illegal
      // running -> running transition.
      if ((job?.status ?? JOB_STATUS.QUEUED) !== JOB_STATUS.RUNNING && !validateTransition(job?.status ?? JOB_STATUS.QUEUED, JOB_STATUS.RUNNING)) {
        throw new Error(`illegal status transition: ${job?.status ?? JOB_STATUS.QUEUED} -> ${JOB_STATUS.RUNNING}`);
      }
      await this.#event(jobId, {
        status: JOB_STATUS.RUNNING,
        phase: "starting",
        note: "job started",
        result: { resolvedConfig: this.snapshotResolvedConfig() },
      });
      const result = await this.#dispatch(job, params, control, { log, onPhase, onProgress });
      if (control.shutdown) {
        // Graceful shutdown leaves the durable job non-terminal so startup
        // reconcile can resume it. It is not an operator stop.
      } else if (result.outcome === "paused") {
        await this.#event(jobId, { status: JOB_STATUS.PAUSED, note: "paused by operator", result, meta: { pauseReason: "operator" } });
      } else if (this.#shouldStop(jobId)) {
        await this.#event(jobId, { status: JOB_STATUS.STOPPED, note: "stopped by operator", result });
      } else {
        await this.#event(jobId, { status: JOB_STATUS.COMPLETED, note: "job completed", result });
      }
    } catch (err) {
      const job = this.getJob(jobId);
      if (control.shutdown) {
        log("err", `shutdown interrupted in-flight work: ${err?.message ?? String(err)}`);
      } else if (isAbort(err) || this.#shouldStop(jobId)) {
        if (!validateTransition(job.status, JOB_STATUS.STOPPED)) {
          throw new Error(`illegal status transition: ${job.status} -> ${JOB_STATUS.STOPPED}`);
        }
        await this.#event(jobId, { status: JOB_STATUS.STOPPED, note: err?.message ?? "stopped", error: null });
      } else {
        if (!validateTransition(job.status, JOB_STATUS.FAILED)) {
          throw new Error(`illegal status transition: ${job.status} -> ${JOB_STATUS.FAILED}`);
        }
        log("err", err?.message ?? String(err));
        await this.#event(jobId, { status: JOB_STATUS.FAILED, note: err?.message ?? "job failed", error: err?.message ?? String(err) });
      }
    } finally {
      const final = this.getJob(jobId);
      this.changeFeed?.emit("job.finished", { jobId, status: final?.status ?? null });
    }
  }

  async #dispatch(job, params, control, cb) {
    const { signal } = control.controller;
    const base = {
      store: this.store,
      registry: this.registry,
      signal,
      log: cb.log,
      onPhase: cb.onPhase,
      onProgress: cb.onProgress,
    };
    if (job.kind === "learning") return this.#runLearning(job, params, base);
    if (job.kind === "training") return this.#runTraining(job, params, base);
    if (job.kind === "review") return this.#runReview(job, params, base);
    if (job.kind === "fresh-brain") return this.#runFreshBrain(job, params, base);
    throw new Error(`unknown job kind ${job.kind}`);
  }

  async #runLearning(job, params, base) {
    const { jobId } = job;
    // Ensure target is a valid positive integer, default to config if invalid
    const target = Number.isFinite(params.targetArticles) && params.targetArticles > 0 
      ? Math.floor(params.targetArticles) 
      : config.jobs.learning.targetArticles;
    const ctx = {
      ...base,
      jobId,
      ollama: this.ollama,
      scorer: this.scorer,
      crawl: this.crawl,
      // When a discovery service is wired, acquisition follows the persistent
      // frontier (seeds + policy-approved links) instead of a static URL list.
      collectDocuments: this.discovery ? (c) => this.discovery.collect(c) : undefined,
      maxRawDocs: params.maxRawDocs,
      domainRegistry: this.domainRegistry,
      ...this.learningDeps,
    };
    let cycle = 0;
    let last = null;
    let outcome = "stopped";
    let noProgressStreak = 0;
    let prevTrainable = null;
    let targetMilestoneLogged = false;
    let acquisitionWaitAttempt = 0;
    let lastWaitReason = null;
    let lastCapNote = null;
    let lastNetworkReason = null;
    const startedAt = this.clock();
    const continuous = job.mode === "continuous";
    // A recovered WAITING job resumes at its persisted deadline: the deadline is
    // authoritative, the in-memory timer is only an optimisation. If the deadline
    // is still in the future, wait (interruptibly) until it before cycling.
    const savedMeta = this.getJob(jobId)?.meta ?? null;
    const savedNextAt = savedMeta?.nextAttemptAt ? Date.parse(savedMeta.nextAttemptAt) : NaN;
    if (Number.isFinite(savedNextAt)) {
      const until = savedNextAt - this.clock();
      if (until > 0) await this.#gate(jobId, until);
    }
    for (;;) {
      if (this.#shouldStop(jobId)) break;
      if (this.#runtimeExceeded(startedAt)) {
        await this.#safeEvent(jobId, {
          status: JOB_STATUS.RUNNING,
          phase: "max-runtime",
          note: `stopping: job runtime exceeded JOBS_MAX_RUNTIME_MS (${config.jobs.maxRuntimeMs} ms)`,
        });
        outcome = "max-runtime";
        break;
      }
      // Operator pause: stop starting new units of work and wait at this safe
      // boundary (also reached when a pause arrives during the inter-cycle gate).
      if (this.#shouldPause(jobId)) {
        await this.#holdPause(jobId);
        if (this.#shouldStop(jobId)) { outcome = "stopped"; break; }
        continue;
      }
      const pendingReview = Number(this.store?.getStats?.().pendingReview ?? 0);
      const maxPendingReview = Number(config.jobs.learning.maxPendingReview) || 0;
      if (maxPendingReview > 0 && pendingReview > maxPendingReview) {
        const note = `waiting: ${pendingReview} pending review(s) exceed the ingestion throttle of ${maxPendingReview}`;
        if (note !== lastWaitReason) {
          lastWaitReason = note;
          await this.#safeEvent(jobId, {
            status: JOB_STATUS.WAITING,
            phase: "waiting-for-review-backlog",
            note,
            meta: { waitingReason: "review-backlog", pendingReview, maxPendingReview },
          });
        }
        await this.#gate(jobId, config.jobs.pollIntervalMs);
        continue;
      }
      const job = this.getJob(jobId);
      // Job was started with queued->running; remain in running state across cycles.
      // Skip re-validation of running->running which is illegal per transition rules.
      if (job.status !== JOB_STATUS.RUNNING && !validateTransition(job.status, JOB_STATUS.RUNNING)) {
        throw new Error(`illegal status transition: ${job.status} -> ${JOB_STATUS.RUNNING}`);
      }
      cycle++;
      try {
        await this.#event(jobId, { status: JOB_STATUS.RUNNING, phase: `learning cycle ${cycle}` });
      } catch (_e) {
        // event write failure is non-fatal; continue with the cycle
      }
      try {
        last = await runLearningCycle(ctx);
      } catch (err) {
        if (isNetworkError(err)) {
          const reason = String(err?.code ?? err?.message ?? "network error");
          if (continuous) {
            // A transient network error is an expected condition for a perpetual
            // learner: log it, keep the job RUNNING, and retry on the normal poll
            // interval. Never convert it into an operator-visible PAUSED state.
            base.log("err", `network error during learning cycle (${reason}); continuing without pause`);
            if (reason !== lastNetworkReason) {
              lastNetworkReason = reason;
              await this.#safeEvent(jobId, {
                status: JOB_STATUS.RUNNING,
                phase: "network-retry",
                note: `network error (${reason}); continuing to retry`,
                meta: { networkFailure: true, reason },
              });
            }
            await this.#gate(jobId, Math.max(1000, config.jobs.pollIntervalMs));
            continue;
          }
          await this.#networkPause(jobId, reason);
          if (this.#shouldStop(jobId)) { outcome = "stopped"; break; }
          cycle--; // one-shot: retry the same cycle once connectivity is restored
          continue;
        }
        throw err;
      }
      // Progress = the corpus actually moved: a NEW ingested article or a rise
      // in trainable count. Dedupes are NOT progress (the same material seen
      // again), and a pass that filters everything out as junk acquires nothing.
      // A continuous learning job NEVER terminates for lack of new material: it
      // surfaces a WAITING state and keeps polling, leaving all existing eligible
      // material available for continuous training in the meantime.
      const acquired = (last?.ingested ?? 0) > 0;
      const trainableGrew = prevTrainable === null ? true : (last?.trainable ?? 0) > prevTrainable;
      prevTrainable = last?.trainable ?? prevTrainable;
      if (acquired || trainableGrew) noProgressStreak = 0;
      else if (last?.reviewWaiting || last?.admissionCapExhausted) {
        // The pass made no acquisition only because the review backlog is in
        // cooldown (or another worker holds REVIEW.lock), or because the active
        // admission epoch is full. Both are TEMPORARY waits, not stalls, and
        // must never consume the no-progress budget.
      } else noProgressStreak++;
      try {
        await this.#progress(jobId, { cycle, noProgressStreak, ...summarizeLearning(last) }, { force: true });
      } catch (_e) {
        // progress write failure is non-fatal; continue with the cycle
      }
      // Operator pause: stop starting new units of work and wait at this safe
      // boundary. The worker stays alive and resumes the remainder on request.
      if (this.#shouldPause(jobId)) {
        await this.#holdPause(jobId);
        if (this.#shouldStop(jobId)) { outcome = "stopped"; break; }
        continue;
      }
      // Admission cap exhaustion is a lifecycle wait, not a source failure and
      // not a reason to mark frontier URLs rejected. Park here; the gateway
      // adopts a newly activated epoch on its next authorization, so an
      // operator-run rollover resumes acquisition without a service restart.
      if (last?.admissionCapExhausted) {
        const quota = last.admissionQuotaExhausted === true;
        const note = quota
          ? `waiting: rolling admission quota exhausted; next capacity in ${Math.max(1, Math.round((last.admissionQuotaRetryAfterMs ?? config.jobs.learning.capWaitMs) / 1000))}s (no URL was rejected)`
          : `waiting: admission cap exhausted for epoch ${last.admissionCapEpoch ?? "?"}; activate the next epoch to continue (no URL was rejected)`;
        if (note !== lastCapNote) {
          lastCapNote = note;
          await this.#safeEvent(jobId, {
            status: JOB_STATUS.WAITING,
            phase: quota ? "waiting-for-admission-quota" : "waiting-for-admission-cap",
            note,
            meta: quota
              ? {
                  waitingReason: "admission-quota-exhausted",
                  policyVersion: last.admissionQuotaPolicyVersion ?? null,
                  quotaUsed: last.admissionQuotaUsed ?? null,
                  quotaLimit: last.admissionQuotaLimit ?? null,
                  retryAfterMs: last.admissionQuotaRetryAfterMs ?? null,
                  deferred: last.admissionQuotaDeferred ?? 0,
                }
              : { waitingReason: "admission-cap-exhausted", epoch: last.admissionCapEpoch ?? null, capDeferred: last.admissionCapDeferred ?? 0 },
          });
        }
        const waitMs = quota
          ? Math.max(1000, Math.min(last.admissionQuotaRetryAfterMs ?? config.jobs.learning.capWaitMs, 60 * 60 * 1000))
          : config.jobs.learning.capWaitMs;
        await this.#gate(jobId, waitMs);
        continue;
      }
      lastCapNote = null;

      // A whole pass fetched nothing and every failure was a connectivity error.
      // For a CONTINUOUS job this is transient: log it and continue to the next
      // source/poll. It must never pause or stop the perpetual learner. A
      // one-shot job keeps the historical pause-and-retry-on-resume behaviour.
      const failures = Array.isArray(last?.failures) ? last.failures : [];
      const networkFailures = failures.filter(isNetworkFailure);
      const allFailuresNetwork =
        (last?.rawDocs ?? 0) === 0 &&
        networkFailures.length > 0 &&
        networkFailures.length === failures.length;
      if (allFailuresNetwork) {
        const reason = String(networkFailures[0]?.reason ?? "network unavailable");
        const urls = networkFailures
          .slice(0, 3)
          .map((f) => f?.url)
          .filter(Boolean)
          .join(", ");
        base.log(
          "err",
          `network failure (${reason}) fetching ${networkFailures.length} source(s)${urls ? `: ${urls}` : ""}; continuing`,
        );
        if (continuous) {
          if (reason !== lastNetworkReason) {
            lastNetworkReason = reason;
            await this.#safeEvent(jobId, {
              status: JOB_STATUS.RUNNING,
              phase: "network-retry",
              note: `network error (${reason}) fetching ${networkFailures.length} source(s); continuing to retry`,
              meta: { networkFailure: true, reason, failureCount: networkFailures.length },
            });
          }
          await this.#gate(jobId, Math.max(1000, config.jobs.pollIntervalMs));
          continue;
        }
        await this.#networkPause(jobId, reason);
        if (this.#shouldStop(jobId)) { outcome = "stopped"; break; }
        cycle--; // one-shot: retry the same cycle once connectivity is restored
        continue;
      }
      lastNetworkReason = null;
      // The target is a BOUNDED notion. A continuous learning job never stops on
      // it — reaching it is reported once as a milestone, then acquisition keeps
      // running until the operator stops it, the sources are exhausted, or it
      // genuinely stalls.
      if (!continuous && last.trainable >= target) {
        outcome = "target-reached";
        break;
      }
      if (continuous && last.trainable >= target) {
        if (!targetMilestoneLogged) {
          targetMilestoneLogged = true;
          await this.#safeEvent(jobId, {
            status: JOB_STATUS.RUNNING,
            phase: "target-milestone",
            note: `trainable ${last.trainable} reached target ${target}; continuous learning continues (targets apply to bounded runs)`,
          });
        }
      } else if (continuous) {
        targetMilestoneLogged = false; // allow a re-milestone after a dip
      }
      // No discovery source is configured at all (no seeds, no eligible
      // registered domains, no usable adapter). This is NOT "sources exhausted":
      // the honest report is that there is no capability to obtain documents, so
      // an operator can configure one instead of concluding the web is empty.
      if (last?.discovery?.status === "no-source-configured") {
        await this.#safeEvent(jobId, {
          status: JOB_STATUS.RUNNING,
          phase: "no-source-configured",
          note: "stopping: no discovery source configured (set CRAWL_URLS, register a domain, or enable a discovery adapter)",
        });
        outcome = "no-source-configured";
        break;
      }
      // The AUTHORITATIVE acquisition classification — not the raw-document
      // count — decides whether a perpetual job keeps cycling, waits (bounded
      // backoff, persisted), or (for a bounded job) reports a terminal
      // `sources-exhausted` with the reason attached. `WORK` continues even when
      // a pass produced no usable documents; a continuous job must NEVER
      // terminate merely because no immediate work is available.
      const acquisition = last?.acquisition ?? null;
      if (acquisition && acquisition.state !== ACQUISITION_STATE.WORK) {
        const acq = acquisition;
        if (continuous) {
          lastWaitReason = acq.reason;
          const now = this.clock();
          const deadline = backoffDeadline(acquisitionWaitAttempt, {
            baseMs: config.jobs.learning.waitBackoffBaseMs,
            maxMs: config.jobs.learning.waitBackoffMaxMs,
            now,
          });
          // Honor a frontier-scheduled retry/rediscovery deadline: wake when it
          // is due, but never sleep longer than the configured maximum (so a
          // stale far-future deadline cannot park the job indefinitely).
          let waitDelayMs = deadline.delayMs;
          let nextAttemptAt = deadline.nextAttemptAt;
          const dueTs = acq.nextDueAt ? Date.parse(acq.nextDueAt) : NaN;
          if (Number.isFinite(dueTs) && dueTs > now) {
            const target = Math.min(dueTs, now + config.jobs.learning.waitBackoffMaxMs);
            waitDelayMs = Math.max(waitDelayMs, target - now);
            nextAttemptAt = now + waitDelayMs;
          }
          await this.#safeEvent(jobId, {
            status: JOB_STATUS.WAITING,
            phase: `waiting-for-acquisition:${acq.state}`,
            note: `waiting: ${acq.reason}`,
            meta: {
              waitingReason: acq.reason,
              acquisitionState: acq.state,
              nextAttemptAt: new Date(nextAttemptAt).toISOString(),
              diagnostics: { frontier: last?.frontier ?? null, discovery: last?.discovery ?? null },
            },
          });
          acquisitionWaitAttempt++;
          noProgressStreak = 0; // a scheduled wait is not a stall
          await this.#gate(jobId, waitDelayMs);
          continue;
        }
        outcome = "sources-exhausted";
        lastWaitReason = acq.reason;
        break;
      }
      acquisitionWaitAttempt = 0; // claimable work => reset the backoff
      if (params.maxCycles > 0 && cycle >= params.maxCycles) {
        outcome = "max-cycles";
        break;
      }
      // A bounded pass acquires once; only continuous (or an explicit cycle cap)
      // keeps going, so a bounded request can never busy-loop.
      if (!continuous && params.maxCycles <= 0) {
        outcome = "bounded-pass-complete";
        break;
      }
      const noProgressCap = config.jobs.learning.noProgressCycles;
      if (continuous && noProgressCap > 0 && noProgressStreak >= noProgressCap) {
        // Perpetual means perpetual: no fresh material is a WAIT, never a
        // terminal outcome. Existing reviewed+unconsumed articles stay available
        // to the continuous training job until genuinely new material arrives.
        const nextAttemptAt = new Date(this.clock() + config.jobs.pollIntervalMs).toISOString();
        await this.#safeEvent(jobId, {
          status: JOB_STATUS.WAITING,
          phase: "waiting-for-new-material",
          note: `waiting: ${noProgressStreak} consecutive cycle(s) acquired nothing new; existing eligible material retained (${last?.trainable ?? 0} trainable) while waiting for fresh sources`,
          meta: {
            waitingReason: "no-new-material",
            noProgressStreak,
            trainable: last?.trainable ?? null,
            nextAttemptAt,
          },
        });
        noProgressStreak = 0;
        await this.#gate(jobId, config.jobs.pollIntervalMs);
        continue;
      }
      await this.#gate(jobId, continuous ? config.jobs.pollIntervalMs : 0);
    }
    return {
      outcome,
      cycles: cycle,
      target,
      // `targetReached` is meaningful for a BOUNDED job (it stopped because the
      // target was met). A continuous job ignores the target, so it reports the
      // milestone separately rather than claiming it finished.
      targetReached: !continuous && Boolean(last && last.trainable >= target),
      targetMilestone: continuous && Boolean(last && last.trainable >= target),
      exhaustionReason: lastWaitReason,
      ...summarizeLearning(last),
    };
  }

  async #runTraining(job, params, base) {
    const { jobId } = job;
    const minEligible = params.minEligible;
    let last = null;
    let runs = 0;
    let consecutiveRejections = 0;
    let lastLockNote = null;
    let lastMaterialWaitKey = null;
    let lastNetworkReason = null;
    const startedAt = this.clock();
    for (;;) {
      if (this.#shouldStop(jobId)) break;
      if (this.#runtimeExceeded(startedAt)) {
        await this.#safeEvent(jobId, {
          status: JOB_STATUS.RUNNING,
          phase: "max-runtime",
          note: `stopping: job runtime exceeded JOBS_MAX_RUNTIME_MS (${config.jobs.maxRuntimeMs} ms)`,
        });
        return { outcome: "max-runtime", runs, ...(last ?? {}) };
      }
      // Operator pause: a single Python training run cannot be interrupted mid-step,
      // so we hold at the safe boundary BETWEEN runs (and while waiting for eligible
      // material). The worker stays alive and resumes the remainder on request.
      if (this.#shouldPause(jobId)) {
        await this.#holdPause(jobId);
        if (this.#shouldStop(jobId)) break;
        continue;
      }
      const stats = this.store.getStats();
      if (stats.trainable < minEligible) {
        const recoverable = stats.recoverable ?? 0;
        if (job.mode === "one-shot") {
          const err = new Error(
            stats.trainable === 0
              ? `insufficient eligible material: no eligible unconsumed material (0 reviewed+unconsumed article(s))${recoverable > 0 ? `, ${recoverable} recoverable via review/quarantine` : ""}`
              : `insufficient eligible material: ${stats.trainable} reviewed+unconsumed article(s), need ${minEligible}`,
          );
          err.code = "INSUFFICIENT_ELIGIBLE";
          throw err;
        }
        // Continuous: wait (persisted) and report WHY. Distinguish "material is
        // still coming (recovery)" from "genuinely nothing eligible" so operators
        // can tell a cooling pipeline from a dry one, and never mark the job
        // terminal merely because the delta is momentarily empty.
        const reason =
          stats.trainable === 0
            ? recoverable > 0
              ? "recovery-pending"
              : "no-eligible-unconsumed-material"
            : "insufficient-eligible-material";
        const note =
          stats.trainable === 0
            ? recoverable > 0
              ? `waiting: no eligible unconsumed material yet (${recoverable} recoverable: ${stats.ingested ?? 0} ingested, ${stats.pendingReview ?? 0} pending, ${stats.quarantined ?? 0} quarantined)`
              : "waiting: no eligible unconsumed material (nothing ingested, pending, or quarantined)"
            : `waiting: ${stats.trainable}/${minEligible} eligible article(s)`;
        await this.#event(jobId, {
          status: JOB_STATUS.WAITING,
          phase: "waiting-for-eligible",
          note,
          meta: {
            waitingReason: reason,
            trainable: stats.trainable,
            minEligible,
            recoverable,
            recovery: {
              ingested: stats.ingested ?? 0,
              pendingReview: stats.pendingReview ?? 0,
              quarantined: stats.quarantined ?? 0,
              released: stats.quarantineReleased ?? 0,
              consumed: stats.uniqueConsumed ?? 0,
            },
          },
        });
        await this.#gate(jobId, config.jobs.pollIntervalMs);
        continue;
      }
      // Continuous training checks RUN.lock BEFORE announcing a training phase,
      // so a contended job parks visibly at waiting-for-lock instead of
      // flickering between "training" and a wait on every poll. One-shot keeps
      // its existing semantics and lets executeFullRun raise the typed failure.
      if (job.mode !== "one-shot") {
        const info = typeof this.registry?.runLockInfo === "function" ? this.registry.runLockInfo() : null;
        // Park only on a GENUINELY held lock — the owner must still be alive (or on
        // a foreign host we cannot verify). A stale lock (owner gone) is reclaimable
        // and must NOT park the job: it proceeds so `acquireRunLock` can reclaim it.
        // (`info.held` is true for any existing lock file, so gating on it blocked
        // training forever on a dead owner's stale lock.)
        if (info?.ownerAlive) {
          const note = `waiting: RUN.lock held by pid ${info.pid ?? "?"} on ${info.host ?? "?"}${info.runId ? ` (run ${info.runId})` : ""}`;
          if (note !== lastLockNote) {
            lastLockNote = note;
            await this.#safeEvent(jobId, { status: JOB_STATUS.WAITING, phase: "waiting-for-lock", note });
          }
          await this.#gate(jobId, config.jobs.pollIntervalMs);
          continue;
        }
      }
      lastLockNote = null;
      await this.#event(jobId, { status: JOB_STATUS.RUNNING, phase: "training" });
      // Each cycle publishes a NEW immutable version (vNNN) from the parent; the
      // Python side allocates the next number, so continuous runs never collide.
      let out;
      try {
        out = await runTrainingOnce({
          ...base,
          ...this.trainingDeps,
          trainer: this.trainerFactory(base.signal, {
            onTelemetry: (event) => this.telemetry.ingest(event, { jobId, now: this.clock() }),
          }),
          parentVersion: params.parentVersion,
          minEligible,
          logger: this.#jobLogger(jobId),
        });
      } catch (err) {
        // Insufficient material — too few eligible articles, a corpus too small
        // to form one block, a snapshot the guards emptied, a replay share that
        // only more fresh material can dilute, or too few training steps from a
        // thin corpus — is an operator condition, not a training fault: a
        // continuous job waits for more reviewed material (the articles stay
        // unconsumed), while a one-shot job fails with the clear message instead
        // of a Python traceback.
        if (NO_MATERIAL_CODES.has(err?.code)) {
          if (job.mode === "one-shot") throw err;
          const wait = MATERIAL_WAIT[err.code] ?? MATERIAL_WAIT.INSUFFICIENT_ELIGIBLE;
          // The run announces "training" before the preflight can reject it, so
          // every retry still needs a WAITING event to restore the visible state.
          // Suppress only the repeated NOTE; the reason/status must be re-emitted.
          const waitKey = `${wait.phase}\u0000${err.message}`;
          const repeated = waitKey === lastMaterialWaitKey;
          lastMaterialWaitKey = waitKey;
          await this.#event(jobId, {
            status: JOB_STATUS.WAITING,
            phase: wait.phase,
            note: repeated ? null : err.message,
            meta: {
              waitingReason: wait.reason,
              tokens: err.tokens ?? null,
              minUniqueTokens: err.minUniqueTokens ?? null,
              blockCount: err.blockCount ?? null,
              replayShare: err.replayShare ?? null,
            },
          });
          await this.#gate(jobId, config.jobs.pollIntervalMs);
          continue;
        }
        // A held RUN.lock is legitimate contention with a co-operating process
        // (e.g. `npm run perpetual`), not a training fault. A CONTINUOUS job
        // waits for the lock to clear; a ONE-SHOT job keeps the honest failure.
        if (err?.code === "RUN_LOCK_HELD") {
          if (job.mode === "one-shot") throw err;
          const note = `waiting: ${err.message}`;
          // Emit only when the holder (or the message) changes, so a 60s poll
          // does not append the same "waiting for lock" line forever.
          if (note !== lastLockNote) {
            lastLockNote = note;
            await this.#safeEvent(jobId, { status: JOB_STATUS.WAITING, phase: "waiting-for-lock", note });
          }
          await this.#gate(jobId, config.jobs.pollIntervalMs);
          continue;
        }
        if (isNetworkError(err) && job.mode !== "one-shot") {
          const reason = String(err?.code ?? err?.message ?? "network error");
          base.log("err", `network error during training (${reason}); continuing without pause`);
          if (reason !== lastNetworkReason) {
            lastNetworkReason = reason;
            await this.#safeEvent(jobId, {
              status: JOB_STATUS.RUNNING,
              phase: "network-retry",
              note: `network error (${reason}); continuing to retry training`,
              meta: { networkFailure: true, reason },
            });
          }
          await this.#gate(jobId, config.jobs.pollIntervalMs);
          continue;
        }
        throw err;
      }
      runs++;
      last = summarizeRun(out, this.registry);
      lastLockNote = null; // a successful run clears the wait-dedupe
      lastMaterialWaitKey = null;
      lastNetworkReason = null;
      // A promoted run proves forward progress; a rejected (or unevaluated) run
      // does not. Count streaks so continuous training cannot silently retrain
      // the same corpus forever (run-46..run-52 all staged v035 and were
      // rejected with no visible failure).
      if (last.promoted) consecutiveRejections = 0;
      else consecutiveRejections++;
      await this.#progress(jobId, { runs, consecutiveRejections, ...last }, { force: true });
      if (job.mode === "one-shot") {
        // Honor a pause that arrived while the single run was executing, so the
        // operator sees PAUSED (and can resume/stop) instead of an abrupt finish.
        if (this.#shouldPause(jobId)) {
          await this.#holdPause(jobId);
          if (this.#shouldStop(jobId)) break;
        }
        break;
      }
      const maxRejections = config.jobs.training.maxConsecutiveRejections;
      if (maxRejections > 0 && consecutiveRejections >= maxRejections) {
        // Continuous training is perpetual: a rejection streak is a quality signal,
        // not a terminal condition. A rejected batch is DEFERRED (bounded retry),
        // not consumed, so it stays eligible alongside new material until the
        // retry limit retires it. Surface the streak for the operator and reset
        // the counter so the job keeps running instead of stopping.
        await this.#safeEvent(jobId, {
          status: JOB_STATUS.RUNNING,
          phase: "repeated-rejection",
          note: `${consecutiveRejections} consecutive run(s) were not promoted (TRAIN_MAX_CONSECUTIVE_REJECTIONS=${maxRejections}); continuing to wait for new material`,
        });
        consecutiveRejections = 0;
      }
      if (this.#runtimeExceeded(startedAt)) {
        await this.#safeEvent(jobId, {
          status: JOB_STATUS.RUNNING,
          phase: "max-runtime",
          note: `stopping: job runtime exceeded JOBS_MAX_RUNTIME_MS (${config.jobs.maxRuntimeMs} ms)`,
        });
        return { outcome: "max-runtime", runs, consecutiveRejections, ...(last ?? {}) };
      }
      await this.#gate(jobId, config.jobs.pollIntervalMs);
    }
    return { outcome: this.#shouldStop(jobId) ? "stopped" : "completed", runs, consecutiveRejections, ...(last ?? {}) };
  }

  async #runReview(job, params, base) {
    const { jobId } = job;
    const continuous = job.mode === "continuous";
    const startedAt = this.clock();
    const total = { selected: 0, reviewed: 0, retired: 0, failed: 0, skippedCooldown: 0, skippedCap: 0, skippedTechnicalCap: 0 };
    let passes = 0;
    let outcome = "stopped";
    let lastWaitNote = null;
    for (;;) {
      if (this.#shouldStop(jobId)) { outcome = "stopped"; break; }
      if (this.#runtimeExceeded(startedAt)) {
        await this.#safeEvent(jobId, {
          status: JOB_STATUS.RUNNING,
          phase: "max-runtime",
          note: `stopping: job runtime exceeded JOBS_MAX_RUNTIME_MS (${config.jobs.maxRuntimeMs} ms)`,
        });
        outcome = "max-runtime";
        break;
      }
      if (this.#shouldPause(jobId)) {
        await this.#holdPause(jobId);
        if (this.#shouldStop(jobId)) { outcome = "stopped"; break; }
        continue;
      }
      passes++;
      // A previous pass may have reported WAITING because another worker held
      // REVIEW.lock. Once we start the next pass (and especially after we later
      // acquire the lock) the job IS running again. Not emitting this transition
      // left job-94 visibly "waiting" for hours while it was actively reviewing.
      lastWaitNote = null;
      await this.#safeEvent(jobId, {
        status: JOB_STATUS.RUNNING,
        phase: "review",
        note: `review pass ${passes}`,
      });
      const result = await reviewPendingArticles(this.store, this.scorer, {
        config,
        log: base.log,
        signal: base.signal,
        limit: params.limit,
        lockOwner: { jobId, kind: "review" },
        onProgress: (p) => this.#progress(jobId, { pass: passes, ...total, ...p }, { force: true }),
      });
      for (const k of Object.keys(total)) total[k] += result[k] ?? 0;
      const stats = this.store.getStats();
      const pending = result.pendingAfter ?? stats.pendingReview;
      await this.#progress(
        jobId,
        {
          passes,
          ...total,
          pending,
          cooling: result.skippedCooldown,
          eligibleRemaining: result.eligibleRemaining ?? 0,
          nextEligibleAt: result.nextEligibleAt ?? null,
        },
        { force: true },
      );
      if (result.locked) {
        const note = "another review worker holds REVIEW.lock; retrying";
        if (note !== lastWaitNote) {
          lastWaitNote = note;
          await this.#safeEvent(jobId, {
            status: JOB_STATUS.WAITING,
            phase: "waiting-for-review-lock",
            note,
          });
        }
        await this.#gate(jobId, config.jobs.pollIntervalMs);
        continue;
      }
      if (pending <= 0) {
        // A finite drain is finished only when the queue is actually empty. A
        // continuous review worker stays alive and keeps the backlog empty.
        if (!continuous) {
          outcome = "drained";
          break;
        }
        const note = "review queue empty; waiting for new pending articles";
        if (note !== lastWaitNote) {
          lastWaitNote = note;
          await this.#safeEvent(jobId, {
            status: JOB_STATUS.WAITING,
            phase: "waiting-for-review-material",
            note,
            meta: { waitingReason: "no-pending-review-material" },
          });
        }
        await this.#gate(jobId, config.jobs.pollIntervalMs);
        continue;
      }
      // Pending articles remain. This is the defect the old "drained" outcome
      // hid: a pass limited to N reviews (or every article merely cooling down)
      // left the rest untouched. Wait for the earliest cooldown expiry and run
      // another pass; never stop with pending work still in the queue.
      lastWaitNote = null;
      const now = this.clock();
      let waitMs = Number.isFinite(result.nextEligibleAt)
        ? Math.max(0, result.nextEligibleAt - now)
        : config.jobs.pollIntervalMs;
      // Never oversleep an operator runtime bound.
      const maxRuntime = config.jobs.maxRuntimeMs;
      if (maxRuntime > 0) waitMs = Math.min(waitMs, Math.max(0, startedAt + maxRuntime - now));
      const nextAt = Number.isFinite(result.nextEligibleAt) ? new Date(result.nextEligibleAt).toISOString() : null;
      const note = nextAt
        ? `waiting: ${pending} pending review(s) cooling down; next attempt at ${nextAt}`
        : `waiting: ${pending} pending review(s) remain; retrying`;
      if (note !== lastWaitNote) {
        lastWaitNote = note;
        await this.#safeEvent(jobId, {
          status: JOB_STATUS.WAITING,
          phase: nextAt ? "waiting-for-review-cooldown" : "waiting-for-review-retry",
          note,
          meta: { waitingReason: nextAt ? "review-cooldown" : "review-retry", pending, nextEligibleAt: nextAt },
        });
      }
      await this.#gate(jobId, waitMs);
      continue;
    }
    const stats = this.store.getStats();
    return {
      outcome,
      passes,
      ...total,
      pending: stats.pendingReview,
      trainable: stats.trainable,
      note: outcome === "drained"
        ? `reviewed ${total.reviewed}, retired ${total.retired}, ${total.skippedCooldown} cooling, ${total.failed} failed, ${stats.pendingReview} still pending`
        : undefined,
    };
  }

  async #runFreshBrain(job, params, base) {
    const { jobId } = job;
    const run = this.runPython ?? undefined;
    const result = await createFreshBrain({
      ...base,
      run,
      bin: this.pythonBin,
      config: params.engine,
      seed: params.seed,
      onProgress: (p) => this.#progress(jobId, p, { force: true }),
    });
    return result;
  }

  // --------------------------------------------------------------- helpers
  #jobLogger(jobId) {
    const tag = `[job ${jobId}]`;
    return {
      log: (...a) => this.logger?.log?.(tag, ...a),
      error: (...a) => {
        this.logger?.error?.(tag, ...a);
        void this.jobStore.appendLog(jobId, { stream: "err", text: a.map(String).join(" ") }).catch(() => {});
      },
    };
  }

  #shouldStop(jobId) {
    const c = this.controls.get(jobId);
    if (!c) return true;
    return c.shouldStop || c.controller.signal.aborted;
  }

  #shouldPause(jobId) {
    const c = this.controls.get(jobId);
    if (!c) return false; // no worker => nothing is (or can be) paused
    return Boolean(c.shouldPause);
  }

  /**
   * Hold gate — the worker stays ALIVE while paused. It waits asynchronously
   * (no busy-spin) until the operator resumes (clearing `shouldPause` and/or
   * `networkPaused`) or stops the job. A stopped job resolves so the caller can
   * break out and report `stopped`; only an abort rejects.
   */
  #holdGate(jobId) {
    const c = this.controls.get(jobId);
    if (!c) return Promise.reject(abortError());
    if (c.controller.signal.aborted) return Promise.reject(abortError());
    if (c.shouldStop) return Promise.resolve();
    if (!c.shouldPause && !c.networkPaused) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = (fn, arg) => {
        clearInterval(interval);
        c.controller.signal.removeEventListener("abort", onAbort);
        fn(arg);
      };
      const interval = setInterval(() => {
        if (c.shouldStop || c.controller.signal.aborted || (!c.shouldPause && !c.networkPaused)) done(resolve);
      }, 200);
      interval.unref?.();
      const onAbort = () => done(reject, abortError());
      c.controller.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Operator pause: report PAUSED at the safe boundary, then hold the worker. */
  async #holdPause(jobId) {
    await this.#event(jobId, { status: JOB_STATUS.PAUSED, note: "paused at safe boundary; waiting for resume", meta: { pauseReason: "operator" } });
    await this.#holdGate(jobId);
  }

  /** One-shot connectivity pause: flag the transient condition, report PAUSED, then hold. */
  async #networkPause(jobId, reason) {
    const c = this.controls.get(jobId);
    if (c) c.networkPaused = true;
    await this.#event(jobId, {
      status: JOB_STATUS.PAUSED,
      note: `paused: network unavailable (${reason}); will retry on resume`,
      meta: { pauseReason: "network", reason },
    });
    await this.#holdGate(jobId);
  }

  async #event(jobId, payload) {
    const rec = await this.jobStore.jobEvent(jobId, payload);
    // Surface every status transition over SSE (incl. WAITING + its reason), so
    // the dashboard reflects acquisition/recovery waits without waiting for the
    // next poll. Consumers debounce the resulting refresh.
    if (payload?.status) {
      const job = this.getJob(jobId);
      if (job?.kind === "training") {
        this.telemetry.noteJob({
          jobId,
          status: payload.status,
          phase: payload.phase ?? null,
          note: payload.note ?? null,
          at: this.clock(),
        });
      }
      this.changeFeed?.emit("job.status", {
        jobId,
        status: payload.status,
        phase: payload.phase ?? null,
        waitingReason: payload.meta?.waitingReason ?? null,
        acquisitionState: payload.meta?.acquisitionState ?? null,
        progress: payload.meta?.progress ?? null,
      });
    }
    return rec;
  }

  /** Event write that must never abort the loop it is reporting on. */
  async #safeEvent(jobId, payload) {
    try {
      await this.#event(jobId, payload);
    } catch (_e) {
      // Non-fatal: the outcome is still returned to the caller / logged.
    }
  }

  /** True once a job has run longer than JOBS_MAX_RUNTIME_MS (0 = unbounded). */
  #runtimeExceeded(startedAt) {
    const max = config.jobs.maxRuntimeMs;
    if (!(max > 0)) return false;
    return this.clock() - startedAt >= max;
  }

  #progress(jobId, progress, { force = false } = {}) {
    const now = this.clock();
    const last = this.lastProgressAt.get(jobId) ?? 0;
    if (!force && now - last < 500) return;
    this.lastProgressAt.set(jobId, now);
    void this.#event(jobId, { progress }).catch(() => {});
    this.changeFeed?.emit("job.progress", { jobId, progress });
  }

  /** Cooperative gate: immediate when stopping, else waits `ms` (interruptible). */
  #gate(jobId, ms) {
    const c = this.controls.get(jobId);
    if (!c) return Promise.reject(abortError());
    if (c.controller.signal.aborted) return Promise.reject(abortError());
    if (c.shouldStop) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = (fn, arg) => {
        clearTimeout(timer);
        clearInterval(interval);
        c.controller.signal.removeEventListener("abort", onAbort);
        fn(arg);
      };
      const timer = setTimeout(() => finish(resolve), Math.max(0, ms));
      // Wake early on stop OR an operator pause request, so a pause requested
      // while waiting (e.g. training's 60s material poll) reaches the loop's
      // safe boundary promptly instead of after the full interval.
      const interval = setInterval(() => {
        if (c.shouldStop || c.shouldPause) finish(resolve);
      }, 200);
      interval.unref?.();
      const onAbort = () => finish(reject, abortError());
      c.controller.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  #waitFor(promise, ms) {
    return Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), ms);
        t.unref?.();
      }),
    ]);
  }

  // ------------------------------------------------------------ reconcile
  /**
   * Resolve jobs the previous process left non-terminal.
   *
   * The ONLY things that may stop a perpetual operation are deliberate operator
   * actions: an explicit stop becomes `stopped`, and an explicit pause becomes
   * `paused` (never silently resumed). Everything else is recovered:
   *
   *   - continuous learning/training resume from durable state (the learning
   *     loop honours its persisted `nextAttemptAt`; training re-checks material
   *     and the RUN.lock before starting a new run);
   *   - a review drain/continuous job resumes so a backlog can never be left
   *     half-reviewed by a restart;
   *   - an automatic network pause is cleared (it was not operator intent);
   *   - one-shot work keeps the honest diagnostic: completed when the underlying
   *     work actually finished before the crash, interrupted otherwise.
   */
  async reconcile() {
    const active = this.jobStore.activeJobs();
    for (const job of active) {
      // Operator intent is durable. Normalise a half-finished stop/pause to its
      // terminal/steady state instead of reporting an "interruption".
      if (job.status === JOB_STATUS.STOP_REQUESTED || job.status === JOB_STATUS.STOPPING) {
        await this.#event(job.jobId, {
          status: JOB_STATUS.STOPPED,
          note: "operator stop preserved across restart",
        });
        this.changeFeed?.emit("job.status", { jobId: job.jobId, status: JOB_STATUS.STOPPED, recovered: true });
        continue;
      }
      if (job.status === JOB_STATUS.PAUSE_REQUESTED) {
        await this.#event(job.jobId, {
          status: JOB_STATUS.PAUSED,
          note: "operator pause preserved across restart; resume to continue",
          meta: { pauseReason: "operator" },
        });
        this.changeFeed?.emit("job.status", { jobId: job.jobId, status: JOB_STATUS.PAUSED, recovered: true });
        continue;
      }
      if (job.status === JOB_STATUS.PAUSED) {
        // Provenance is explicit on new pauses; fall back to the historical note
        // for a job paused by an older process before this field existed.
        const pauseReason =
          job.meta?.pauseReason ??
          (/^paused: network unavailable/.test(String(job.note ?? "")) ? "network" : null);
        if (pauseReason === "network" && this.#autoResumable(job)) {
          this.#respawnContinuous(job);
          this.changeFeed?.emit("job.status", { jobId: job.jobId, status: JOB_STATUS.RUNNING, recovered: true, reason: "network-pause-cleared" });
          continue;
        }
        // A deliberate operator pause (or a legacy pause without provenance) is
        // left exactly where the operator put it.
        this.changeFeed?.emit("job.status", { jobId: job.jobId, status: JOB_STATUS.PAUSED, recovered: true });
        continue;
      }
      if (this.#autoResumable(job)) {
        if (job.kind === "training") await this.#repairOrphanedTrainingRun(job);
        this.#respawnContinuous(job);
        this.changeFeed?.emit("job.status", { jobId: job.jobId, status: JOB_STATUS.RUNNING, recovered: true, reason: "continuous-job-resumed" });
        continue;
      }
      let diag = { outcome: JOB_STATUS.INTERRUPTED, note: "process restarted while job was active" };
      try {
        if (job.kind === "training") diag = await this.#diagnoseTraining(job);
        else if (job.kind === "fresh-brain") diag = await this.#diagnoseFreshBrain(job);
      } catch (err) {
        diag = { outcome: JOB_STATUS.INTERRUPTED, note: `reconcile inspection failed: ${err.message}` };
      }
      await this.#event(job.jobId, {
        status: diag.outcome,
        note: diag.note,
        result: diag.result ?? null,
        error: diag.error ?? null,
      });
      this.changeFeed?.emit("job.status", { jobId: job.jobId, status: diag.outcome, recovered: true });
    }
    return active.map((j) => j.jobId);
  }

  /** Continuous work and finite review drains must survive a process restart. */
  #autoResumable(job) {
    if (!job) return false;
    if (job.kind === "review") return true;
    return job.mode === "continuous";
  }

  /**
   * Re-spawn a crash-interrupted worker. The job remains cancellable (a fresh
   * control), holds no execution resource while it is merely waiting (the loops
   * sleep in `#gate`), and never busy-loops because the persisted deadlines and
   * poll intervals gate the next unit of work.
   */
  #respawnContinuous(job) {
    if (this.closing) return;
    const control = {
      controller: new AbortController(),
      shouldStop: false,
      shouldPause: false,
      networkPaused: false,
      shutdown: false,
      promise: null,
    };
    this.controls.set(job.jobId, control);
    if (job.kind === "training") {
      this.telemetry.beginJob({ jobId: job.jobId, mode: job.mode, at: this.clock() });
    }
    control.promise = this.#run(job, job.params, control).finally(() => this.controls.delete(job.jobId));
    this.changeFeed?.emit("job.started", { jobId: job.jobId, kind: job.kind, mode: job.mode, recovered: true });
  }

  /**
   * A training process that died mid-run leaves a non-terminal run behind. Mark
   * it interrupted ONLY when no live process owns RUN.lock, then let the
   * resumed continuous job start its next run. A run owned by another live
   * co-operating process is left untouched (the resumed job waits for the lock).
   */
  async #repairOrphanedTrainingRun(job) {
    if (typeof this.registry?.listRuns !== "function") return null;
    const lock = typeof this.registry.runLockInfo === "function" ? this.registry.runLockInfo() : null;
    if (lock?.ownerAlive) return null;
    const startMs = Date.parse(job.createdAt) - 1000;
    const runs = this.registry
      .listRuns()
      .filter((r) => Number.isFinite(startMs) && Date.parse(r.startedAt) >= startMs)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    const run = runs[0];
    if (!run) return null;
    if (run.status === "promoted" || run.status === "rejected" || run.status === "failed") return run;
    await this.registry.runEvent(run.runId, {
      status: "failed",
      note: "interrupted: process restarted before completion; continuous job resumed",
    });
    return { ...run, status: "failed" };
  }

  async #diagnoseTraining(job) {
    const startMs = Date.parse(job.createdAt) - 1000;
    const runs = this.registry
      .listRuns()
      .filter((r) => Date.parse(r.startedAt) >= startMs)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    const run = runs[0];
    if (!run) {
      return { outcome: JOB_STATUS.INTERRUPTED, note: "restarted before a training run was registered" };
    }
    if (run.status === "promoted" || run.status === "rejected") {
      return {
        outcome: JOB_STATUS.COMPLETED,
        note: `run ${run.runId} already ${run.status} before restart; job marked completed (not interrupted)`,
        result: summarizeRunFromRegistry(run),
      };
    }
    if (run.status === "failed") {
      return {
        outcome: JOB_STATUS.FAILED,
        note: `run ${run.runId} failed before restart`,
        error: "training run failed before restart",
        result: { runId: run.runId },
      };
    }
    return {
      outcome: JOB_STATUS.INTERRUPTED,
      note: `run ${run.runId} was '${run.status}' at restart; reported interrupted`,
      result: { runId: run.runId, status: run.status },
    };
  }

  async #diagnoseFreshBrain(job) {
    const version = job.progress?.version;
    if (!version || typeof this.runPython !== "function") {
      return { outcome: JOB_STATUS.INTERRUPTED, note: "restarted before the fresh brain committed" };
    }
    const status = await this.runPython(["status"], { store: this.pythonStorePath ?? undefined, bin: this.pythonBin });
    const entry = (status.versions ?? []).find((v) => v.version === version);
    if (entry?.committed) {
      return { outcome: JOB_STATUS.COMPLETED, note: `fresh brain ${version} committed before restart`, result: { version, activated: false } };
    }
    return { outcome: JOB_STATUS.INTERRUPTED, note: `fresh brain ${version} did not commit before restart`, result: { version } };
  }

  async close({ graceMs = config.jobs.stopGraceMs, abortGraceMs = 2_000 } = {}) {
    if (this.closing) return;
    this.closing = true;

    const controls = [...this.controls.values()];
    for (const control of controls) {
      control.shutdown = true;
      control.shouldStop = true;
    }

    const wait = (ms) => new Promise((resolve) => {
      const timer = setTimeout(resolve, Math.max(0, ms));
      timer.unref?.();
    });
    const pending = () => [...this.controls.values()].map((c) => c.promise).filter(Boolean);
    const initial = pending();
    if (initial.length) await Promise.race([Promise.allSettled(initial), wait(graceMs)]);

    if (this.controls.size) {
      for (const control of this.controls.values()) {
        control.shutdown = true;
        control.shouldStop = true;
        control.controller.abort();
      }
      const forced = pending();
      if (forced.length) await Promise.race([Promise.allSettled(forced), wait(abortGraceMs)]);
    }

    this.telemetry.dispose();
    if (this.jobStore) await this.jobStore.close().catch(() => {});
  }
}

function summarizeLearning(r) {
  if (!r) return {};
  return {
    mode: r.mode,
    capability: r.capability,
    rawDocs: r.rawDocs,
    ingested: r.ingested,
    deduped: r.deduped,
    reviewed: r.reviewed,
    reviewRetired: r.reviewRetired ?? 0,
    reviewFailed: r.reviewFailed ?? 0,
    reviewSkippedCooldown: r.reviewSkippedCooldown ?? 0,
    reviewWaiting: Boolean(r.reviewWaiting),
    trainable: r.trainable,
    corpusCeiling: r.corpusCeiling ?? null,
    failures: r.failures?.length ?? 0,
    sourceExhausted: r.sourceExhausted,
    noUsefulDocuments: Boolean(r.noUsefulDocuments),
    admissionCapExhausted: Boolean(r.admissionCapExhausted),
    admissionCapDeferred: r.admissionCapDeferred ?? 0,
    admissionCapEpoch: r.admissionCapEpoch ?? null,
    admissionQuotaExhausted: Boolean(r.admissionQuotaExhausted),
    admissionQuotaDeferred: r.admissionQuotaDeferred ?? 0,
    admissionQuotaUsed: r.admissionQuotaUsed ?? null,
    admissionQuotaLimit: r.admissionQuotaLimit ?? null,
    admissionQuotaRetryAfterMs: r.admissionQuotaRetryAfterMs ?? null,
    admissionQuotaPolicyVersion: r.admissionQuotaPolicyVersion ?? null,
    // Authoritative acquisition classification + frontier state, so the UI and
    // the supervisor agree on "work / wait / exhausted" from one source.
    acquisition: r.acquisition ?? null,
    frontier: r.frontier ?? null,
    // Adapter/bootstrap observability: which sources ran, what they found, and
    // whether discovery was actually reachable this cycle.
    discovery: r.discovery ?? null,
  };
}

function summarizeRun(out, registry) {
  const run = out?.run ?? null;
  const decision = out?.decision ?? {};
  const promotionStatus = run?.promotionStatus ?? decision.decision ?? null;
  return {
    runId: run?.runId ?? null,
    status: run?.status ?? null,
    decision: decision.decision ?? null,
    promotionStatus,
    promoted: promotionStatus === "promoted",
    improvement: decision.improvement ?? decision.delta ?? null,
    resultModelId: run?.resultModelId ?? null,
    pythonVersion: run?.runLinkage?.pythonVersion ?? null,
    parentVersion: run?.runLinkage?.parentVersion ?? null,
    activatedVersion: run?.activatedVersion ?? null,
    activated: Boolean(run?.activatedVersion),
    baselineLoss: Number.isFinite(out?.baseline?.loss) ? out.baseline.loss : null,
    candidateLoss: Number.isFinite(out?.candidate?.loss) ? out.candidate.loss : null,
    articlesConsumed: run?.trainerNotes?.articlesConsumed ?? null,
  };
}

function summarizeRunFromRegistry(run) {
  return {
    runId: run.runId,
    status: run.status,
    promotionStatus: run.promotionStatus ?? run.status,
    promoted: (run.promotionStatus ?? run.status) === "promoted",
    resultModelId: run.resultModelId ?? null,
    pythonVersion: run.runLinkage?.pythonVersion ?? run.activatedVersion ?? null,
    parentVersion: run.runLinkage?.parentVersion ?? null,
    activatedVersion: run.activatedVersion ?? null,
    activated: Boolean(run.activatedVersion),
  };
}
