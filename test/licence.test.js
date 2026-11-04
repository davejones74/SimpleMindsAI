import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEFAULT_LICENCE_POLICY,
  LICENCE_DECISION,
  LICENCE_STATUS,
  licenceAllowsTraining,
  resolveLicence,
} from "../src/domain/licence.js";
import { ArticleStore } from "../src/storage/article-store.js";
import { STATUS, isReplayPool } from "../src/domain/article.js";

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-licence-")));
const body = (name) => `Article ${name}. ` + Array.from({ length: 20 }, (_, i) => `Sentence ${name}-${i} describes a distinct English topic with a complete clause.`).join(" ");

test("runtime licence policy is pinned to the audited replay policy", () => {
  const policy = JSON.parse(readFileSync(new URL("../scripts/knowledge-pilot/replay-licence-policy.json", import.meta.url), "utf8"));
  assert.deepEqual(DEFAULT_LICENCE_POLICY.safeDomains, policy.safeDomains);
  assert.deepEqual(DEFAULT_LICENCE_POLICY.uncertainDomains, policy.uncertainDomains);
});

test("licence resolution is conservative and host-aware", () => {
  const safe = resolveLicence({ sourceUrl: "https://science.nasa.gov/mission/webb/" });
  assert.equal(safe.status, LICENCE_STATUS.SAFE);
  assert.equal(safe.decision, LICENCE_DECISION.ALLOW);

  const uncertain = resolveLicence({ sourceUrl: "https://en.wikipedia.org/wiki/Steam_engine" });
  assert.equal(uncertain.status, LICENCE_STATUS.UNCERTAIN);
  assert.equal(uncertain.decision, LICENCE_DECISION.REVIEW);
  assert.equal(uncertain.id, "CC-BY-SA-4.0");

  const restricted = resolveLicence({ sourceUrl: "https://example.org/a", licenceId: "CC-BY-NC-4.0" });
  assert.equal(restricted.status, LICENCE_STATUS.RESTRICTED);
  assert.equal(restricted.decision, LICENCE_DECISION.DENY);
  assert.equal(restricted.commercialUse, false);

  const unknown = resolveLicence({ sourceUrl: "https://example.org/a" });
  assert.equal(unknown.status, LICENCE_STATUS.UNKNOWN);
  assert.equal(unknown.decision, LICENCE_DECISION.REVIEW);
});

test("training/replay allowance follows enforcement", () => {
  const uncertain = resolveLicence({ sourceUrl: "https://en.wikipedia.org/wiki/Steam_engine" });
  assert.equal(licenceAllowsTraining(uncertain, { enforcement: "shadow" }), true);
  assert.equal(licenceAllowsTraining(uncertain, { enforcement: "enforce" }), false);
  const safe = resolveLicence({ sourceUrl: "https://science.nasa.gov/mission/webb/" });
  assert.equal(licenceAllowsTraining(safe, { enforcement: "enforce" }), true);
});

test("ingest records durable licence provenance and replays it after reopen", async () => {
  const dir = tmp();
  const store = await ArticleStore.open(dir);
  const article = await store.ingestArticle({
    text: body("nasa"),
    sourceUrl: "https://science.nasa.gov/mission/webb/",
  });
  assert.equal(article.licence.status, LICENCE_STATUS.SAFE);
  assert.equal(article.licence.decision, LICENCE_DECISION.ALLOW);
  assert.equal(store.getStats().licenceSafe, 1);
  await store.close();

  const reopened = await ArticleStore.open(dir);
  const loaded = reopened.getArticle(article.articleId);
  assert.equal(loaded.licence.status, LICENCE_STATUS.SAFE);
  assert.equal(loaded.licence.policyVersion, DEFAULT_LICENCE_POLICY.version);
  await reopened.close();
});

test("explicit restricted licence is refused when enforcement is on", async () => {
  const store = await ArticleStore.open(tmp(), { licence: { enforcement: "enforce" } });
  const skipped = await store.ingestArticle({
    text: body("restricted"),
    sourceUrl: "https://example.org/restricted",
    licenceId: "CC-BY-NC-4.0",
  });
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, "licence-restricted");
  assert.equal(store.getStats().totalArticles, 0);

  const allowed = await store.ingestArticle({
    text: body("safe"),
    sourceUrl: "https://science.nasa.gov/mission/webb/",
  });
  assert.equal(allowed.skipped, undefined);
  assert.equal(store.getStats().totalArticles, 1);
  await store.close();
});

test("a later licence correction is append-only and can exclude replay", async () => {
  const store = await ArticleStore.open(tmp());
  const article = await store.ingestArticle({
    text: body("corrected"),
    sourceUrl: "https://en.wikipedia.org/wiki/Example",
  });
  assert.equal(isReplayPool(store.getArticle(article.articleId)), false);
  await store.setLicence(article.articleId, { licenceId: "CC-BY-NC-4.0" });
  assert.equal(store.getArticle(article.articleId).licence.status, LICENCE_STATUS.RESTRICTED);
  await store.recordReview({ articleId: article.articleId, verdict: "approve", authority: "human" });
  await store.markConsumed([article.articleId], { runId: "run-1" });
  assert.equal(store.getArticle(article.articleId).status, STATUS.REVIEWED);
  assert.equal(isReplayPool(store.getArticle(article.articleId)), false, "restricted licence cannot enter replay");
  await store.close();
});
