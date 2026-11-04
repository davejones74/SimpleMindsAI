#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeFile } from "node:fs/promises";

import { ArticleStore } from "../../src/storage/article-store.js";
import { createDomainRegistry } from "../../src/storage/domain-registry.js";
import { Frontier } from "../../src/frontier.js";
import { AdmissionPolicyManager } from "../../src/gateway/admission-policy.js";
import { AcquisitionGateway } from "../../src/gateway/acquisition-gateway.js";
import { runCrawlBatches } from "../../src/harness/crawler.js";
import { OllamaClient } from "../../src/services/ollama-client.js";
import { ReviewScorer } from "../../src/reward/reward-scorer.js";
import { runLearningCycle } from "../../src/jobs/learning.js";
import { config } from "../../src/config.js";

const url = process.argv[2];
const outPath = process.argv[3] ?? null;
if (!url) throw new Error("usage: activation-acquire-validation.mjs <url> [report.json]");

const tmp = await mkdtemp(path.join(os.tmpdir(), "sma-activation-acquire-"));
const store = await ArticleStore.open();
try {
  const admissionManager = await AdmissionPolicyManager.open({
    dir: config.paths.admission,
    config: {
      capLimit: config.admissionCapLimit,
      capEpoch: config.admissionCapEpoch,
      ackRequired: config.admissionAckRequired,
      protocolVersion: config.admissionProtocolVersion,
    },
    logger: console,
  });
  const admissionGateway = new AcquisitionGateway({
    store: admissionManager.store,
    epochManager: admissionManager,
  });
  const frontier = new Frontier({ dir: path.join(tmp, "frontier") });
  await frontier.init();
  await frontier.enqueue(url, { depth: 0, seed: url });
  const domainRegistry = createDomainRegistry({ dir: path.join(tmp, "domains") });
  const crawl = await runCrawlBatches({
    frontier,
    domainRegistry,
    maxCycles: 1,
    maxPages: 1,
    maxDepth: 0,
    maxLinksPerPage: 0,
    admissionGateway,
    languageFilter: config.languageFilter,
  });
  if (!crawl.documents?.length) throw new Error(`targeted acquisition returned no documents (failures=${crawl.failures?.length ?? 0}): ${JSON.stringify((crawl.failures ?? []).slice(0, 3))}`);
  const ollama = new OllamaClient();
  const scorer = new ReviewScorer({ ollama });
  const learned = await runLearningCycle({
    store,
    ollama,
    scorer,
    maxRawDocs: 1,
    collectDocuments: async () => ({
      mode: "real",
      capability: "targeted-fetch",
      documents: crawl.documents,
      failures: crawl.failures ?? [],
    }),
    log: (_level, message) => console.log(`[activation-acquire] ${message}`),
  });
  const report = {
    schema: "sma/activation-acquisition@1",
    at: new Date().toISOString(),
    url,
    fetched: crawl.documents.map((d) => ({ url: d.url, title: d.title, chars: String(d.text ?? "").length, contentHash: d.contentHash, htmlLang: d.htmlLang })),
    ingested: learned.ingested,
    deduped: learned.deduped,
    reviewed: learned.reviewed,
    retired: learned.retired,
    failed: learned.failed,
    pendingAfter: learned.pendingAfter,
  };
  const bytes = `${JSON.stringify(report, null, 2)}\n`;
  if (outPath) await writeFile(outPath, bytes, "utf8");
  else process.stdout.write(bytes);
} finally {
  await store.close();
  await rm(tmp, { recursive: true, force: true });
}
