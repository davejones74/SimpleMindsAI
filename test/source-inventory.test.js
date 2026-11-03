import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  buildInventory,
  checkOutputs,
  writeOutputs,
  validateSources,
  INVENTORY_PATH,
  MANIFEST_PATH,
  METRICS_PATH,
  REPORT_PATH,
} from "../scripts/build-source-inventory.mjs";

test("inventory builds, validates and satisfies composition policy", () => {
  const { inventory, metrics } = buildInventory();
  assert.equal(inventory.validation.sourceErrors.length, 0);
  assert.equal(inventory.validation.warnings.length, 0);
  assert.equal(metrics.allChecksPassed, true, JSON.stringify(metrics.checks.filter((check) => !check.ok), null, 2));
  assert.ok(inventory.summary.totalSources >= 40);
  assert.ok(inventory.summary.approvedUnrestricted >= 30);
  assert.ok(inventory.summary.unrestrictedPublishers >= inventory.compositionPolicy.minIndependentPublishers);
  assert.ok(inventory.summary.unrestrictedSourceFamilies >= inventory.compositionPolicy.minSourceFamilies);
  assert.equal(inventory.summary.unrestrictedSubjects, 10);
});

test("unrestricted pool contains only commercial-use, non-share-alike, non-NC, non-ND sources", () => {
  const { inventory } = buildInventory();
  for (const source of inventory.sources.filter((item) => item.pool === "unrestricted")) {
    assert.equal(source.status, "approved", source.sourceId);
    assert.equal(source.licence.commercialUse, "allowed", source.sourceId);
    assert.equal(source.licence.nonCommercial, false, source.sourceId);
    assert.equal(source.licence.shareAlike, false, source.sourceId);
    assert.equal(source.licence.noDerivatives, false, source.sourceId);
  }
});

test("share-alike and non-commercial pools are separated and do not contribute planned target tokens", () => {
  const { inventory, metrics } = buildInventory();
  for (const source of inventory.sources.filter((item) => item.pool === "share-alike")) {
    assert.equal(source.licence.shareAlike, true, source.sourceId);
    assert.equal(source.licence.nonCommercial, false, source.sourceId);
  }
  for (const source of inventory.sources.filter((item) => item.pool === "non-commercial")) {
    assert.equal(source.licence.nonCommercial, true, source.sourceId);
    assert.equal(source.estimates.plannedDocuments, 0, source.sourceId);
    assert.equal(source.status, "restricted", source.sourceId);
  }
  assert.equal(metrics.pools.unrestricted.conservativePlannedNovelTokens, inventory.summary.conservativePlannedNovelTokens);
  assert.equal(metrics.pools["non-commercial"].conservativePlannedNovelTokens, 0);
  assert.ok(metrics.pools["share-alike"].conservativePlannedNovelTokens > 0);
});

test("capacity and planned draw exceed target with headroom", () => {
  const { inventory, metrics } = buildInventory();
  const policy = inventory.compositionPolicy;
  const minimum = policy.targetNovelTokens * (1 + policy.minimumHeadroomRatio);
  assert.ok(metrics.pools.unrestricted.conservativeNovelCapacityTokens >= minimum);
  assert.ok(metrics.pools.unrestricted.conservativePlannedNovelTokens >= minimum);
  assert.ok(inventory.summary.capacityHeadroomRatio >= 1 + policy.minimumHeadroomRatio);
  assert.ok(inventory.summary.plannedHeadroomRatio >= 1 + policy.minimumHeadroomRatio);
});

test("concentration and subject limits hold", () => {
  const { inventory, metrics } = buildInventory();
  const policy = inventory.compositionPolicy;
  assert.ok(metrics.concentration.publishers.planned.top1Share <= policy.maxPublisherShare);
  assert.ok(metrics.concentration.publisherGroups.planned.top1Share <= policy.maxPublisherGroupShare);
  assert.ok(metrics.concentration.sourceFamilies.planned.top1Share <= policy.maxSourceFamilyShare);
  assert.ok(metrics.concentration.subjects.planned.top1Share <= policy.maxSubjectShare);
  assert.ok(metrics.concentration.formats.planned.top1Share <= policy.maxFormatShare);
  const usFederal = metrics.concentration.governanceGroups.planned.distribution.find((item) => item.key === "us-federal")?.share ?? 0;
  assert.ok(usFederal <= policy.maxUsFederalShare);
  for (const subject of metrics.concentration.subjects.planned.distribution) {
    assert.ok(subject.share >= policy.minSubjectShare, subject.key);
  }
});

test("every source documents licence, access rule, estimates and v1 overlap", () => {
  const { inventory } = buildInventory();
  for (const source of inventory.sources) {
    assert.ok(source.licence.name, source.sourceId);
    assert.ok(source.licence.version, source.sourceId);
    assert.ok(source.licence.url, source.sourceId);
    assert.ok(source.licence.conditions.length > 0, source.sourceId);
    assert.ok(source.access.method, source.sourceId);
    assert.ok(source.access.urlGenerationRule, source.sourceId);
    assert.ok(source.access.exampleUrls.length > 0, source.sourceId);
    assert.ok(source.v1Overlap.method, source.sourceId);
    assert.ok(source.screening.method, source.sourceId);
    assert.ok(source.estimates.basis, source.sourceId);
    assert.ok(source.estimates.limitations, source.sourceId);
    assert.ok(source.computed.conservativeNovelCapacityTokens >= 0, source.sourceId);
    assert.ok(source.computed.conservativePlannedNovelTokens >= 0, source.sourceId);
  }
});

test("generated artifacts are reproducible and manifest hashes verify", async () => {
  const first = await writeOutputs();
  const second = await writeOutputs();
  assert.equal(first.manifest.inventorySha256, second.manifest.inventorySha256);
  const check = await checkOutputs();
  assert.deepEqual(check.problems, []);
  const inventory = JSON.parse(await readFile(INVENTORY_PATH, "utf8"));
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  const metrics = JSON.parse(await readFile(METRICS_PATH, "utf8"));
  const report = await readFile(REPORT_PATH, "utf8");
  assert.equal(manifest.inventorySha256, manifest.files.inventory.sha256);
  assert.equal(inventory.inventoryVersion, manifest.inventoryVersion);
  assert.equal(metrics.allChecksPassed, true);
  assert.match(report, /7\.75M|7,750,000/);
  assert.match(report, /No acquisition, crawl, training/);
});

test("validation rejects an unrestricted source with a non-commercial licence", () => {
  const { inventory } = buildInventory();
  const bad = JSON.parse(JSON.stringify(inventory.sources.find((source) => source.pool === "unrestricted")));
  bad.licenceId = "WHO-CC-BY-NC-SA";
  bad.pool = "unrestricted";
  const result = validateSources([bad]);
  assert.ok(result.errors.some((error) => error.includes("commercial-use") || error.includes("non-commercial") || error.includes("share-alike")));
});
