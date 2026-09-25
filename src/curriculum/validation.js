import { config } from "../config.js";

/**
 * Deterministic curriculum validation (requirement #12).
 *
 * The planner is AI-ASSISTED, never authoritative. Anything the LLM proposes
 * passes through this function, which enforces the invariants the curriculum
 * actually depends on:
 *   - categories must be in the allowed set
 *   - targetExamples must be finite, >= 0, and bounded by the total available
 *   - minimumReward must be a valid 0..10 float
 *   - maxSyntheticShare must stay under the configured ceiling
 *   - total requested examples must be under the snapshot ceiling
 *
 * Invalid output => { ok:false, errors:[...] } and the caller falls back to the
 * deterministic `fallbackCurriculum`. The LLM cannot raise the cap, sneak a
 * category, or force a synthetic-heavy mix.
 */
const isFiniteNum = (n) => Number.isFinite(Number(n)) && Number.isFinite(n);

export function validateCurriculum(
  plan,
  {
    allowedCategories = config.allowedCategories,
    maxSyntheticShare = config.curriculumMaxSyntheticShare,
    maxTotalExamples = config.snapshotLimit,
  } = {}
) {
  const allowed = new Set(allowedCategories);
  const errors = [];

  const maxShare = Math.max(0, Math.min(1, Number(maxSyntheticShare) || 0));
  const totalCeil = Math.max(0, Number(maxTotalExamples) || 0);

  let proposedShare = Number(plan?.maxSyntheticShare);
  if (!isFiniteNum(proposedShare)) proposedShare = maxShare;
  if (proposedShare > maxShare) {
    errors.push(`maxSyntheticShare ${proposedShare} exceeds ceiling ${maxShare} (clamped)`);
    proposedShare = maxShare;
  }
  if (proposedShare < 0) {
    errors.push("maxSyntheticShare must be >= 0 (clamped to 0)");
    proposedShare = 0;
  }

  const seen = new Set();
  const curriculum = [];
  const raw = Array.isArray(plan?.curriculum) ? plan.curriculum : Array.isArray(plan?.buckets) ? plan.buckets : [];
  if (!raw.length) errors.push("curriculum is empty or unparsable");

  for (const b of raw) {
    const category = String(b?.category ?? b?.domain ?? "").trim();
    if (!category) { errors.push("curriculum entry missing category"); continue; }
    if (!allowed.has(category.toLowerCase())) { errors.push(`category '${category}' not in allowed set`); continue; }
    const key = category.toLowerCase();
    if (seen.has(key)) { errors.push(`duplicate category '${category}' collapsed`); continue; }
    seen.add(key);

    const target = Number(b?.targetExamples ?? b?.targetRatio);
    const targetExamples = Number.isNaN(target) ? 0 : Math.max(0, Math.floor(target));
    if (targetExamples > totalCeil) errors.push(`category '${category}' target ${targetExamples} exceeds ceiling`);

    const minReward = Number(b?.minimumReward ?? config.minReward);
    const rewardOk = Number.isFinite(minReward) && minReward >= 0 && minReward <= 10;
    if (!rewardOk) errors.push(`category '${category}' minimumReward ${minReward} outside 0..10 (clamped)`);

    curriculum.push({
      category: key,
      targetExamples: Math.min(targetExamples, totalCeil),
      minimumReward: rewardOk ? minReward : Math.max(0, Math.min(10, config.minReward)),
    });
  }

  const total = curriculum.reduce((a, c) => a + c.targetExamples, 0);
  if (total > totalCeil) errors.push(`total requested ${total} exceeds snapshot ceiling ${totalCeil}`);

  return {
    ok: errors.length === 0 && curriculum.length > 0,
    curriculum,
    maxSyntheticShare: proposedShare,
    errors,
    normalized: curriculum.length > 0,
    llmAssessment: plan?.assessment ?? null,
    llmPriorities: Array.isArray(plan?.priorities) ? plan.priorities : [],
  };
}

/** Deterministic fallback when the LLM plan is unusable — never blocks a cycle. */
export function fallbackCurriculum(stats, { allowedCategories = config.allowedCategories, maxTotalExamples = config.snapshotLimit, minReward = config.minReward } = {}) {
  const counts = stats?.byDomain ?? [];
  const domains = counts.map((d) => d.domain).filter((d) => allowedCategories.includes(d));
  const scored = counts.filter((d) => allowedCategories.includes(d.domain));
  if (!scored.length) {
    return { curriculum: [], maxSyntheticShare: 0, errors: ["no usable domains in stats"], source: "fallback" };
  }
  const total = Math.min(maxTotalExamples, scored.reduce((a, d) => a + d.count, 0));
  const perDomain = Math.floor(total / scored.length) || 1;
  return {
    curriculum: scored.map((d) => ({ category: d.domain, targetExamples: perDomain, minimumReward: minReward })),
    maxSyntheticShare: 0,
    errors: [],
    source: "fallback",
    unusedDomains: domains.length ? [] : scored.map((d) => d.domain),
  };
}