/**
 * Mission evaluation: sealed text-loss and deterministic task scoring.
 *
 * This module deliberately does not decide promotion. It measures two independent
 * views of mission progress so a later, separately calibrated policy can combine
 * them with the existing general-knowledge safeguards:
 *   1. causal-LM loss on held-out mission prose;
 *   2. task accuracy on objectively scored grammar/syntax/linguistics prompts.
 *
 * The task scorer never asks a teacher to grade its own generated material. Rows
 * carry an answer key and a deterministic scoring mode; any teacher-generated
 * rows must be independently checked before activation.
 */
import { createHash } from "node:crypto";

export const MISSION_EVAL_SCHEMA = "sma/mission-eval@1";

export function normalizeTaskAnswer(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9'\s-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function scoreTaskAnswer(task, answer) {
  const expected = normalizeTaskAnswer(task?.answer ?? task?.completion ?? "");
  const actual = normalizeTaskAnswer(answer);
  if (!expected || !actual) return 0;
  const mode = String(task?.scoring ?? "exact").toLowerCase();
  if (mode === "choice" || mode === "exact") return actual === expected ? 1 : 0;
  if (mode === "contains") return actual.includes(expected) ? 1 : 0;
  if (mode === "regex") {
    try { return new RegExp(String(task.answer), "i").test(String(answer ?? "")) ? 1 : 0; } catch { return 0; }
  }
  return actual === expected ? 1 : 0;
}

/** Deterministic 95% Wilson interval for task accuracy. */
export function wilsonInterval(successes, total, z = 1.959963984540054) {
  const n = Number(total) || 0;
  if (!n) return { low: null, high: null, point: null };
  const p = Math.max(0, Math.min(1, Number(successes) / n));
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    point: p,
    low: Math.max(0, (centre - margin) / denom),
    high: Math.min(1, (centre + margin) / denom),
  };
}

export async function evaluateMissionTasks({ evalSet, complete, scoreContinuation = null, timeoutMs = 120_000 } = {}) {
  if (!evalSet?.items?.length) throw new Error("mission task evaluation requires a non-empty sealed set");
  if (typeof complete !== "function") throw new Error("mission task evaluation requires a completion adapter");
  const started = Date.now();
  const perTask = [];
  for (const task of evalSet.items) {
    if (Date.now() - started > timeoutMs) throw new Error("mission task evaluation timed out");
    let answer = null;
    let error = null;
    let choiceScores = null;
    const prompt = task.prompt ?? task.text ?? "";
    if (Array.isArray(task.choices) && task.choices.length && typeof scoreContinuation === "function") {
      try {
        const scored = [];
        for (const choice of task.choices) {
          const result = await scoreContinuation(prompt, String(choice));
          scored.push({ choice: String(choice), loss: result.loss, tokens: result.tokens ?? null });
        }
        scored.sort((a, b) => a.loss - b.loss);
        choiceScores = scored;
        answer = scored[0]?.choice ?? null;
      } catch (err) {
        error = err?.message ?? String(err);
      }
    } else {
      try {
        const out = await complete(prompt);
        answer = out?.text ?? out ?? "";
      } catch (err) {
        error = err?.message ?? String(err);
      }
    }
    const expected = task.answer ?? task.completion ?? null;
    const score = error ? 0 : scoreTaskAnswer(task, answer);
    perTask.push({
      taskId: task.taskId ?? task.promptId ?? task.articleId,
      promptId: task.promptId ?? task.articleId ?? null,
      domain: task.domain ?? "language",
      prompt,
      promptHash: createHash("sha256").update(String(prompt)).digest("hex"),
      expectedAnswer: expected,
      choices: Array.isArray(task.choices) ? task.choices : null,
      choiceScores,
      scoring: task.scoring ?? "exact",
      provenance: task.provenance ?? null,
      score,
      answer: answer == null ? null : String(answer).slice(0, 500),
      error,
    });
  }
  const successes = perTask.reduce((n, row) => n + row.score, 0);
  const total = perTask.length;
  const interval = wilsonInterval(successes, total);
  return {
    schema: MISSION_EVAL_SCHEMA,
    kind: "task",
    datasetId: evalSet.datasetId ?? null,
    datasetVersion: evalSet.datasetVersion ?? null,
    total,
    successes,
    accuracy: total ? successes / total : null,
    ciLow: interval.low,
    ciHigh: interval.high,
    perTask,
    answerKeyHash: createHash("sha256").update(JSON.stringify(evalSet.items.map((t) => t.answer ?? t.completion ?? ""))).digest("hex"),
  };
}

/**
 * Compare paired task results. A positive improvement means the candidate
 * answered more tasks correctly than the baseline.
 */
export function compareMissionTasks(baseline, candidate) {
  const b = new Map((baseline?.perTask ?? []).map((row) => [String(row.taskId), row.score]));
  const c = new Map((candidate?.perTask ?? []).map((row) => [String(row.taskId), row.score]));
  const ids = [...b.keys()].filter((id) => c.has(id));
  if (!ids.length) return { ok: false, reason: "no paired task results" };
  let delta = 0;
  for (const id of ids) delta += c.get(id) - b.get(id);
  return {
    ok: true,
    pairedTasks: ids.length,
    baselineAccuracy: baseline?.accuracy ?? null,
    candidateAccuracy: candidate?.accuracy ?? null,
    improvement: ids.length ? delta / ids.length : null,
    wins: ids.filter((id) => c.get(id) > b.get(id)).length,
    losses: ids.filter((id) => c.get(id) < b.get(id)).length,
    ties: ids.filter((id) => c.get(id) === b.get(id)).length,
  };
}
