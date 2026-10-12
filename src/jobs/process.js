import { spawn } from "node:child_process";

/**
 * Process-group helpers for managed jobs.
 *
 * A training run is a process TREE (Python plus any dataloader workers). Killing
 * only the direct child can strand grandchildren holding the GPU, so cancellation
 * escalates from a cooperative signal to a tree kill:
 *
 *   - Windows: `taskkill /pid <pid> /t /f` terminates the child and every
 *     descendant.
 *   - POSIX: the child is spawned detached so it leads its own process group, and
 *     the whole group is signalled with `kill(-pid, …)`.
 *
 * This is the LAST resort; callers always try cooperative cancellation first
 * (the job sets `stop-requested`, lets in-flight work settle, and only then
 * escalates here).
 */
export function killProcessTree(child, { signal = "SIGKILL" } = {}) {
  if (!child || child.pid == null) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;

  if (process.platform === "win32") {
    try {
      const tk = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      tk.on("error", () => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      });
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    return;
  }

  try {
    process.kill(-pid, signal); // negative pid = the child's whole group
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Spawn a long-lived child that can be killed as a tree. POSIX children are
 * detached (new process group) so `killProcessTree` can reach their descendants;
 * Windows needs no special flags because `taskkill /t` walks the tree.
 */
export function spawnManaged(bin, args, { cwd, env, windowsHide = true } = {}) {
  const detached = process.platform !== "win32";
  return spawn(bin, args, { cwd, env, windowsHide, detached });
}
