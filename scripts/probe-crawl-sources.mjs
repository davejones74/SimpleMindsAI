// Probe candidate crawl sources BEFORE committing them to CRAWL_URLS.
// Each URL goes through the real SSRF-aware fetcher + robots.txt check, so a
// source that works here will work in the Observatory learning job.
// Usage: node scripts/probe-crawl-sources.mjs <url> [url ...]
import { collectDocuments } from "../src/harness/crawler.js";

const urls = process.argv.slice(2);
if (!urls.length) {
  console.log("usage: node scripts/probe-crawl-sources.mjs <url> [url ...]");
  process.exit(2);
}

let bad = 0;
for (const url of urls) {
  try {
    const r = await collectDocuments({ mode: "real", urls: [url] });
    const ok = r.documents.length === 1 && r.failures.length === 0;
    if (!ok) bad++;
    const doc = r.documents[0];
    console.log(
      `${ok ? "OK  " : "FAIL"} ${url}\n` +
        `      mode=${r.mode} fetched=${r.documents.length} failures=${r.failures.length}` +
        (doc
          ? `\n      bytes=${doc.bytes} title=${JSON.stringify((doc.title ?? "").slice(0, 70))} text=${JSON.stringify(
              (doc.text ?? "").slice(0, 70)
            )}`
          : "") +
        (r.failures.length ? `\n      reason=${r.failures[0].reason}` : "")
    );
  } catch (err) {
    bad++;
    console.log(`ERR  ${url}\n      ${err.message}`);
  }
}
console.log(bad === 0 ? "\nALL SOURCES OK" : `\n${bad} source(s) failed`);
process.exit(bad === 0 ? 0 : 1);
