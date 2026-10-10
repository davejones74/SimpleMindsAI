import { config } from "../config.js";
import { IMPORTANCE_LEVELS, normalizeImportance } from "../domain/article.js";

/**
 * Deterministic curriculum validation (requirement #12).
 *
 * The planner is AI-ASSISTED, never authoritative. Anything the LLM proposes
 * passes through this function, which enforces the invariants the curriculum
 * depends on:
 *   - categories must be in the allowed set
 *   - targetExamples must be finite, >= 0, and bounded by the total available
 *   - minimumImportance must be one of Normal|Important|Critical
 *   - total requested examples must be under the snapshot ceiling
 *
 * Invalid output => { ok:false, errors:[...] } and the caller falls back to the
 * deterministic `fallbackCurriculum`. The LLM cannot raise the cap or sneak in a
 * category. Curriculum selection no longer references rewards — the training
 * unit is continuous article text and the signal is next-token prediction.
 */
const isFiniteNum = (n) => n !== null && n !== "" && Number.isFinite(Number(n));

export function validateCurriculum(
  plan,
  {
    allowedCategories = config.allowedCategories,
    allowedImportance = IMPORTANCE_LEVELS,
    maxTotalExamples = config.snapshotLimit,
  } = {},
) {
  const allowed = new Set(allowedCategories.map((c) => String(c).toLowerCase()));
  const importanceSet = new Set(allowedImportance);
  const errors = [];
  const totalCeil = Math.max(0, Number(maxTotalExamples) || 0);

  const seen = new Set();
  const curriculum = [];
  const raw = Array.isArray(plan?.curriculum) ? plan.curriculum : Array.isArray(plan?.buckets) ? plan.buckets : [];
  if (!raw.length) errors.push("curriculum is empty or unparsable");

  for (const b of raw) {
    const category = String(b?.category ?? b?.domain ?? "").trim();
    if (!category) {
      errors.push("curriculum entry missing category");
      continue;
    }
    if (!allowed.has(category.toLowerCase())) {
      errors.push(`category '${category}' not in allowed set`);
      continue;
    }
    const key = category.toLowerCase();
    if (seen.has(key)) {
      errors.push(`duplicate category '${category}' collapsed`);
      continue;
    }
    seen.add(key);

    const target = Number(b?.targetExamples ?? b?.targetRatio);
    const targetExamples = Number.isNaN(target) ? 0 : Math.max(0, Math.floor(target));
    if (targetExamples > totalCeil) errors.push(`category '${category}' target ${targetExamples} exceeds ceiling`);

    const requestedImportance = b?.minimumImportance ?? b?.minimumReward;
    const minimumImportance = normalizeImportance(requestedImportance);
    if (requestedImportance !== undefined && !importanceSet.has(minimumImportance)) {
      errors.push(`category '${category}' minimumImportance '${requestedImportance}' not in allowed set (clamped)`);
    }

    curriculum.push({ category: key, targetExamples: Math.min(targetExamples, totalCeil), minimumImportance });
  }

  const total = curriculum.reduce((a, c) => a + c.targetExamples, 0);
  if (total > totalCeil) errors.push(`total requested ${total} exceeds snapshot ceiling ${totalCeil}`);

  return {
    ok: errors.length === 0 && curriculum.length > 0,
    curriculum,
    errors,
    normalized: curriculum.length > 0,
    llmAssessment: plan?.assessment ?? null,
    llmPriorities: Array.isArray(plan?.priorities) ? plan.priorities : [],
  };
}

/** Deterministic fallback when the LLM plan is unusable — never blocks a cycle. */
export function fallbackCurriculum(
  stats,
  { allowedCategories = config.allowedCategories, maxTotalExamples = config.snapshotLimit } = {},
) {
  const counts = stats?.byDomain ?? [];
  const scored = counts.filter((d) => allowedCategories.map((c) => c.toLowerCase()).includes(String(d.domain).toLowerCase()));
  if (!scored.length) {
    return { curriculum: [], errors: ["no usable domains in stats"], source: "fallback" };
  }
  const total = Math.min(maxTotalExamples, scored.reduce((a, d) => a + d.count, 0));
  const perDomain = Math.floor(total / scored.length) || 1;
  return {
    curriculum: scored.map((d) => ({ category: d.domain, targetExamples: perDomain, minimumImportance: "Normal" })),
    errors: [],
    source: "fallback",
  };
}
