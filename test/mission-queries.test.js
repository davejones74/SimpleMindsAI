import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveMissionQueries, resolveSearchQueries, MISSION_QUERY_TEMPLATES } from "../src/discovery/mission-queries.js";
import { DiscoveryService } from "../src/discovery/discovery-service.js";
import { config } from "../src/config.js";

/**
 * P4 — mission-driven acquisition, deterministic templates (locked decision #3).
 * No model, no randomness: the same mission always yields the same queries, and
 * the feature is inert unless MISSION_QUERIES_ENABLED is on.
 */

const PRIMARY =
  "To accurately comprehend the nuances of human language, transforming unstructured text into clear, contextual insights.";

test("deriveMissionQueries is deterministic", () => {
  const a = deriveMissionQueries(PRIMARY, { max: 6 });
  const b = deriveMissionQueries(PRIMARY, { max: 6 });
  assert.deepEqual(a, b);
  assert.ok(a.length > 0);
  assert.ok(a.every((q) => typeof q === "string" && q.trim() === q && q.length > 0));
});

test("deriveMissionQueries applies the template set to each topic", () => {
  assert.deepEqual(deriveMissionQueries("human language", { max: 4 }), [
    "human language",
    "human language explained",
    "human language history",
    "how human language works",
  ]);
  assert.equal(MISSION_QUERY_TEMPLATES[0], "{topic}");
});

test("deriveMissionQueries respects max and de-duplicates", () => {
  const q = deriveMissionQueries([PRIMARY, "human language"], { max: 5 });
  assert.equal(q.length, 5);
  assert.equal(new Set(q).size, q.length, "no duplicate queries");
});

test("deriveMissionQueries returns [] for empty/blank/missing input", () => {
  assert.deepEqual(deriveMissionQueries([], {}), []);
  assert.deepEqual(deriveMissionQueries([""], {}), []);
  assert.deepEqual(deriveMissionQueries(["   ", null, undefined], {}), []);
  assert.deepEqual(deriveMissionQueries(undefined, {}), []);
  assert.deepEqual(deriveMissionQueries(PRIMARY, { max: 0 }), []);
});

test("resolveSearchQueries: disabled returns configured queries unchanged", () => {
  const configured = ["alpha", "beta"];
  assert.deepEqual(resolveSearchQueries({ configured, missionTexts: PRIMARY, enabled: false }), ["alpha", "beta"]);
});

test("resolveSearchQueries: enabled keeps configured first and appends derived, de-duplicated", () => {
  const out = resolveSearchQueries({ configured: ["alpha", "human language"], missionTexts: "human language", enabled: true, max: 4 });
  assert.equal(out[0], "alpha");
  assert.equal(out[1], "human language");
  assert.equal(out.filter((q) => q === "human language").length, 1, "configured query is not duplicated");
  assert.ok(out.includes("how human language works"));
});

test("DiscoveryService: mission queries are inert by default and active only when enabled", () => {
  const base = { frontier: {}, domainRegistry: { list: () => [] }, adapters: [] };
  const missionTexts = [PRIMARY, "To continually refine its understanding through ethical learning."];

  const off = new DiscoveryService({ ...base, missionTexts });
  assert.equal(off.descriptor().missionQueriesEnabled, false);
  assert.equal(off.descriptor().searchQueries, config.crawlSearchQueries.length, "flag off => configured queries only");

  const on = new DiscoveryService({ ...base, missionTexts, missionQueriesEnabled: true, missionQueryMax: 6 });
  assert.equal(on.descriptor().missionQueriesEnabled, true);
  assert.ok(on.descriptor().searchQueries > config.crawlSearchQueries.length, "derived queries are appended when enabled");
});
