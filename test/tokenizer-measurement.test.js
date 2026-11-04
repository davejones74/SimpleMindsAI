import { test } from "node:test";
import assert from "node:assert/strict";

import { measureDocuments } from "../src/training/tokenizer-measurement.js";

test("measureDocuments delegates rows to the Python measurement contract", async () => {
  let seen = null;
  const run = async ({ payload }) => {
    seen = payload;
    return {
      schema: "sma/token-measurement@1",
      sequenceLength: payload.seqLen,
      documentCount: payload.rows.length,
      totalTokens: 300,
      blocksIfConcatenated: 2,
      droppedTokens: 44,
      documentsMeetingOneBlock: 1,
      documents: [{ itemId: payload.rows[0].itemId, tokens: 200, meetsOneBlock: true }],
    };
  };
  const result = await measureDocuments([
    { itemId: "a", text: "first" },
    { itemId: "b", text: "second" },
  ], { tokenizerPath: "/tmp/tokenizer.json", seqLen: 128, run });
  assert.equal(seen.tokenizerPath, "/tmp/tokenizer.json");
  assert.equal(seen.seqLen, 128);
  assert.equal(seen.rows.length, 2);
  assert.equal(result.blocksIfConcatenated, 2);
  assert.equal(result.documentsMeetingOneBlock, 1);
});

test("measureDocuments handles an empty cohort without spawning Python", async () => {
  const result = await measureDocuments([], {
    tokenizerPath: "/tmp/tokenizer.json",
    run: async () => { throw new Error("must not run"); },
  });
  assert.equal(result.documentCount, 0);
  assert.equal(result.totalTokens, 0);
  assert.equal(result.blocksIfConcatenated, 0);
});
