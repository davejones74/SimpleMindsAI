import { config } from "../config.js";
import { ArticleStore } from "../storage/article-store.js";
import { assessContentQuality } from "../domain/content-quality.js";
import { QUARANTINE_REASON } from "../domain/article.js";

const argv = process.argv.slice(2);
const dryRun = !argv.includes("--quarantine");
const limitArg = argv.indexOf("--limit");
const limit = limitArg >= 0 ? Math.max(1, Number(argv[limitArg + 1]) || 500) : 500;
const orderArg = argv.indexOf("--order");
const order = orderArg >= 0 && argv[orderArg + 1] === "desc" ? "desc" : "asc";
const store = await ArticleStore.open(config.paths.articles);
try {
  const counts = {};
  const samples = [];
  let cursor = null;
  let scanned = 0;
  while (scanned < limit) {
    const page = store.articlesPage({ after: cursor, limit: Math.min(200, limit - scanned), status: "REVIEWED", order });
    if (!page.items.length) break;
    for (const article of page.items) {
      scanned += 1;
      const quality = assessContentQuality({ url: article.sourceUrl ?? "", title: article.title ?? "", text: article.text ?? "" });
      if (quality.decision === "allow") continue;
      for (const reason of quality.reasons) counts[reason] = (counts[reason] ?? 0) + 1;
      samples.push({ articleId: article.articleId, sourceUrl: article.sourceUrl, score: quality.score, reasons: quality.reasons, excluded: article.quarantined === true });
      if (!dryRun && article.quarantined !== true) {
        await store.quarantineArticle(article.articleId, {
          reason: QUARANTINE_REASON.COMMERCIAL_SEO,
          detail: `content-quality-v1 score=${quality.score.toFixed(3)} reasons=${quality.reasons.join(",")}`,
          actor: "automation",
        });
      }
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  console.log(JSON.stringify({ dryRun, scanned, excluded: samples.length, reasons: counts, samples: samples.slice(0, 50) }, null, 2));
} finally {
  await store.close?.();
}
