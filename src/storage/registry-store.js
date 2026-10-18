import { createWriteStream, createReadStream, existsSync, mkdirSync, writeFileSync, unlinkSync, renameSync, readFileSync, appendFileSync } from "node:fs";
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
  static async open(dir = process.env.REGISTRY_DIR ?? path.resolve("data", "registry"), { readOnly = false } = {}) {
    const s = new RegistryStore(dir, { readOnly });
    await s.#loadFromDisk();
    return s;
  }

  #streams;
  #lockRecord = null;
  #lockTimer = null;

  /**
   * `readOnly: true` opens an inspection view: no directory is created and no
   * append streams are opened, so inspecting another workspace's registry can
   * never create or mutate a file. Every mutating method throws.
   */
  constructor(dir, { readOnly = false } = {}) {
    this.dir = dir;
    this.readOnly = readOnly;
    if (!readOnly) mkdirSync(`${dir}/evaluations`, { recursive: true });
    this.snapshots = [];
    this.models = new Map(); // modelId -> static registration record
    this.modelEvents = new Map();
    this.runs = new Map();
    this.runEvents = new Map();
    this.evaluations = [];

    this.#streams = {};
    if (!readOnly) {
      for (const name of Object.keys(COLLECTIONS)) {
        this.#streams[name] = createWriteStream(path.join(dir, COLLECTIONS[name]), { flags: "a" });
      }
    }
  }

  #assertWritable() {
    if (this.readOnly) throw new Error("RegistryStore is read-only (inspection workspace)");
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
    this.#assertWritable();
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
    this.#assertWritable();
    const rec = { id: randomUUID().slice(0, 8), createdAt: new Date().toISOString(), ...manifest };
    this.snapshots.push(rec);
    await this.#persist("snapshots", rec);
    return rec;
  }
  listSnapshots() { return [...this.snapshots]; }
  getSnapshot(datasetId) { return this.snapshots.find((s) => s.datasetId === datasetId) ?? null; }

  // ---------------------------------------------------------- models
  async registerModel({ kind, baseModel, parentModelId = null, trainingRunId = null, datasetId = null, checkpointPath = null, meta = {} }) {
    this.#assertWritable();
    const modelId = this.nextModelId();
    const rec = { modelId, kind, baseModel, parentModelId, trainingRunId, datasetId, checkpointPath, meta, createdAt: new Date().toISOString(), status: "candidate" };
    this.models.set(modelId, rec);
    await this.#persist("models", rec);
    return this.getModel(modelId);
  }

  async modelEvent(modelId, { status = "candidate", evaluationScore = null, evalRunId = null, note = null }) {
    this.#assertWritable();
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
    return { ...base, status, evaluationScore, evalRunId, note: last?.note ?? null, at: last?.at ?? null };
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
    this.#assertWritable();
    const runId = this.nextRunId();
    const rec = { runId, status: "created", startedAt: new Date().toISOString(), completedAt: null, ...input };
    this.runs.set(runId, rec);
    await this.#persist("runs", rec);
    await this.runEvent(runId, { status: "created" });
    return this.getRun(runId);
  }

  async runEvent(runId, { status, note = null }) {
    this.#assertWritable();
    if (!this.runs.has(runId)) throw new Error(`unknown run ${runId}`);
    const rec = { runId, status, at: new Date().toISOString(), note };
    const arr = this.runEvents.get(runId) ?? [];
    arr.push(rec);
    this.runEvents.set(runId, arr);
    await this.#persist("runEvents", rec);
    return rec;
  }

  async completeRun(runId, { status, note = null, ...patch }) {
    this.#assertWritable();
    // Patch the static registration line's mutable-fields view but ALWAYS
    // record the terminal state as an event — the historical line is untouched.
    // `note` carries the durable reason (e.g. the promotion-gate rejection
    // rationale) so a rejected candidate is explainable after the fact instead
    // of only showing "run rejected".
    const base = this.runs.get(runId);
    if (!base) throw new Error(`unknown run ${runId}`);
    this.runs.set(runId, { ...base, status, completedAt: new Date().toISOString(), ...patch });
    await this.runEvent(runId, { status, note: note ?? `run ${status}` });
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
    this.#assertWritable();
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
    this.#assertWritable();
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

  #readLockFile(file = this.lockPath()) {
    try {
      const raw = readFileSync(file, "utf8").trim();
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

  #readLock() {
    return this.#readLockFile(this.lockPath());
  }

  /**
   * A sanitized view of the current RUN.lock for operators/admins. The lock
   * TOKEN is deliberately omitted: it is the secret that proves ownership, and
   * exposing it over an admin API would let a caller forge a release. Returns
   * `null` when no lock is held.
   */
  runLockInfo() {
    const lock = this.#readLock();
    if (!lock) return null;
    const acquired = Date.parse(lock.acquiredAt ?? "");
    const heartbeat = Date.parse(lock.heartbeatAt ?? "");
    return {
      held: true,
      pid: lock.pid ?? null,
      host: lock.host ?? null,
      runId: lock.runId ?? null,
      acquiredAt: Number.isFinite(acquired) ? new Date(acquired).toISOString() : null,
      heartbeatAt: Number.isFinite(heartbeat) ? new Date(heartbeat).toISOString() : null,
      ageMs: Number.isFinite(acquired) ? Date.now() - acquired : null,
      heartbeatAgeMs: Number.isFinite(heartbeat) ? Date.now() - heartbeat : null,
      ownerAlive: this.#isLockOwnerAlive(lock),
    };
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

  #startLockHeartbeat(staleMs, record = this.#lockRecord) {
    this.#stopLockHeartbeat();
    // #stopLockHeartbeat clears the record; reinstall the owner we are now
    // heart-beating. (Previously acquire set #lockRecord and then called this,
    // which immediately cleared it — so the heartbeat timer no-op'd forever and
    // every lock's heartbeatAt froze at acquiredAt.)
    this.#lockRecord = record;
    const interval = Math.max(1000, Math.min(Math.floor(staleMs / 3), 60_000));
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
    this.#assertWritable();
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
    this.#assertWritable();
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
      this.#startLockHeartbeat(staleMs, owner);
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (attempt >= 3) return false; // pathological churn — give up this round
      const held = this.#readLock();
      // Decide on the OWNER first. A dead owner (or a legacy record with no
      // pid/host) means the lock is abandoned and must be reclaimed NOW, no
      // matter how fresh its last heartbeat is — otherwise a process that exits
      // without releasing its lock stalls training for the whole stale window.
      if (!this.#isLockOwnerAlive(held)) {
        await this.#recordRecovery({ action: "reclaimed", reason: "lock owner is gone", held });
        const abandonedRunId = held?.runId ?? null;
        this.#removeLockIfOwned(held?.token ?? null);
        if (abandonedRunId) {
          const run = this.getRun(abandonedRunId);
          const terminal = run && (run.status === "promoted" || run.status === "rejected" || run.status === "failed");
          if (run && !terminal) {
            await this.runEvent(abandonedRunId, { status: "failed", note: "interrupted: lock owner gone — recovered during lock acquisition" });
          }
        }
        return this.acquireRunLock(staleMs, { runId, attempt: attempt + 1 });
      }
      // Owner is alive (or on a foreign host we cannot verify): never steal. A
      // fresh heartbeat means it is actively training; a stale one means it is
      // hung — in both cases the safe answer is to wait.
      const age = this.#heartbeatAgeMs(held);
      if (age <= staleMs) return false;
      await this.#recordRecovery({ action: "deferred", reason: "lock heartbeat expired but owner is still alive", held });
      return false;
    }
  }

  /** Attach the run id to the lock we already hold, so a crash is recoverable. */
  bindRunLock(runId) {
    this.#assertWritable();
    if (!this.#lockRecord) return;
    this.#lockRecord = { ...this.#lockRecord, runId, heartbeatAt: new Date().toISOString() };
    try { writeFileSync(this.lockPath(), JSON.stringify(this.#lockRecord)); } catch { /* ignore */ }
  }

  /**
   * Ownership-safe lock removal.
   *
   * A token check followed by an unprotected `unlink` is NOT sufficient: another
   * process can acquire the lock in the gap between reading it and unlinking it,
   * so the unlink would delete the NEW owner's lock. We instead move the lock
   * file ASIDE with an atomic `rename` and only then verify its token:
   *
   *   - token matches (or no token was required) ⇒ unlink the file we moved; the
   *     name is already gone, so a concurrent acquirer's `wx` create wins and we
   *     never touch its content.
   *   - token does NOT match ⇒ someone replaced the lock between our read and
   *     the rename; we put the file back (or drop our orphaned copy if a fresh
   *     lock already reappeared). Another owner's lock is never discarded.
   *
   * Returns `{ removed, reason }` for callers that want to know the outcome.
   */
  #removeLockIfOwned(expectedToken = null) {
    const lockPath = this.lockPath();
    if (!existsSync(lockPath)) return { removed: false, reason: "absent" };
    const mustMatch = expectedToken ?? this.#lockRecord?.token ?? null;
    const current = this.#readLock();
    // Fast path: a foreign token is parked here — leave it completely alone.
    if (mustMatch && current?.token && current.token !== mustMatch) {
      return { removed: false, reason: "not-owner" };
    }
    const aside = `${lockPath}.release-${process.pid}-${randomUUID().slice(0, 8)}`;
    try {
      renameSync(lockPath, aside);
    } catch (err) {
      if (err.code === "ENOENT") return { removed: false, reason: "absent" };
      throw err;
    }
    const moved = this.#readLockFile(aside);
    if (mustMatch && moved?.token && moved.token !== mustMatch) {
      try {
        if (!existsSync(lockPath)) renameSync(aside, lockPath);
        else unlinkSync(aside);
      } catch { /* best-effort restore */ }
      return { removed: false, reason: "raced" };
    }
    try { unlinkSync(aside); } catch { /* already gone */ }
    return { removed: true, reason: "removed" };
  }

  breakRunLock() {
    this.#assertWritable();
    // Capture our token BEFORE stopping the heartbeat (which clears the record),
    // so release only ever removes the lock WE hold.
    const token = this.#lockRecord?.token ?? null;
    this.#stopLockHeartbeat();
    return this.#removeLockIfOwned(token);
  }

  releaseRunLock() { return this.breakRunLock(); }
}