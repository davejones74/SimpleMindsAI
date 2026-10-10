import { randomUUID } from "node:crypto";

/**
 * Mission service — append-only, versioned mission statements.
 *
 * The PRIMARY mission is the immutable north star: only an explicit, audited
 * operator action may amend it, and an AI proposal against it is refused
 * outright. The SECONDARY mission is evolvable through a formal
 * propose -> review -> approve/reject -> apply flow, and also through direct
 * human edits (which create a version immediately, no forced AI proposal first).
 */

export const PRIMARY_MISSION_TEXT =
  "To accurately comprehend the nuances of human language, transforming unstructured text into clear, contextual insights that enable seamless and meaningful interaction.";

export const SECONDARY_MISSION_TEXT =
  "To continually refine its understanding through ethical learning, ensuring all processing remains objective, culturally adaptive, and securely aligned with user intent.";

const id = (p) => `${p}_${randomUUID().slice(0, 12)}`;

export function createMissionService({ governance, actor = "operator" } = {}) {
  const ensureSeed = async () => {
    for (const [kind, text] of [
      ["primary", PRIMARY_MISSION_TEXT],
      ["secondary", SECONDARY_MISSION_TEXT],
    ]) {
      if (!governance.list("missions").some((m) => m.kind === kind)) {
        await governance.append("missions", { missionId: id("mis"), kind, version: 1, text, origin: "seed", actor: "system", status: "active" });
      }
    }
  };

  const list = (kind) => governance.list("missions").filter((m) => m.kind === kind);
  const activeRecord = (kind) => {
    const versions = list(kind);
    return versions.length ? versions[versions.length - 1] : null;
  };

  const applyVersion = async (kind, { text, origin, rationale = null, actor: who = actor, proposalId = null, reviewCycleId = null }) => {
    if (!String(text ?? "").trim()) throw new Error("mission text required");
    const versions = list(kind);
    const rec = await governance.append("missions", {
      missionId: id("mis"),
      kind,
      version: versions.length + 1,
      text: String(text).trim(),
      origin,
      rationale,
      actor: who,
      proposalId,
      reviewCycleId,
      status: "active",
    });
    await governance.logEvent("mission-applied", { kind, version: rec.version, origin, actor: who });
    return rec;
  };

  return {
    async init() {
      await ensureSeed();
    },
    primary: () => activeRecord("primary"),
    secondary: () => activeRecord("secondary"),
    list,
    versions: (kind) => list(kind),

    /** AI may never propose a change to the primary mission. */
    async proposeChange(kind, { text, rationale = null, actor: who = "ai" } = {}) {
      if (kind === "primary") throw new Error("the primary mission cannot be changed by AI");
      const proposal = await governance.append("proposals", {
        proposalId: id("prop"),
        target: "mission",
        kind,
        text: String(text ?? "").trim(),
        rationale,
        origin: "ai",
        actor: who,
        status: "pending",
      });
      await governance.logEvent("mission-proposed", { kind, proposalId: proposal.proposalId });
      return proposal;
    },

    async approveProposal(proposalId, { actor: who = actor, reviewCycleId = null } = {}) {
      const proposal = governance.list("proposals").find((p) => p.proposalId === proposalId && p.status === "pending");
      if (!proposal) throw new Error(`no pending mission proposal ${proposalId}`);
      const version = await applyVersion(proposal.kind, {
        text: proposal.text,
        origin: "ai",
        rationale: proposal.rationale,
        actor: who,
        proposalId,
        reviewCycleId,
      });
      await governance.append("proposals", { proposalId, status: "approved", decidedBy: who, decidedAt: new Date().toISOString() });
      return version;
    },

    async rejectProposal(proposalId, { actor: who = actor, reason = null } = {}) {
      const proposal = governance.list("proposals").find((p) => p.proposalId === proposalId && p.status === "pending");
      if (!proposal) throw new Error(`no pending mission proposal ${proposalId}`);
      await governance.append("proposals", { proposalId, status: "rejected", reason, decidedBy: who, decidedAt: new Date().toISOString() });
      await governance.logEvent("mission-proposal-rejected", { proposalId, actor: who });
      return { proposalId, status: "rejected" };
    },

    /** Direct operator edit — creates a version with no proposal step. */
    applyDirect(kind, { text, actor: who = actor, rationale = null } = {}) {
      return applyVersion(kind, { text, origin: "human", rationale, actor: who });
    },
  };
}
