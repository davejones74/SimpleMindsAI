import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RETIRED_REPLAY_CLASS,
  classifyRetiredArticle,
} from "../src/training/retired-replay-audit.js";
import { STATUS, contentHash } from "../src/domain/article.js";

const long = (name) => `Article ${name}. ` + Array.from({ length: 30 }, (_, i) => `Sentence ${name}-${i} describes a complete English topic with pressure, motion and engineering detail.`).join(" ");
const base = (over = {}) => ({ status: STATUS.RETIRED, consumedAt: "2026-01-01T00:00:00Z", ...over });
const approve = { verdict: "approve", score: 9, at: "2026-01-01T00:00:00Z" };

test("safe approved consumed retired material is recoverable", () => {
  const text = long("safe");
  const result = classifyRetiredArticle(base({
    articleId: "safe",
    text,
    contentHash: contentHash(text),
    sourceUrl: "https://science.nasa.gov/mission/webb/",
  }), [approve]);
  assert.equal(result.classification, RETIRED_REPLAY_CLASS.RECOVERABLE_SAFE);
});

test("uncertain and unknown licences stay blocked", () => {
  const wikiText = long("wiki");
  const wiki = classifyRetiredArticle(base({
    articleId: "wiki",
    text: wikiText,
    contentHash: contentHash(wikiText),
    sourceUrl: "https://en.wikipedia.org/wiki/Example",
  }), [approve]);
  assert.equal(wiki.classification, RETIRED_REPLAY_CLASS.BLOCKED_LICENCE_UNCERTAIN);

  const unknownText = long("unknown");
  const unknown = classifyRetiredArticle(base({
    articleId: "unknown",
    text: unknownText,
    contentHash: contentHash(unknownText),
    sourceUrl: "https://example.org/unknown",
  }), [approve]);
  assert.equal(unknown.classification, RETIRED_REPLAY_CLASS.BLOCKED_LICENCE_UNKNOWN);
});

test("quality, approval, integrity and consumption blockers are explicit", () => {
  const short = classifyRetiredArticle(base({
    articleId: "short",
    text: "A title only.",
    contentHash: contentHash("A title only."),
    sourceUrl: "https://science.nasa.gov/x",
  }), [approve]);
  assert.equal(short.classification, RETIRED_REPLAY_CLASS.BLOCKED_QUALITY);

  const shortProse = "The steam engine used pressure to move a piston and turn a wheel.";
  const safeShort = classifyRetiredArticle(base({
    articleId: "safe-short",
    text: shortProse,
    contentHash: contentHash(shortProse),
    sourceUrl: "https://science.nasa.gov/x",
  }), [approve]);
  assert.equal(safeShort.classification, RETIRED_REPLAY_CLASS.RECOVERABLE_SAFE_SHORT);

  const text = long("noapprove");
  const noApproval = classifyRetiredArticle(base({
    articleId: "noapprove",
    text,
    contentHash: contentHash(text),
    sourceUrl: "https://science.nasa.gov/x",
  }), [{ verdict: "reject", at: "2026-01-01T00:00:00Z" }]);
  assert.equal(noApproval.classification, RETIRED_REPLAY_CLASS.BLOCKED_NO_APPROVAL);

  const integrity = classifyRetiredArticle(base({
    articleId: "integrity",
    text,
    contentHash: "wrong",
    sourceUrl: "https://science.nasa.gov/x",
  }), [approve]);
  assert.equal(integrity.classification, RETIRED_REPLAY_CLASS.BLOCKED_INTEGRITY);

  const notConsumed = classifyRetiredArticle({
    articleId: "not-consumed",
    text,
    contentHash: contentHash(text),
    status: STATUS.RETIRED,
    sourceUrl: "https://science.nasa.gov/x",
  }, [approve]);
  assert.equal(notConsumed.classification, RETIRED_REPLAY_CLASS.NOT_CONSUMED_RETIRED);
});

test("already replayable material is not reclassified", () => {
  const text = long("eligible");
  const result = classifyRetiredArticle(base({
    articleId: "eligible",
    text,
    contentHash: contentHash(text),
    replayEligible: true,
    sourceUrl: "https://science.nasa.gov/x",
  }), [approve]);
  assert.equal(result.classification, RETIRED_REPLAY_CLASS.ALREADY_ELIGIBLE);
});
