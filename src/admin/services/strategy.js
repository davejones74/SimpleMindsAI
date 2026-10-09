import { randomUUID } from "node:crypto";
import { config } from "../../config.js";

/**
 * Strategy service — append-only, versioned collection strategy.
 *
 * "Strategy" is the tunable description of HOW the system collects and reviews:
 * focus domains, review sampling, review interval. It follows the same governance
 * as the secondary mission: AI proposes, a human approves/rejects, and a human
 * may also edit directly. Every collection run is expected to record the mission
 * + strategy versions active when it started.
 */

export const DEFAULT_STRATEGY = Object.freeze({
  focusDomains: config.allowedCategories,
  reviewSampleRate: config.review.sampleRate,
  reviewInterval: config.reviewInterval,
  note: "initial collection strategy",
});

const id = (p) => `${p}_${randomUUID().slice(0, 12)}`;

export function createStrategyService({ governance, actor = "operator" } = {}) {
  const activeRecord = () => {
    const versions = governance.list("strategies");
    return versions.length ? versions[versions.length - 1] : null;
  };

  const applyVersion = async ({ strategy, origin, rationale = null, actor: who = "operator", proposalId = null, reviewCycleId = null }) => {
    if (!strategy || typeof strategy !== "object") throw new Error("strategy object required");
    const versions = governance.list("strategies");
    const rec = await governance.append("strategies", {
      strategyId: id("str"),
      version: versions.length + 1,
      strategy,
      origin,
      rationale,
      actor: who,
      proposalId,
      reviewCycleId,
      status: "active",
    });
    await governance.logEvent("strategy-applied", { version: rec.version, origin, actor: who });
    return rec;
  };

  return {
    async init() {
      const existing = governance.list("strategies");
      if (!existing.length) {
        await applyVersion({ strategy: defaultStrategy(), origin: "seed", actor: "system" });
      }
    },
    active: () => activeRecord(),
    versions: () => governance.list("strategies"),

    async proposeChange({ strategy, rationale = null, actor: who = "ai" } = {}) {
      const proposal = await governance.append("proposals", {
        proposalId: `prop_${randomUUID().slice(0, 12)}`,
        target: "strategy",
        strategy,
        rationale,
        origin: "ai",
        actor: who,
        status: "pending",
      });
      await governance.logEvent("strategy-proposed", { proposalId: proposal.proposalId });
      return proposal;
    },

    async approveProposal(proposalId, { actor: who = "operator", reviewCycleId = null } = {}) {
      const proposal = governance.list("proposals").find((p) => p.proposalId === proposalId && p.status === "pending" && p.target === "strategy");
      if (!proposal) throw new Error(`no pending strategy proposal ${proposalId}`);
      const version = await applyVersion({
        strategy: proposal.strategy,
        origin: "ai",
        rationale: proposal.rationale,
        actor: who,
        proposalId,
        reviewCycleId,
      });
      await governance.append("proposals", { proposalId, status: "approved", decidedBy: who, decidedAt: new Date().toISOString() });
      return version;
    },

    async rejectProposal(proposalId, { actor: who = "operator", reason = null } = {}) {
      const proposal = governance.list("proposals").find((p) => p.proposalId === proposalId && p.status === "pending" && p.target === "strategy");
      if (!proposal) throw new Error(`no pending strategy proposal ${proposalId}`);
      await governance.append("proposals", { proposalId, status: "rejected", reason, decidedBy: who, decidedAt: new Date().toISOString() });
      await governance.logEvent("strategy-proposal-rejected", { proposalId, actor: who });
      return { proposalId, status: "rejected" };
    },

    applyDirect({ strategy, actor: who = "operator", rationale = null } = {}) {
      return applyVersion({ strategy, origin: "human", rationale, actor: who });
    },
  };
}

function defaultStrategy() {
  return {
    domains: config.allowedCategories,
    reviewSampleRate: config.review.sampleRate,
    reviewInterval: config.reviewInterval,
  };
}
