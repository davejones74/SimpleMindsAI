import { Frontier } from "../frontier.js";
import { config } from "../config.js";
import { CAPABILITY, runCrawlBatches, seedFrontierFromConfig } from "../harness/crawler.js";
import { createDiscoveryPolicy } from "./discovery-policy.js";
import { createDomainRegistry } from "../storage/domain-registry.js";

/**
 * DiscoveryService — the acquisition front end for the learning job.
 *
 * It turns the persistent URL frontier into raw documents: each cycle it fetches
 * the next eligible frontier URL, extracts policy-approved links (following
 * references and exploring adjacent sources), enqueues them, and returns the
 * documents it actually fetched. The configured CRAWL_URLS are BOOTSTRAP seeds,
 * not a permanent boundary — expansion is governed by the discovery policy and
 * still passes every fetch-time safety check (scheme, SSRF, robots, byte and
 * redirect caps, depth and budget bounds).
 *
 * The design is intentionally extensible: additional Discoverers (sitemaps,
 * feeds, search adapters) can enqueue URLs into the same frontier, and their
 * provenance flows through the same path, without the learning or training
 * layers changing.
 */
export class DiscoveryService {
  constructor({ frontier, policy = null, seeds = config.crawlUrls, log = () => {} } = {}) {
    this.frontier = frontier ?? new Frontier({ dir: config.paths.frontier });
    this.seeds = (seeds ?? []).filter(Boolean);
    this.policy =
      policy ??
      createDiscoveryPolicy({
        seedUrls: this.seeds,
        allowedDomains: config.crawlAllowedDomains,
        deniedDomains: config.crawlDeniedDomains,
        mode: config.crawlDiscoveryPolicy,
      });
    this.log = log;
    this.domainRegistry = createDomainRegistry({ dir: config.paths.frontier });
    // Discovery is inherently a live crawler; the server only wires it when
    // CRAWL_MODE=real. Its reported mode must therefore be `real`.
    this.mode = "real";
  }

  /** Reporting descriptor — must match what `collect` actually does. */
  descriptor() {
    return { mode: this.mode, urls: this.seeds, source: "discovery", policy: this.policy.mode };
  }

  /**
   * Fetch up to `maxPages` documents from the frontier this cycle, following
   * policy-approved links. Returns the raw-doc shape the learning job curates.
   */
  async collect(ctx = {}) {
    const maxPages = Number.isFinite(ctx.maxPages) ? ctx.maxPages : config.crawlPagesPerCycle;
    const maxCycles = Number.isFinite(ctx.maxCycles) ? ctx.maxCycles : maxPages;

    await this.frontier.init();
    // Recover URLs left in-progress by a crashed cycle before claiming new ones.
    await this.frontier.recoverStaleClaims({ claimTimeoutMs: config.crawlCooldownMs }).catch(() => {});

    if (this.seeds.length) {
      await seedFrontierFromConfig(this.frontier, this.seeds);
    } else {
      // No configured seeds. The frontier is the ONLY thing that would otherwise
      // hand us URLs, and it persists across restarts — so a cleared CRAWL_URLS
      // would silently keep re-crawling whatever an earlier configuration left
      // behind. With nothing configured there is nothing legitimate to fetch.
      await this.frontier.clear();
    }

    const result = await runCrawlBatches({
      frontier: this.frontier,
      domainRegistry: this.domainRegistry,
      maxCycles: maxCycles > 0 ? maxCycles : 0,
      maxDepth: ctx.maxDepth ?? config.crawlMaxDepth,
      maxLinksPerPage: ctx.maxLinksPerPage ?? config.crawlMaxLinksPerPage,
      policy: this.policy,
      allowPrivate: ctx.allowPrivate ?? config.crawlAllowPrivate,
      respectRobots: ctx.respectRobots ?? config.crawlRespectRobots,
      userAgent: ctx.userAgent ?? config.crawlUserAgent,
    });

    return {
      mode: "real",
      capability: CAPABILITY.real,
      documents: result.documents,
      failures: result.failures,
      discovered: result.discovered,
      cycles: result.cycles,
      totalPagesFetched: result.totalPagesFetched,
      totalUrlsEnqueued: result.totalUrlsEnqueued,
      frontier: this.frontier.summary(),
      policy: this.policy.mode,
    };
  }
}
