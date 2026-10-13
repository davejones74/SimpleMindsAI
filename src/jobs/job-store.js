import { createReadStream, createWriteStream, existsSync, mkdirSync } from "node:fs";
import readline from "node:readline";
import path from "node:path";

/**
 * JobStore — the append-only log for managed lifecycle jobs (learning,
 * training, fresh-brain).
 *
 * It lives in the SAME directory as the run registry so a job and the training
 * run it produced are durable together. Nothing is ever rewritten:
 *
 *   jobs.ndjson        one creation line per job (kind, mode, params)
 *   job-events.ndjson  status/phase/progress transitions
 *   job-log.ndjson     human-readable progress/output lines
 *
 * Current state is DERIVED by folding the event log over the creation line, so
 * a torn write or a process crash mid-append can never invent a state — the
 * supervisor reconciles non-terminal jobs on the next boot.
 */

export const JOB_STATUS = Object.freeze({
  QUEUED: "queued",
  RUNNING: "running",
  WAITING: "waiting-for-eligible",
  PAUSE_REQUESTED: "pause-requested",
  PAUSED: "paused",
  STOP_REQUESTED: "stop-requested",
  STOPPING: "stopping",
  STOPPED: "stopped",
  COMPLETED: "completed",
  FAILED: "failed",
  INTERRUPTED: "interrupted",
});

/** Terminal states never transition again and are never auto-resumed. */
export const TERMINAL_STATUSES = Object.freeze([
  JOB_STATUS.STOPPED,
  JOB_STATUS.COMPLETED,
  JOB_STATUS.FAILED,
  JOB_STATUS.INTERRUPTED,
]);

export function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}

/** Legal job status transitions, enforced at the mutation boundary.
 *
 * Transitions NOT in this map are rejected (return false) so that the
 * supervisor / API never appends a status change that would leave the
 * job in an inconsistent state.  Back‑compatible with existing persisted
 * job history: if the fromStatus is not recognised (older format) the
 * transition is permitted (lenient read of historic state).
 *
 * Transitions (from → to, one‑line legend):
 *   QUEUED      → RUNNING       (start)
 *   QUEUED      → STOP_REQUESTED (stopped before it began)
 *   RUNNING     → COMPLETED     (normal finish)
 *   RUNNING     → FAILED        (error)
 *   RUNNING     → INTERRUPTED   (process restart, reconcile)
 *   RUNNING     → PAUSE_REQUESTED (operator requests pause)
 *   RUNNING     → CANCEL_REQUESTED (operator requests cancel)
 *   RUNNING     → STOP_REQUESTED (operator requests stop)
 *   RUNNING     → STOPPED       (operator stops via API)
 *   WAITING_FOR_ELIGIBLE → RUNNING (material arrived)
 *   PAUSE_REQUESTED → PAUSED     (job reached safe boundary)
 *   PAUSE_REQUESTED → RUNNING    (pause cancelled before the boundary)
 *   PAUSED      → RUNNING       (operator resumes)
 *   PAUSED      → STOP_REQUESTED (operator stops a paused job)
 *   All other from→to combinations are rejected.
 */
const LEGAL_TRANSITIONS = Object.freeze({
  // FROM    TO
  "queued":    new Set(["running", "stop-requested", "stopped", "failed"]),
  "running":   new Set(["completed", "failed", "interrupted", "pause-requested", "cancel-requested", "stop-requested", "stopped"]),
  "waiting-for-eligible": new Set(["running", "completed", "failed", "interrupted", "pause-requested", "stop-requested", "stopped"]),
  "pause-requested": new Set(["paused", "running", "stop-requested", "stopped", "failed", "interrupted"]),
  "paused":    new Set(["running", "stop-requested", "stopped", "failed", "interrupted"]),
  cancelled:   new Set([]), // terminal; no further transitions
  stopped:     new Set([]), // terminal
  completed:   new Set([]), // terminal
  failed:      new Set([]), // terminal
  interrupted: new Set([]), // terminal
});

export function validateTransition(fromStatus, toStatus) {
  // Lenient: unknown fromStatus (older persisted format) permits the transition
  if (!(fromStatus in LEGAL_TRANSITIONS)) return true;
  const allowed = LEGAL_TRANSITIONS[fromStatus];
  if (!allowed) return false;
  return allowed.has(toStatus);
}

const COLLECTIONS = {
  jobs: "jobs.ndjson",
  events: "job-events.ndjson",
  log: "job-log.ndjson",
};

const LOG_MEMORY_CAP = 5000;

export class JobStore {
  static async open(dir = process.env.REGISTRY_DIR ?? path.resolve("data", "registry"), { readOnly = false } = {}) {
    const s = new JobStore(dir, { readOnly });
    await s.#loadFromDisk();
    return s;
  }

  #streams;
  #logs = new Map(); // jobId -> [log lines]

  constructor(dir, { readOnly = false } = {}) {
    this.dir = dir;
    this.readOnly = readOnly;
    if (!readOnly) mkdirSync(dir, { recursive: true });
    this.jobs = new Map(); // jobId -> creation record
    this.events = new Map(); // jobId -> [event]
    this.#streams = {};
    if (!readOnly) {
      for (const name of Object.keys(COLLECTIONS)) {
        this.#streams[name] = createWriteStream(path.join(dir, COLLECTIONS[name]), { flags: "a" });
      }
    }
  }

