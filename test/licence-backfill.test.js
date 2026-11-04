import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { ArticleStore } from "../src/storage/article-store.js";

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-licence-backfill-")));

test("licence backfill dry-run is read-only and apply is append-only", async () => {
  const dir = tmp();
  // Simulate a legacy record written before licence resolution existed.
  const store = await ArticleStore.open(dir, { licence: { enforcement: "off" } });
  const article = await store.ingestArticle({
    text: "A durable article about steam engine pressure and motion. ".repeat(10),
    sourceUrl: "https://science.nasa.gov/mission/webb/",
  });
  await store.close();

  const script = new URL("../scripts/knowledge-pilot/backfill-licences.mjs", import.meta.url).pathname;
  const dry = JSON.parse(execFileSync(process.execPath, [script, "--store", dir], { encoding: "utf8" }));
  assert.equal(dry.mode, "dry-run");
  assert.equal(dry.resolved, 1);
  assert.equal(dry.byStatus["safe:allow"], 1);

  const before = await ArticleStore.open(dir, { readOnly: true });
  assert.equal(before.getArticle(article.articleId).licence, undefined, "dry-run must not write");
  await before.close();

  const applied = JSON.parse(execFileSync(process.execPath, [script, "--store", dir, "--apply", "--confirm"], { encoding: "utf8" }));
  assert.equal(applied.mode, "apply");
  assert.equal(applied.resolved, 1);

  const after = await ArticleStore.open(dir, { readOnly: true });
  assert.equal(after.getArticle(article.articleId).licence.status, "safe");
  assert.equal(after.getArticle(article.articleId).licence.decision, "allow");
  await after.close();
});
