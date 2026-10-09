import { createWriteStream, createReadStream, existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync, appendFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import readline from "node:readline";
import os from "node:os";
import path from "node:path";

/**
 * RegistryStore — the DURABLE side of the system. Everything here is
 * append-only; nothing is ever rewritten or deleted, which is what makes the
 * answer to "what produced this model?" reconstructable forever.
 *
 *   snapshots.ndjson     dataset snapshot manifests (immutable files on disk)
 *   models.ndjson        model/checkpoint registrations
 *   model-events.ndjson  model status transitions (candidate->promoted/rejected)
 *   runs.ndjson          TrainingRun registrations (one line per run)
 *   run-events.ndjson    run status transitions (created/running/evaluating/...)
 *   evaluations.ndjson   aggregate evaluation results
 *   evaluations/*.ndjson per-example evaluation detail (for regression digging)
 *
 * Status is derived: current run status = last run-events entry; current model
 * status = last model-events entry. Historical lines are never mutated.
 */
const COLLECTIONS = {
  snapshots: "snapshots.ndjson",
  models: "models.ndjson",
  modelEvents: "model-events.ndjson",
  runs: "runs.ndjson",
  runEvents: "run-events.ndjson",
  evaluations: "evaluations.ndjson",
};

const RECOVERIES_FILE = "lock-recoveries.ndjson";

export class RegistryStore {
  static async open(dir = process.env.REGISTRY_DIR ?? path.resolve("data", "registry")) {
    const s = new RegistryStore(dir);
    await s.#loadFromDisk();
    return s;
  }

  #streams;
  #lockRecord = null;
  #lockTimer = null;

  constructor(dir) {
    this.dir = dir;
    mkdirSync(`${dir}/evaluations`, { recursive: true });
    this.snapshots = [];
    this.models = new Map(); // modelId -> static registration record
    this.modelEvents = new Map();
    this.runs = new Map();
    this.runEvents = new Map();
    this.evaluations = [];

    this.#streams = {};
    for (const name of Object.keys(COLLECTIONS)) {
      this.#streams[name] = createWriteStream(path.join(dir, COLLECTIONS[name]), { flags: "a" });
    }
  }

  async #loadFromDisk() {
    const lines = async (file) => {
      const p = path.join(this.dir, file);
      const out = [];
      if (!existsSync(p)) return out;
      const rl = readline.createInterface({ input: createReadStream(p), crlfDelay: Infinity });
      for await (const raw of rl) {
        if (!raw.trim()) continue;
        try { out.push(JSON.parse(raw)); } catch {}
      }
      return out;
    };
    for (const rec of await lines(COLLECTIONS.snapshots)) this.snapshots.push(rec);
    for (const rec of await lines(COLLECTIONS.models)) this.models.set(rec.modelId, rec);
    for (const rec of await lines(COLLECTIONS.modelEvents)) {
      const arr = this.modelEvents.get(rec.modelId) ?? [];
      arr.push(rec);
      this.modelEvents.set(rec.modelId, arr);
    }
    for (const rec of await lines(COLLECTIONS.runs)) this.runs.set(rec.runId, rec);
    for (const rec of await lines(COLLECTIONS.runEvents)) {
      const arr = this.runEvents.get(rec.runId) ?? [];
      arr.push(rec);
      this.runEvents.set(rec.runId, arr);
    }
    for (const rec of await lines(COLLECTIONS.evaluations)) this.evaluations.push(rec);
  }

  #awaitWrite(ws, chunk) {
    return new Promise((resolve, reject) => {
      if (ws.write(chunk)) return resolve();
      ws.once("drain", resolve);
      ws.once("error", reject);
    });
  }

  #persist(name, record) {
    return this.#awaitWrite(this.#streams[name], JSON.stringify(record) + "\n");
  }

  async close() {
    const wait = (ws) =>
      new Promise((resolve) => { ws.once("finish", resolve); ws.once("error", resolve); ws.end(); });
    await Promise.all(Object.values(this.#streams).filter((ws) => !ws.writableEnded).map(wait));
  }

  // ---------------------------------------------------------------- ids
  nextModelId() { return `model-${this.models.size + 1}`; }
  nextRunId() { return `run-${this.runs.size + 1}`; }
  nextEvalId() { return `eval-${this.evaluations.length + 1}`; }
  nextDatasetId() {
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
    const seq = this.snapshots.filter((s) => s.datasetId.includes(stamp)).length + 1;
    return `dataset-${stamp}-${String(seq).padStart(3, "0")}`;
  }
  static hashFile(filePath, content) {
    const data = content ?? undefined;
    if (data !== undefined) return createHash("sha256").update(Buffer.isBuffer(data) ? data : data).digest("hex");
    return createHash("sha256").update(filePath).digest("hex");
  }

  // ------------------------------------------------------- snapshots
  async createSnapshot(manifest) {
    const rec = { id: randomUUID().slice(0, 8), createdAt: new Date().toISOString(), ...manifest };
    this.snapshots.push(rec);
    await this.#persist("snapshots", rec);
    return rec;
  }
  listSnapshots() { return [...this.snapshots]; }
  getSnapshot(datasetId) { return this.snapshots.find((s) => s.datasetId === datasetId) ?? null; }

  // ---------------------------------------------------------- models
  async registerModel({ kind, baseModel, parentModelId = null, trainingRunId = null, datasetId = null, checkpointPath = null, meta = {} }) {
    const modelId = this.nextModelId();
    const rec = { modelId, kind, baseModel, parentModelId, trainingRunId, datasetId, checkpointPath, meta, createdAt: new Date().toISOString(), status: "candidate" };
    this.models.set(modelId, rec);
    await this.#persist("models", rec);
    return this.getModel(modelId);
  }

  async modelEvent(modelId, { status = "candidate", evaluationScore = null, evalRunId = null, note = null }) {
    if (!this.models.has(modelId)) throw new Error(`unknown model ${modelId}`);
    const rec = { modelId, status, evaluationScore, evalRunId, at: new Date().toISOString(), note };
    const arr = this.modelEvents.get(modelId) ?? [];
    arr.push(rec);
    this.modelEvents.set(modelId, arr);
    await this.#persist("modelEvents", rec);
    return rec;
  }

  getModel(modelId) {
    const base = this.models.get(modelId);
    if (!base) return null;
    const events = this.modelEvents.get(modelId) ?? [];
    const last = events.at(-1);
    let evaluationScore = last?.evaluationScore ?? null;
    let evalRunId = last?.evalRunId ?? null;
    let status = last?.status ?? "candidate";
    // A registered model without any event is a candidate by definition.
    if (!events.length) status = "candidate";
    return { ...base, status, evaluationScore, evalRunId };
  }

  listModels() { return [...this.models.keys()].map((id) => this.getModel(id)); }

  /** The current brain: latest model that reached status "promoted". */
  getActiveModel() {
    const promoted = this.listModels().filter((m) => m.status === "promoted");
    if (!promoted.length) return null;
    return promoted.sort((a, b) => (a.createdAt > b.createdAt ? 1 : -1)).at(-1);
  }

  // ------------------------------------------------------------ runs
  async createRun(input) {
    const runId = this.nextRunId();
    const rec = { runId, status: "created", startedAt: new Date().toISOString(), completedAt: null, ...input };
    this.runs.set(runId, rec);
    await this.#persist("runs", rec);
    await this.runEvent(runId, { status: "created" });
    return this.getRun(runId);
  }

  async runEvent(runId, { status, note = null }) {
    if (!this.runs.has(runId)) throw new Error(`unknown run ${runId}`);
    const rec = { runId, status, at: new Date().toISOString(), note };
    const arr = this.runEvents.get(runId) ?? [];
    arr.push(rec);
    this.runEvents.set(runId, arr);
    await this.#persist("runEvents", rec);
    return rec;
  }

  async completeRun(runId, { status, ...patch }) {
    // Patch the static registration line's mutable-fields view but ALWAYS
    // record the terminal state as an event — the historical line is untouched.
    const base = this.runs.get(runId);
    if (!base) throw new Error(`unknown run ${runId}`);
    this.runs.set(runId, { ...base, status, completedAt: new Date().toISOString(), ...patch });
    await this.runEvent(runId, { status, note: `run ${status}` });
    return this.getRun(runId);
  }

  getRun(runId) {
    const base = this.runs.get(runId);
    if (!base) return null;
    const events = this.runEvents.get(runId) ?? [];
    const status = events.at(-1)?.status ?? base.status;
    return { ...base, status, events };
  }
  listRuns() { return [...this.runs.keys()].map((id) => this.getRun(id)); }

  /**
   * Crash recovery: any run stuck in created/running/evaluating with no
   * completion within `graceMs` is marked failed (interrupted). This is a status
   * transition, not a rewrite — the historical creation line stays intact.
   */
  async recoverStaleRuns(graceMs = 10 * 60 * 1000) {
    const now = Date.now();
    const staleIds = [];
    for (const run of this.listRuns()) {
      if (run.status === "promoted" || run.status === "rejected" || run.status === "failed") continue;
      const started = new Date(run.startedAt).getTime();
      if (now - started > graceMs) staleIds.push(run.runId);
    }
    for (const id of staleIds) {
      await this.runEvent(id, { status: "failed", note: "interrupted (no completion within grace) — recovered on restart" });
    }
    return staleIds;
  }

  // ------------------------------------------------------ evaluation
  async recordEvaluation(rec) {
    this.evaluations.push(rec);
    await this.#persist("evaluations", rec);
    return rec;
  }
  listEvaluations() { return [...this.evaluations]; }
  getEvaluation(id) { return this.evaluations.find((e) => e.evalRunId === id) ?? null; }

  // ------------------------------------------------------------ lock
  /**
   * Single-trainer lock with an owner identity + heartbeat.
   *
   * `openSync(path, 'wx')` is atomic, so a second lifecycle aborts instead of
   * racing the same dataset. The lock record carries `{pid, host, token, runId,
   * acquiredAt, heartbeatAt}`; a live process refreshes `heartbeatAt`
   * (unref'd timer) so it can never lose its own lock. A lock is only reclaimed
   * once its heartbeat is older than `staleMs` AND its owner is verifiably gone
   * (same host + dead pid). Every reclaim/refusal is appended to
   * `lock-recoveries.ndjson` for durability, and only the run named in the
   * reclaimed lock is marked interrupted — unrelated non-terminal runs are
   * never failed just because a new process acquired the lock.
   */
  lockPath() { return path.join(this.dir, "RUN.lock"); }

  #readLock() {
    try {
      const raw = readFileSync(this.lockPath(), "utf8").trim();
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          if (!parsed.heartbeatAt) parsed.heartbeatAt = parsed.acquiredAt ?? null;
          return parsed;
        }
      } catch { /* legacy numeric-timestamp lock */ }
      const legacy = Number(raw.split("\n")[0]);
      return Number.isFinite(legacy)
        ? { pid: null, host: null, token: null, runId: null, acquiredAt: new Date(legacy).toISOString(), heartbeatAt: new Date(legacy).toISOString() }
        : null;
    } catch { return null; }
  }

  #heartbeatAgeMs(lock) {
    const t = Date.parse(lock?.heartbeatAt ?? "");
    return Number.isFinite(t) ? Date.now() - t : Number.POSITIVE_INFINITY;
  }

  /** True only when the recorded owner is on this host and still alive. */
  #isLockOwnerAlive(lock) {
    if (!lock) return false;
    // Legacy/unknown owner (no pid/host) ⇒ abandoned, safe to reclaim.
    if (!Number.isInteger(lock.pid) || !lock.host) return false;
    // Foreign host ⇒ we cannot verify liveness, so never steal it (fail safe).
    if (lock.host !== os.hostname()) return true;
    try { process.kill(lock.pid, 0); return true; }
    catch (err) { return err.code === "EPERM"; }
  }

  #startLockHeartbeat(staleMs) {
    this.#stopLockHeartbeat();
    const interval = Math.max(1000, Math.floor(staleMs / 3));
    this.#lockTimer = setInterval(() => {
      if (!this.#lockRecord) return;
      try {
        const current = this.#readLock();
        if (current && current.token && current.token !== this.#lockRecord.token) return; // no longer ours
        const next = { ...this.#lockRecord, heartbeatAt: new Date().toISOString() };
        writeFileSync(this.lockPath(), JSON.stringify(next));
        this.#lockRecord = next;
      } catch { /* heartbeat is best-effort */ }
    }, interval);
    this.#lockTimer.unref?.();
  }

  #stopLockHeartbeat() {
    if (this.#lockTimer) { clearInterval(this.#lockTimer); this.#lockTimer = null; }
    this.#lockRecord = null;
  }

  async #recordRecovery(record) {
    try {
      appendFileSync(path.join(this.dir, RECOVERIES_FILE), `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
    } catch { /* recovery log is best-effort durable */ }
  }

  listLockRecoveries() {
    const p = path.join(this.dir, RECOVERIES_FILE);
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8").split("\n").filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }

  async acquireRunLock(staleMs = 10 * 60 * 1000, { runId = null, attempt = 0 } = {}) {
    const owner = {
      pid: process.pid,
      host: os.hostname(),
      token: randomUUID(),
      runId,
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    };
    try {
      writeFileSync(this.lockPath(), JSON.stringify(owner), { flag: "wx" });
      this.#lockRecord = owner;
      this.#startLockHeartbeat(staleMs);
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (attempt >= 3) return false; // pathological churn — give up this round
      const held = this.#readLock();
      const age = this.#heartbeatAgeMs(held);
      if (age <= staleMs) return false; // fresh enough: an active trainer holds it
      if (this.#isLockOwnerAlive(held)) {
        await this.#recordRecovery({ action: "deferred", reason: "lock heartbeat expired but owner is still alive", held });
        return false; // never steal a live owner's lock
      }
      // Owner is gone or unverifiable ⇒ reclaim, and recover ONLY its run.
      await this.#recordRecovery({ action: "reclaimed", reason: "lock heartbeat expired and owner is gone/unverifiable", held });
      const abandonedRunId = held?.runId ?? null;
      this.breakRunLock();
      if (abandonedRunId) {
        const run = this.getRun(abandonedRunId);
        const terminal = run && (run.status === "promoted" || run.status === "rejected" || run.status === "failed");
        if (run && !terminal) {
          await this.runEvent(abandonedRunId, { status: "failed", note: "interrupted: lock owner gone — recovered during lock acquisition" });
        }
      }
      return this.acquireRunLock(staleMs, { runId, attempt: attempt + 1 });
    }
  }

  /** Attach the run id to the lock we already hold, so a crash is recoverable. */
  bindRunLock(runId) {
    if (!this.#lockRecord) return;
    this.#lockRecord = { ...this.#lockRecord, runId, heartbeatAt: new Date().toISOString() };
    try { writeFileSync(this.lockPath(), JSON.stringify(this.#lockRecord)); } catch { /* ignore */ }
  }

  breakRunLock() {
    this.#stopLockHeartbeat();
    if (existsSync(this.lockPath())) unlinkSync(this.lockPath());
  }

  releaseRunLock() { this.breakRunLock(); }
}