  #assertWritable() {
    if (this.readOnly) throw new Error("JobStore is read-only (inspection workspace)");
  }

  async #loadFromDisk() {
    const lines = async (file) => {
      const p = path.join(this.dir, file);
      const out = [];
      if (!existsSync(p)) return out;
      const rl = readline.createInterface({ input: createReadStream(p), crlfDelay: Infinity });
      for await (const raw of rl) {
        if (!raw.trim()) continue;
        try {
          out.push(JSON.parse(raw));
        } catch {
          /* skip corrupt tail */
        }
      }
      return out;
    };
    for (const rec of await lines(COLLECTIONS.jobs)) this.jobs.set(rec.jobId, rec);
    for (const rec of await lines(COLLECTIONS.events)) {
      const arr = this.events.get(rec.jobId) ?? [];
      arr.push(rec);
      this.events.set(rec.jobId, arr);
    }
    for (const rec of await lines(COLLECTIONS.log)) {
      const arr = this.#logs.get(rec.jobId) ?? [];
      arr.push(rec);
      if (arr.length > LOG_MEMORY_CAP) arr.splice(0, arr.length - LOG_MEMORY_CAP);
      this.#logs.set(rec.jobId, arr);
    }
  }

  #awaitWrite(ws, chunk) {
    return new Promise((resolve, reject) => {
      if (ws.write(chunk)) return resolve();
      ws.once("drain", resolve);
      ws.once("error", reject);
    });
  }

  #persist(name, record) {
    this.#assertWritable();
    return this.#awaitWrite(this.#streams[name], JSON.stringify(record) + "\n");
  }

  async close() {
    const wait = (ws) =>
      new Promise((resolve) => {
        ws.once("finish", resolve);
        ws.once("error", resolve);
        ws.end();
      });
    await Promise.all(Object.values(this.#streams).filter((ws) => !ws.writableEnded).map(wait));
  }

  // ---------------------------------------------------------------- jobs
  nextJobId() {
    return `job-${this.jobs.size + 1}`;
  }

  async createJob({ kind, title = null, mode = "bounded", params = {}, requestedBy = "operator" }) {
    this.#assertWritable();
    const jobId = this.nextJobId();
    const rec = {
      jobId,
      kind,
      title: title ?? kind,
      mode,
      params,
      requestedBy,
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(jobId, rec);
    await this.#persist("jobs", rec);
    return rec;
  }

  async jobEvent(jobId, { status = null, phase = null, progress = null, note = null, result = null, error = null } = {}) {
    this.#assertWritable();
    if (!this.jobs.has(jobId)) throw new Error(`unknown job ${jobId}`);
    const rec = { jobId, at: new Date().toISOString() };
    if (status !== null) rec.status = status;
    if (phase !== null) rec.phase = phase;
    if (progress !== null) rec.progress = progress;
    if (note !== null) rec.note = note;
    if (result !== null) rec.result = result;
    if (error !== null) rec.error = error;
    const arr = this.events.get(jobId) ?? [];
    arr.push(rec);
    this.events.set(jobId, arr);
    await this.#persist("events", rec);
    return rec;
  }

  async appendLog(jobId, { stream = "out", text }) {
    this.#assertWritable();
    if (!this.jobs.has(jobId)) throw new Error(`unknown job ${jobId}`);
    const rec = { jobId, at: new Date().toISOString(), stream, text: String(text ?? "") };
    const arr = this.#logs.get(jobId) ?? [];
    arr.push(rec);
    if (arr.length > LOG_MEMORY_CAP) arr.splice(0, arr.length - LOG_MEMORY_CAP);
    this.#logs.set(jobId, arr);
    await this.#persist("log", rec);
  }

  /** Derive the current job view by folding events over the creation line. */
  getJob(jobId) {
    const base = this.jobs.get(jobId);
    if (!base) return null;
    const events = this.events.get(jobId) ?? [];
    let status = JOB_STATUS.QUEUED;
    let phase = null;
    let progress = null;
    let note = null;
    let result = null;
    let error = null;
    let updatedAt = base.createdAt;
    for (const e of events) {
      if (e.status) status = e.status;
      if (e.phase !== undefined) phase = e.phase;
      if (e.progress !== undefined) progress = e.progress;
      if (e.note !== undefined) note = e.note;
      if (e.result !== undefined) result = e.result;
      if (e.error !== undefined) error = e.error;
      updatedAt = e.at;
    }
    return { ...base, status, phase, progress, note, result, error, updatedAt, terminal: isTerminal(status) };
  }

  listJobs() {
    return [...this.jobs.keys()].map((id) => this.getJob(id));
  }

  getLog(jobId, { limit = 500 } = {}) {
    const arr = this.#logs.get(jobId) ?? [];
    return limit && arr.length > limit ? arr.slice(-limit) : [...arr];
  }

  /** Non-terminal jobs — the set the supervisor must reconcile on boot. */
  activeJobs() {
    return this.listJobs().filter((j) => !j.terminal);
  }
}
