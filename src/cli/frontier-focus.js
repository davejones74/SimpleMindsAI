import { Frontier } from "../frontier.js";
import { config } from "../config.js";
import { LANGUAGE_MECHANICS_TERMS, LANGUAGE_MECHANICS_PHRASES } from "../discovery/mission-profile.js";

/**
 * One-off focus annotation for the existing frontier.
 *
 * New candidates are focus-gated at discovery. This CLI scores the already
 * queued backlog so `claimNext` can fetch language-mechanics URLs before the
 * old broad queue. It only writes `focusClass`/score metadata; article and
 * frontier state is otherwise untouched.
 */
function parseArgs(argv) {
  const out = { dryRun: false };
  for (const arg of argv) {
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log("Usage: node src/cli/frontier-focus.js [--dry-run]");
  process.exit(0);
}
const frontier = new Frontier({ dir: config.paths.frontier });
await frontier.init();
const result = await frontier.annotateFocus({
  terms: LANGUAGE_MECHANICS_TERMS,
  phrases: LANGUAGE_MECHANICS_PHRASES,
  minScore: 0.08,
  dryRun: args.dryRun,
});
console.log(JSON.stringify({ ...result, dryRun: args.dryRun }, null, 2));
