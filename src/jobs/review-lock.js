import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

/**
 * A small, self-contained file lock that serialises TEACHER REVIEW across
 * processes. The perpetual CLI, a supervised learning job and an explicit
 * backlog drain all review the same ArticleStore; without coordination two
 * workers could score (and record) the same article concurrently, inflating the
 * attempt counter and racing the state transition.
 *
 * It is deliberately separate from RUN.lock: reviewing is cheap and must not be
 * blocked by a long training run, and vice versa. Acquisition is atomic
 * (`wx` create); a lock whose heartbeat is older than `staleMs` AND whose owner
 * is verifiably gone is reclaimed. Release never removes a replacement owner's
 * lock (token check).
 */

export const REVIEW_LOCK_FILE = "REVIEW.lock";

export function reviewLockPath(dir) {
  return path.join(dir, REVIEW_LOCK_FILE);
}

export function readReviewLock(dir) {
  try {
    const raw = readFileSync(reviewLockPath(dir), "utf8").trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function ownerAlive(lock) {
  if (!lock) return false;
  if (!Number.isInteger(lock.pid) || !lock.host) return false;
  if (lock.host !== os.hostname()) return true; // cannot verify ⇒ assume alive (fail safe)
  try {
    process.kill(lock.pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/**
 * Returns a handle `{ token, release() }` on success, or `null` when another
 * live worker holds the lock. Callers treat `null` as a transient condition:
 * skip this review pass and retry later — never as a review failure.
 */
export function acquireReviewLock(dir, { staleMs = 10 * 60 * 1000 } = {}) {
  const p = reviewLockPath(dir);
  const owner = {
    pid: process.pid,
    host: os.hostname(),
    token: randomUUID(),
    acquiredAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  };
  try {
    writeFileSync(p, JSON.stringify(owner), { flag: "wx" });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    const held = readReviewLock(dir);
    const hb = Date.parse(held?.heartbeatAt ?? held?.acquiredAt ?? "");
    const age = Number.isFinite(hb) ? Date.now() - hb : Number.POSITIVE_INFINITY;
    if (age <= staleMs) return null; // fresh enough: an active reviewer holds it
    if (ownerAlive(held)) return null; // never steal a live owner's lock
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      return null;
    }
    return acquireReviewLock(dir, { staleMs });
  }

  const timer = setInterval(() => {
    try {
      const cur = readReviewLock(dir);
      if (cur && cur.token && cur.token !== owner.token) {
        clearInterval(timer); // we no longer own it
        return;
      }
      owner.heartbeatAt = new Date().toISOString();
      writeFileSync(p, JSON.stringify(owner));
    } catch {
      /* heartbeat is best-effort */
    }
  }, Math.max(1000, Math.min(Math.floor(staleMs / 3), 60_000)));
  timer.unref?.();

  return {
    token: owner.token,
    dir,
    release() {
      clearInterval(timer);
      try {
        const cur = readReviewLock(dir);
        if (cur && cur.token && cur.token !== owner.token) return; // gone or replaced — leave it
        if (existsSync(p)) unlinkSync(p);
      } catch {
        /* releasing a lock that is already gone is not a failure */
      }
    },
  };
}
