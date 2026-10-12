import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import { PYTHON_DIR, pythonEnv, resolvePythonBin, resolveStoreRoot } from "./python-cli.js";

/**
 * StudentWorker — supervised client for the long-lived Python student process
 * (`python -m sma.student`).
 *
 * The worker keeps the active brain resident across chat turns. This class owns
 * the child's lifecycle so the chat server never has to:
 *   - one in-flight request at a time, matched by request id,
 *   - a request timeout that rejects instead of hanging forever,
 *   - a crash that rejects every pending request and restarts with backoff,
 *   - a clean shutdown that does not leave an orphan process.
 *
 * Log discipline: the child's stderr is forwarded to `log` (never mixed with
 * responses); stdout is parsed strictly as newline-delimited JSON.
 *
 * Failure is explicit: when no worker is running, every call rejects. The brain
 * never falls back to a teacher for an answer.
 */

export class StudentWorker extends EventEmitter {
  constructor({
    bin = resolvePythonBin(),
    store = resolveStoreRoot(),
    device = "auto",
    pythonDir = PYTHON_DIR,
    requestTimeoutMs = 120_000,
    restartDelayMs = 500,
    maxRestarts = 5,
    log = () => {},
  } = {}) {
    super();
    this.bin = bin;
    this.store = store;
    this.device = device;
    this.pythonDir = pythonDir;
    this.requestTimeoutMs = requestTimeoutMs;
    this.restartDelayMs = restartDelayMs;
    this.maxRestarts = maxRestarts;
    this.log = log;

    this.child = null;
    this.available = false;
    this.version = null;
    this._nextId = 1;
    this._pending = new Map();
    this._rl = null;
    this._restarts = 0;
    this._stopping = false;
    this._startPromise = null;
    // All protocol writes are serialized through this promise chain so at most
    // ONE request is in flight at a time. That makes a version-pinned generate
    // (which loads its checkpoint as part of the same request) atomic with
    // respect to overlapping requests: no turn can ever observe weights loaded
    // on behalf of another turn.
    this._queue = Promise.resolve();
  }

  async start() {
    if (!this._startPromise) this._startPromise = this._spawn();
    return this._startPromise;
  }

  _spawn() {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(
          this.bin,
          ["-m", "sma.student", "--out", this.store, "--device", this.device],
          { cwd: this.pythonDir, env: pythonEnv(this.store), windowsHide: true },
        );
      } catch (err) {
        reject(err);
        return;
      }
      this.child = child;

      this._rl = readline.createInterface({ input: child.stdout });
      this._rl.on("line", (line) => this._onLine(line));
      child.stderr.on("data", (d) => this.log(`[student] ${String(d).replace(/\s+$/, "")}`));

      let spawned = false;
      child.once("spawn", () => {
        spawned = true;
        this.available = true;
        this._startPromise = Promise.resolve();
        this.emit("ready");
        resolve();
      });
      child.once("error", (err) => {
        if (!spawned) {
          this._startPromise = null;
          reject(err);
        }
      });
      child.once("exit", (code, signal) => this._onExit(code, signal));
    });
  }

  _onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.log(`[student] ignoring non-JSON stdout: ${line.slice(0, 200)}`);
      return;
    }
    const entry = this._pending.get(message.id);
    if (!entry) {
      this.log(`[student] response for unknown id ${message.id}`);
      return;
    }
    this._pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.ok === false) entry.reject(new Error(message.error || "student worker error"));
    else entry.resolve(message);
  }

  _onExit(code, signal) {
    const hadPending = this._pending.size;
    this.available = false;
    this.version = null;
    this._startPromise = null;
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`student worker exited (code ${code}, signal ${signal})`));
    }
    this._pending.clear();
    if (this._rl) {
      this._rl.close();
      this._rl = null;
    }

    if (this._stopping) {
      this.emit("stopped", { code, signal });
      return;
    }
    this.log(`[student] exited unexpectedly code=${code} signal=${signal} (${hadPending} pending)`);
    this.emit("crash", { code, signal });
    this._scheduleRestart();
  }

  _scheduleRestart() {
    if (this._restarts >= this.maxRestarts) {
      this.log(`[student] giving up after ${this._restarts} restart(s)`);
      this.emit("unavailable");
      return;
    }
    this._restarts += 1;
    const delay = this.restartDelayMs * this._restarts;
    this.log(`[student] restart ${this._restarts}/${this.maxRestarts} in ${delay}ms`);
    setTimeout(async () => {
      if (this._stopping) return;
      try {
        await this.start();
        await this.reload();
        this.emit("restarted", { version: this.version });
      } catch (err) {
        this.log(`[student] restart failed: ${err.message}`);
        this.available = false;
        this._scheduleRestart();
      }
    }, delay).unref?.();
  }

  _send(op, payload = {}, opts = {}) {
    return this._enqueue(() => this._sendNow(op, payload, opts));
  }

  /** Serialize every protocol write; keep the chain alive across failures. */
  _enqueue(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.then(() => {}, () => {});
    return run;
  }

  _sendNow(op, payload = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (!this.child || !this.available) {
      return Promise.reject(new Error("student worker is not running"));
    }
    const id = this._nextId++;
    const request = { id, op, ...payload };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`student worker request '${op}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(request)}\n`, (err) => {
        if (err) {
          this._pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  async ping() {
    return this._send("ping", {}, { timeoutMs: 10_000 });
  }

  async load(version, { verify = false } = {}) {
    const payload = { ...(version ? { version } : {}) };
    if (verify) payload.verify = true;
    const out = await this._send("load", payload, { timeoutMs: Math.max(this.requestTimeoutMs, 60_000) });
    this.version = out.version;
    return out;
  }

  /** Re-read the active pointer and swap the resident model (safe switch). */
  async reload() {
    const out = await this._send("reload", {}, { timeoutMs: Math.max(this.requestTimeoutMs, 60_000) });
    this.version = out.version;
    return out;
  }

  async currentVersion() {
    return this._send("version", {}, { timeoutMs: 10_000 });
  }

  async generate(prompt, opts = {}) {
    const out = await this._send("generate", { prompt, ...opts });
    return {
      text: out.text,
      version: out.version,
      artifactName: out.artifactName,
      integrity: out.integrity,
      mode: out.mode,
      promptTokens: out.promptTokens,
      generatedTokens: out.generatedTokens,
    };
  }

  async shutdown() {
    this._stopping = true;
    const child = this.child;
    const done = new Promise((resolve) => {
      this.once("stopped", resolve);
      setTimeout(resolve, 3_000).unref?.();
    });
    try {
      if (child && this.available) await this._send("shutdown", {}, { timeoutMs: 3_000 });
    } catch {
      // fall through to force-kill
    }
    if (child && child.exitCode === null && !child.killed) child.kill();
    await done;
    this.available = false;
  }
}
