import { test } from "node:test";
import assert from "node:assert/strict";
import { preflightMaterial } from "../src/training/material-preflight.js";

function storeWith(texts) {
  return {
    getStats: () => ({ trainable: texts.length }),
    articlesPage: () => ({ items: texts.map((text, i) => ({ articleId: `a${i}`, text, status: "REVIEWED", sourceUrl: `https://example.org/grammar/${i}`, sourceDomain: "example.org", fetchedContentHash: `s${i}`, contentHash: `h${i}` })), nextCursor: null }),
  };
}
const cfg = (over = {}) => ({
  jobs: { training: { minEligible: 1 } },
  trainMinFreshTokens: 100,
  validationBank: { enabled: false },
  paths: { validationBanks: ".none" },
  ...over,
});

test("preflight waits before RUN.lock when fresh material is below the floor", async () => {
  await assert.rejects(
    preflightMaterial({ store: storeWith(["short".repeat(20)]), config: cfg() }),
    (err) => err.code === "INSUFFICIENT_FRESH_DATA",
  );
});

test("preflight passes when enough estimated fresh material exists", async () => {
  const out = await preflightMaterial({ store: storeWith(["x".repeat(500)]), config: cfg() });
  assert.equal(out.ok, true);
  assert.ok(out.estimatedFreshTokens >= 100);
});

test("preflight fails closed when validation bank is missing", async () => {
  await assert.rejects(
    preflightMaterial({ store: storeWith(["x".repeat(500)]), config: cfg({ validationBank: { enabled: true }, trainValBlocks: 32 }) }),
    (err) => err.code === "INSUFFICIENT_VALIDATION_BANK",
  );
});
