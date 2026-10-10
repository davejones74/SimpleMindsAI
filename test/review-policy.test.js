import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICY, selectionDecision, evaluateVerdict, sampleUnit, policyFromConfig } from "../src/domain/review-policy.js";
import { STATUS, VERDICT, AUTHORITY } from "../src/domain/article.js";
import { config } from "../src/config.js";

test("policy values are sourced from config.review (single source of truth)", () => {
  const p = policyFromConfig();
  assert.equal(p.sampleRate, config.review.sampleRate);
  assert.equal(p.approveMinScore, config.review.minScore);
  assert.equal(p.uncertaintyThreshold, config.review.uncertaintyThreshold);
  assert.equal(p.missionRelevanceThreshold, config.review.missionRelevanceThreshold);
  assert.equal(p.salt, config.review.salt);
  assert.deepEqual({ ...DEFAULT_POLICY }, { ...p });
  assert.ok(Object.isFrozen(p));
});

test("sampling is deterministic for a given id + salt", () => {
  assert.equal(sampleUnit("art_x"), sampleUnit("art_x"));
  const u = sampleUnit("art_x", "some-other-salt");
  assert.ok(u >= 0 && u < 1);
  assert.notEqual(sampleUnit("art_x"), sampleUnit("art_y"));
});

test("selection: human request / importance / mission-relevance / uncertainty / sample", () => {
  const base = { articleId: "art_1", importance: "Normal" };

  const requested = selectionDecision({ ...base, reviewRequested: true });
  assert.equal(requested.selected, true);
  assert.ok(requested.reasons.includes("human-requested"));

  assert.equal(selectionDecision({ ...base, importance: "Critical" }).selected, true);
  assert.equal(selectionDecision({ ...base, importance: "Important" }).selected, true);
  assert.equal(selectionDecision({ ...base, missionRelevance: 0.99 }).selected, true);
  assert.equal(selectionDecision({ ...base, uncertainty: 0.99 }).selected, true);

  // A plain Normal article is selected exactly when the deterministic sample hits.
  const plain = selectionDecision(base);
  assert.equal(plain.selected, plain.sample < DEFAULT_POLICY.sampleRate);
});

test("verdict: teacher gated by score; human decision is final and authoritative", () => {
  const a = { articleId: "art_1", status: STATUS.PENDING_REVIEW };

  const below = evaluateVerdict(a, { verdict: VERDICT.APPROVE, score: 2, authority: AUTHORITY.TEACHER });
  assert.equal(below.apply, false);
  assert.equal(below.status, STATUS.PENDING_REVIEW);

  const good = evaluateVerdict(a, { verdict: VERDICT.APPROVE, score: 9, authority: AUTHORITY.TEACHER });
  assert.equal(good.apply, true);
  assert.equal(good.status, STATUS.REVIEWED);
  assert.equal(good.decidedBy, AUTHORITY.TEACHER);

  const rej = evaluateVerdict(a, { verdict: VERDICT.REJECT, authority: AUTHORITY.TEACHER });
  assert.equal(rej.apply, true);
  assert.equal(rej.status, STATUS.REJECTED);

  const human = evaluateVerdict(a, { verdict: VERDICT.REJECT, authority: AUTHORITY.HUMAN });
  assert.equal(human.apply, true);
  assert.equal(human.decidedBy, AUTHORITY.HUMAN);

  // Once a human has decided, a later teacher verdict is ignored.
  const afterHuman = evaluateVerdict(
    { ...a, status: STATUS.REJECTED, decidedBy: AUTHORITY.HUMAN },
    { verdict: VERDICT.APPROVE, score: 10, authority: AUTHORITY.TEACHER },
  );
  assert.equal(afterHuman.apply, false);
  assert.equal(afterHuman.status, STATUS.REJECTED);
});
