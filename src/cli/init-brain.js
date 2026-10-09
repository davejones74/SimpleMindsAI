import { initBrain, parseInitArgs } from "../training/init-brain.js";

/**
 * `npm run init:brain` — explicit, one-time baseline bootstrap.
 *
 *   node src/cli/init-brain.js                 # initialise a fresh lineage
 *   node src/cli/init-brain.js --adopt v002    # adopt an existing committed version
 */
const opts = parseInitArgs(process.argv.slice(2));
if (opts.help) {
  console.log(
    [
      "usage: npm run init:brain [-- --adopt <version>] [--config small] [--store <dir>] [--models <dir>]",
      "",
      "  --adopt <version>  adopt an existing COMMITTED version as the active baseline",
      "  --config <name>    config used for a fresh init (default: small)",
      "  --store <dir>      Python store root (default: SMA_STORE or ~/.sma/store)",
      "  --models <dir>     git-tracked record mirror (default: data/models)",
      "  --no-sync          skip mirroring version records",
    ].join("\n"),
  );
  process.exit(0);
}

try {
  const out = await initBrain(opts);
  process.exit(0);
} catch (err) {
  console.error(`[init:brain] ${err.message}`);
  process.exit(1);
}
