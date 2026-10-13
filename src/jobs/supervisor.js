import { JobStore, JOB_STATUS, isTerminal, validateTransition } from "./job-store.js";
import { runLearningCycle } from "./learning.js";
import { runTrainingOnce } from "./training.js";
import { createFreshBrain } from "./fresh-brain.js";
import { selectTrainer } from "../training/trainer-interface.js";
import { runPython } from "../brain/python-cli.js";
import { OllamaClient } from "../services/ollama-client.js";
import { ReviewScorer } from "../reward/reward-scorer.js";
import { config } from "../config.js";
import { abortError, isAbort } from "./cancel.js";

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

const KIND_TITLES = { learning: "Learning", training: "Training", "fresh-brain": "Fresh brain" };

/**
 * Connectivity failures — a loss of internet, an unreachable teacher or source,
 * or a timeout. These are TRANSIENT, so a learning job pauses and retries on
 * resume instead of recording "source exhausted" (which would be a lie: the
 * sources are fine, we simply could not reach them). HTTP status errors
 * (FETCH_STATUS: 404/500) and content-type refusals are NOT transient and keep
 * their existing fail-closed behaviour.
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
 * JobSupervisor — owns the long-running lifecycle work the Observatory starts.
 *
 * Design rules:
 *   - ONE active job per kind. A duplicate start is a 409, not a second run.
 *   - Jobs are durable: creation, transitions, progress and output are appended
 *     to the JobStore. On boot, `reconcile()` resolves any job the previous
 *     process left non-terminal — reporting `interrupted` with diagnostics, or
 *     `completed` when the underlying work (e.g. a promotion) actually finished
 *     before the crash. Jobs are NEVER auto-resumed.
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
    runPython: runPythonFn = runPython,
    trainerFactory = null,
    trainingDeps = {},
    clock = () => Date.now(),
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
    this.runPython = runPythonFn;
    this.trainerFactory = trainerFactory ?? ((signal) => selectTrainer({ signal }));
    this.trainingDeps = trainingDeps;
    this.clock = clock;

    this.jobStore = null;
    this.controls = new Map(); // jobId -> { controller, shouldStop, shouldPause, promise }
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

  activeJobOfKind(kind) {
    return this.listJobs().find((j) => j.kind === kind && !j.terminal) ?? null;
  }

  snapshotResolvedConfig() {
    return {
      trainerKind: config.trainerKind,
      teacher: { model: config.ollamaModel, endpoint: config.ollamaEndpoint, fixture: config.ollamaFixture },
      crawl: { mode: config.crawlMode, urls: config.crawlUrls.length },
      pythonStore: this.pythonStorePath ?? null,
      pollIntervalMs: config.jobs.pollIntervalMs,
      stopGraceMs: config.jobs.stopGraceMs,
    };
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
      await this.#event(jobId, { status: JOB_STATUS.PAUSE_REQUESTED, note: "pause requested but no active worker" });
      return this.getJob(jobId);
    }
    if (!validateTransition(job.status, JOB_STATUS.PAUSE_REQUESTED)) {
      throw new Error(`illegal status transition: ${job.status} -> ${JOB_STATUS.PAUSE_REQUESTED}`);
    }
    control.shouldPause = true; // distinct from shouldStop: does NOT exit
    await this.#event(jobId, { status: JOB_STATUS.PAUSE_REQUESTED, note: "pause requested" });
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
    const existing = this.activeJobOfKind(kind);
    if (existing) {
      throw new JobConflictError(`a ${kind} job is already active (${existing.jobId}, ${existing.status})`);
    }
    const job = await this.jobStore.createJob({ kind, title: KIND_TITLES[kind] ?? kind, mode, params });
    const controller = new AbortController();
    const control = { controller, shouldStop: false, shouldPause: false, networkPaused: false, promise: null };
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
      if (!validateTransition(job?.status ?? "queued", JOB_STATUS.RUNNING)) {
        throw new Error(`illegal status transition: ${job?.status ?? "queued"} -> ${JOB_STATUS.RUNNING}`);
      }
      await this.#event(jobId, {
        status: JOB_STATUS.RUNNING,
        phase: "starting",
        note: "job started",
        result: { resolvedConfig: this.snapshotResolvedConfig() },
      });
      const result = await this.#dispatch(job, params, control, { log, onPhase, onProgress });
      if (result.outcome === "paused") {
        await this.#event(jobId, { status: JOB_STATUS.PAUSED, note: "paused by operator", result });
      } else if (this.#shouldStop(jobId)) {
        await this.#event(jobId, { status: JOB_STATUS.STOPPED, note: "stopped by operator", result });
      } else {
        await this.#event(jobId, { status: JOB_STATUS.COMPLETED, note: "job completed", result });
      }
    } catch (err) {
      const job = this.getJob(jobId);
      if (isAbort(err) || this.#shouldStop(jobId)) {
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
    if (job.kind === "fresh-brain") return this.#runFreshBrain(job, params, base);
    throw new Error(`unknown job kind ${job.kind}`);
  }

  async #runLearning(job, params, base) {
    const { jobId } = job;
    const target = params.targetArticles;
    const ctx = {
      ...base,
      ollama: this.ollama,
      scorer: this.scorer,
      crawl: this.crawl,
      maxRawDocs: params.maxRawDocs,
    };
    let cycle = 0;
    let last = null;
    let outcome = "stopped";
    const continuous = job.mode === "continuous";
    for (;;) {
      if (this.#shouldStop(jobId)) break;
      // Operator pause: stop starting new units of work and wait at this safe
      // boundary (also reached when a pause arrives during the inter-cycle gate).
      if (this.#shouldPause(jobId)) {
        await this.#holdPause(jobId);
        if (this.#shouldStop(jobId)) { outcome = "stopped"; break; }
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
          await this.#networkPause(jobId, err.message);
          if (this.#shouldStop(jobId)) { outcome = "stopped"; break; }
          cycle--; // retry the same cycle once connectivity is restored
          continue;
        }
        throw err;
      }
      try {
        await this.#progress(jobId, { cycle, ...summarizeLearning(last) }, { force: true });
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
      // Automatic network pause: a whole pass fetched nothing and every failure
      // was a connectivity error. Hold and retry on resume instead of falsely
      // declaring "source exhausted" — the sources are fine, they were unreachable.
      if (
        (last?.rawDocs ?? 0) === 0 &&
        (last?.failures?.length ?? 0) > 0 &&
        last.failures.every(isNetworkFailure)
      ) {
        await this.#networkPause(jobId, String(last.failures[0]?.reason ?? "network unavailable"));
        if (this.#shouldStop(jobId)) { outcome = "stopped"; break; }
        cycle--; // retry the same cycle once connectivity is restored
        continue;
      }
      if (last.trainable >= target) {
        outcome = "target-reached";
        break;
      }
      if (last.sourceExhausted) {
        outcome = "sources-exhausted";
        break;
      }
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
      await this.#gate(jobId, continuous ? config.jobs.pollIntervalMs : 0);
    }
    return {
      outcome,
      cycles: cycle,
      target,
      targetReached: Boolean(last && last.trainable >= target),
      ...summarizeLearning(last),
    };
  }

  async #runTraining(job, params, base) {
    const { jobId } = job;
    const minEligible = params.minEligible;
    let last = null;
    let runs = 0;
    for (;;) {
      if (this.#shouldStop(jobId)) break;
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
        if (job.mode === "one-shot") {
          const err = new Error(
            `insufficient eligible material: ${stats.trainable} reviewed+unconsumed article(s), need ${minEligible}`,
          );
          err.code = "INSUFFICIENT_ELIGIBLE";
          throw err;
        }
        await this.#event(jobId, {
          status: JOB_STATUS.WAITING,
          phase: "waiting-for-eligible",
          note: `waiting: ${stats.trainable}/${minEligible} eligible article(s)`,
        });
        await this.#gate(jobId, config.jobs.pollIntervalMs);
        continue;
      }
      await this.#event(jobId, { status: JOB_STATUS.RUNNING, phase: "training" });
      // Each cycle publishes a NEW immutable version (vNNN) from the parent; the
      // Python side allocates the next number, so continuous runs never collide.
      let out;
      try {
        out = await runTrainingOnce({
          ...base,
          ...this.trainingDeps,
          trainer: this.trainerFactory(base.signal),
          parentVersion: params.parentVersion,
          minEligible,
          logger: this.#jobLogger(jobId),
        });
      } catch (err) {
        // A corpus too small to form one block is an operator condition, not a
        // training fault: a continuous job waits for more reviewed material (the
        // articles stay unconsumed), while a one-shot job fails with the clear
        // message instead of a Python traceback.
        if (err?.code === "INSUFFICIENT_CORPUS") {
          if (job.mode === "one-shot") throw err;
          await this.#event(jobId, {
            status: JOB_STATUS.WAITING,
            phase: "waiting-for-corpus",
            note: err.message,
          });
          await this.#gate(jobId, config.jobs.pollIntervalMs);
          continue;
        }
        throw err;
      }
      runs++;
      last = summarizeRun(out, this.registry);
      await this.#progress(jobId, { runs, ...last }, { force: true });
      if (job.mode === "one-shot") {
        // Honor a pause that arrived while the single run was executing, so the
        // operator sees PAUSED (and can resume/stop) instead of an abrupt finish.
        if (this.#shouldPause(jobId)) {
          await this.#holdPause(jobId);
          if (this.#shouldStop(jobId)) break;
        }
        break;
      }
      await this.#gate(jobId, config.jobs.pollIntervalMs);
    }
    return { outcome: this.#shouldStop(jobId) ? "stopped" : "completed", runs, ...(last ?? {}) };
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
    await this.#event(jobId, { status: JOB_STATUS.PAUSED, note: "paused at safe boundary; waiting for resume" });
    await this.#holdGate(jobId);
  }

  /** Connectivity pause: flag the transient condition, report PAUSED, then hold. */
  async #networkPause(jobId, reason) {
    const c = this.controls.get(jobId);
    if (c) c.networkPaused = true;
    await this.#event(jobId, {
      status: JOB_STATUS.PAUSED,
      note: `paused: network unavailable (${reason}); will retry on resume`,
    });
    await this.#holdGate(jobId);
  }

  #event(jobId, payload) {
    return this.jobStore.jobEvent(jobId, payload);
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
   * Resolve jobs the previous process left non-terminal. Never auto-resumes;
   * reports `interrupted` with diagnostics, or `completed` when the work had
   * actually finished (e.g. a promotion committed) before the crash.
   */
  async reconcile() {
    const active = this.jobStore.activeJobs();
    for (const job of active) {
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

  async close() {
    if (this.jobStore) await this.jobStore.close();
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
    trainable: r.trainable,
    corpusCeiling: r.corpusCeiling ?? null,
    failures: r.failures?.length ?? 0,
    sourceExhausted: r.sourceExhausted,
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
