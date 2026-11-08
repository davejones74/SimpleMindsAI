import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ArticleStore } from "../src/storage/article-store.js";
import { triagePendingArticles } from "../src/jobs/review-triage.js";

const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), "sma-triage-")));
const cfg = {
  languageFilter: { enabled: true, shadow: false, minConfidence: 0.8, unknownPolicy: "reject" },
  review: {
    gateContent: true,
    contentMinWords: 60,
    contentReferenceLineRatio: 0.5,
    contentListLineRatio: 0.6,
    contentNavDensity: 0.25,
    completenessMode: "shadow",
    gatePageChrome: true,
    gateLanguage: true,
    gateQuality: true,
  },
};

const GOOD =
  "The steam engine converted thermal energy into mechanical work because pressure acted on a piston inside a cylinder. " +
  "When the valve opened, steam that had been heated in the boiler pushed the piston, and the motion was transferred to a wheel through a connecting rod. " +
  "Engineers of the era were concerned that the apparatus would waste fuel, but the improvements that followed were remarkable and changed industry. " +
  "Newcomen built the first practical engine in 1712, and Watt's separate condenser later made the engine dramatically more efficient. " +
  "The consequences reached far beyond the mine and the mill, reshaping transport, cities, and the economy of the following century.";

const REFS =
  "Mathiez 1910, p. 1.\n" +
  "Buonarroti, Philippe (1836). History of Babeuf's conspiracy. London: H. Hetherington.\n" +
  "Phillips, Walter Alison (1911). \"Jacobins\". Encyclopaedia Britannica. Vol. 15. p. 119. ISBN 978-0-679-64536-8.\n" +
  "Cunningham, Noble E. (1957). The Jeffersonian Republicans. University of North Carolina Press. p. 217. ISBN 978-0-835-73909-2.";

test("triage dry-run identifies junk without writing reviews", async () => {
  const store = await ArticleStore.open(tmp());
  try {
    const junk = await store.ingestArticle({ text: REFS, domain: "general", reviewRequested: true });
    const good = await store.ingestArticle({ text: GOOD, domain: "general", reviewRequested: true });
    const out = await triagePendingArticles(store, { config: cfg, dryRun: true });
    assert.equal(out.rejected, 1);
    assert.equal(out.kept, 1);
    assert.equal(store.getArticle(junk.articleId).status, "PENDING_REVIEW");
    assert.equal(store.getArticle(good.articleId).status, "PENDING_REVIEW");
  } finally {
    await store.close();
  }
});

test("triage records an auditable automation reject and leaves prose pending", async () => {
  const store = await ArticleStore.open(tmp());
  try {
    const junk = await store.ingestArticle({ text: REFS, domain: "general", reviewRequested: true });
    const good = await store.ingestArticle({ text: GOOD, domain: "general", reviewRequested: true });
    const out = await triagePendingArticles(store, { config: cfg });
    assert.equal(out.rejected, 1);
    assert.equal(out.kept, 1);
    assert.equal(store.getArticle(junk.articleId).status, "REJECTED");
    assert.equal(store.getArticle(good.articleId).status, "PENDING_REVIEW");
    const [review] = store.reviewsFor(junk.articleId);
    assert.equal(review.authority, "automation");
    assert.equal(review.gate, "content");
    assert.match(review.rationale, /reference|citation|content/i);
  } finally {
    await store.close();
  }
});
