import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Harvester (Subsystem A, front half).
 *
 * THIS FILE IS A PLACEHOLDER ON PURPOSE — web crawling is a genuine product
 * surface (ToS, robots.txt, rate limits, PII scrubbing, boilerplate) and you
 * should NOT ship a real crawler inside a prototype loop. It emits 3 sample
 * raw docs (one deliberately garbage) so `npm run curate` has something real
 * to chew on and the fixture/cleaner pipeline can be smoke-tested.
 *
 * When you replace it, keep this contract:
 *   async function* harvest(): AsyncGenerator<string>  // one raw text blob each
 *   -> write JSONL into ./data/raw (auto-picked-up by curator)
 */

const SAMPLE = [
  `|| History of the steam engine ||
The steam engine was developed in Britain during the 18th century. Thomas
Newcomen built the first practical atmospheric engine in 1712. James Watt added
a separate condenser in 1769, dramatically improving fuel efficiency, which made
steam power economical for factories and, later, locomotives.`,
  `LIMITED TIME! Buy our miracle supplement now!!! 90% off!!! Click HERE for the
one weird trick doctors hate. 100% natural, guaranteed results in 24 hours,
no scientific basis whatsoever, just give us your credit card number.`,
  `|| How photosynthesis works ||
Photosynthesis converts light energy into chemical energy. In chloroplasts,
chlorophyll absorbs red and blue light. The light-dependent reactions split
water, releasing oxygen, and produce ATP and NADPH. The Calvin cycle then fixes
CO2 into glucose using that ATP and NADPH.`,
];

export async function harvest(docs = SAMPLE) {
  const dir = "data/raw";
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, "sample.ndjson");
  await writeFile(file, docs.map((d) => JSON.stringify({ text: d, source: "harness-sample", ts: new Date().toISOString() })).join("\n") + "\n", "utf8");
  return file;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop())) {
  const file = await harvest();
  const raw = await readFile(file, "utf8");
  console.log(`wrote ${raw.trim().split("\n").length} raw docs -> ${file}`);
  console.log(`next: npm run curate -- --file ${file}`);
}