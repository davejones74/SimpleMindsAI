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
export function acquireReviewLock(dir, { staleMs = 10 * 60 * 1000, owner = null } = {}) {
  const p = reviewLockPath(dir);
  const lockOwner = {
    pid: process.pid,
    host: os.hostname(),
    token: randomUUID(),
    acquiredAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    ...(owner && typeof owner === "object" ? owner : {}),
  };
  try {
    writeFileSync(p, JSON.stringify(lockOwner), { flag: "wx" });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    const held = readReviewLock(dir);
    // A live owner always wins, even with an old heartbeat. A DEAD owner must not
    // keep us waiting for the full stale window after a service restart: its
    // heartbeat can be only seconds old when the process is killed.
    if (ownerAlive(held)) return null;
    try {
      if (existsSync(p)) unlinkSync(p);
    } catch {
      return null;
    }
    return acquireReviewLock(dir, { staleMs, owner });
  }

  const timer = setInterval(() => {
    try {
      const cur = readReviewLock(dir);
      if (cur && cur.token && cur.token !== lockOwner.token) {
        clearInterval(timer); // we no longer own it
        return;
      }
      lockOwner.heartbeatAt = new Date().toISOString();
      writeFileSync(p, JSON.stringify(lockOwner));
    } catch {
      /* heartbeat is best-effort */
    }
  }, Math.max(1000, Math.min(Math.floor(staleMs / 3), 60_000)));
  timer.unref?.();

  return {
    token: lockOwner.token,
    owner: lockOwner,
    dir,
    release() {
      clearInterval(timer);
      try {
        const cur = readReviewLock(dir);
        if (cur && cur.token && cur.token !== lockOwner.token) return; // gone or replaced — leave it
        if (existsSync(p)) unlinkSync(p);
      } catch {
        /* releasing a lock that is already gone is not a failure */
      }
    },
  };
}
