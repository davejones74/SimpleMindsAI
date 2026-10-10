import { randomUUID } from "node:crypto";
import { config } from "../../config.js";

/**
 * Review-cycle service.
 *
 * A review cycle is a checkpoint every `reviewInterval` successfully consumed
 * articles — explicitly a checkpoint, NOT a cap on training or collection. Each
 * cycle records the mission + strategy versions that were active when it opened,
 * so a later reviewer can see exactly what governed the material in question.
 * Cycles are opened automatically when consumption crosses a threshold and are
 * closed by an operator with notes.
 */
export function createReviewCyclesService({ governance, mission = null, strategy = null } = {}) {
  const interval = () => config.reviewInterval;

  const projected = () => {
    const byId = new Map();
    for (const rec of governance.list("reviewCycles")) {
      const prev = byId.get(rec.reviewCycleId) ?? {};
      byId.set(rec.reviewCycleId, { ...prev, ...rec });
    }
    return [...byId.values()].sort((a, b) => a.index - b.index);
  };

  return {
    interval,
    list: projected,
    current() {
      return projected().find((c) => c.status === "open") ?? null;
    },

    /**
     * Open a cycle if consumption has crossed the next threshold. Idempotent:
     * calling repeatedly between thresholds opens nothing new. Returns the cycle
     * that was opened (or null).
     */
    async ensureForConsumption(uniqueConsumed) {
      const cycles = projected();
      const nextIndex = cycles.length + 1;
      const threshold = nextIndex * interval();
      if (!Number.isFinite(uniqueConsumed) || uniqueConsumed < threshold) return null;
      if (cycles.some((c) => c.status === "open")) return null;

      const rec = await governance.append("reviewCycles", {
        reviewCycleId: `rc_${randomUUID().slice(0, 12)}`,
        index: nextIndex,
        threshold,
        atConsumed: uniqueConsumed,
        status: "open",
        openedAt: new Date().toISOString(),
        missionVersion: mission?.secondary()?.version ?? null,
        strategyVersion: strategy?.active()?.version ?? null,
      });
      await governance.logEvent("review-cycle-opened", { reviewCycleId: rec.reviewCycleId, index: nextIndex });
      return rec;
    },

    async close(reviewCycleId, { actor = "operator", notes = null, proposalIds = [] } = {}) {
      const cycle = projected().find((c) => c.reviewCycleId === reviewCycleId);
      if (!cycle) throw new Error(`unknown review cycle ${reviewCycleId}`);
      if (cycle.status === "closed") return cycle;
      const rec = await governance.append("reviewCycles", {
        reviewCycleId,
        status: "closed",
        closedAt: new Date().toISOString(),
        closedBy: actor,
        notes,
        proposalIds,
      });
      await governance.logEvent("review-cycle-closed", { reviewCycleId, actor });
      return { ...cycle, ...rec };
    },
  };
}
