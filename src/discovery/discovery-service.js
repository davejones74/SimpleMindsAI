import { Frontier } from "../frontier.js";
import { config } from "../config.js";
import { CAPABILITY, runCrawlBatches, seedFrontierFromConfig } from "../harness/crawler.js";
import { createDiscoveryPolicy, hostOf } from "./discovery-policy.js";
import { createDomainRegistry, canonicalDomain } from "../storage/domain-registry.js";
import { buildAdapters, createAdapterFetchText } from "./adapters/index.js";

/**
 * DiscoveryService — the acquisition front end for the learning job.
 *
 * Each cycle it resolves where URLs should come from, feeds candidate URLs into
 * the persistent URL frontier, then fetches the next eligible frontier URLs and
 * extracts policy-approved links. CRAWL_URLS are BOOTSTRAP seeds, not a
 * permanent boundary, and an EMPTY CRAWL_URLS is not a dead end:
 *
 *   1. configured seeds (CRAWL_URLS) are enqueued when present;
 *   2. otherwise, discovery bootstraps from ELIGIBLE REGISTERED DOMAINS, then
 *      from the configured adapters (sitemap / feed / an optional search
 *      provider), then from optional CRAWL_DISCOVERY_SEEDS;
 *   3. if none of those yield roots or a provider, it reports a clear
 *      `no-source-configured` status — it never claims the web is empty.
 *
 * The service NEVER clears pending frontier entries just because the seed list
 * is empty: persisted frontier work survives restarts and continues.
 *
 * Adapters only propose candidate URLs. This service is the single writer: every
 * candidate passes the discovery policy and the domain registry (blocked domains
 * etc.) before it is enqueued, so no adapter can bypass a safety check.
 */
export class DiscoveryService {
  constructor({
    frontier,
    policy = null,
    seeds = config.crawlUrls,
    discoverySeeds = config.crawlDiscoverySeeds,
    adapters = null,
    log = () => {},
    domainRegistry = null,
    fetchText = null,
    maxRoots = config.crawlDiscoveryMaxRoots,
  } = {}) {
    this.frontier = frontier ?? new Frontier({ dir: config.paths.frontier });
    this.seeds = (seeds ?? []).filter(Boolean);
    this.discoverySeeds = (discoverySeeds ?? []).filter(Boolean);
    this.policy =
      policy ??
      createDiscoveryPolicy({
        seedUrls: this.seeds,
        allowedDomains: config.crawlAllowedDomains,
        deniedDomains: config.crawlDeniedDomains,
        mode: config.crawlDiscoveryPolicy,
      });
    this.log = log;
    // Callers may inject the process-wide registry (the server does, so the
    // admin UI and the crawler share one instance). When isolated storage is
    // required — e.g. a caller using a temp data dir — it MUST inject its own,
    // otherwise discoveries would leak into the configured live registry.
    this.domainRegistry = domainRegistry ?? createDomainRegistry({ dir: config.paths.frontier });
    // Discovery is inherently a live crawler; the server only wires it when
    // CRAWL_MODE=real. Its reported mode must therefore be `real`.
    this.mode = "real";
    this.maxRoots = maxRoots;
    // Adapters and their network access are injectable so tests can drive the
    // whole pipeline deterministically without touching the network.
    this.fetchText = fetchText ?? createAdapterFetchText();
    this.adapters = adapters ?? buildAdapters({ fetchText: this.fetchText });
  }

  /** Reporting descriptor — must match what `collect` actually does. */
  descriptor() {
    return {
      mode: this.mode,
      urls: this.seeds,
      source: "discovery",
      policy: this.policy.mode,
      adapters: this.adapters.map((a) => a.name),
    };
  }

  /** Non-blocked registered domains, important first (a priority boost only). */
  eligibleDomains() {
    if (!this.domainRegistry?.list) return [];
    let all = [];
    try {
      all = this.domainRegistry.list() ?? [];
    } catch {
      return [];
    }
    const eligible = all
      .filter((d) => d && d.domain && d.policy !== "blocked")
      // "Important" is a PRIORITY BOOST, never exclusive: important domains sort
      // first so their roots are used before ordinary ones under a root cap,
      // but ordinary eligible domains remain fully discoverable.
      .sort((a, b) => (b.policy === "important" ? 1 : 0) - (a.policy === "important" ? 1 : 0));
    return eligible.map((d) => d.domain);
  }

  /**
   * Resolve the discovery roots for this cycle and enqueue their candidates.
   * Returns a report the caller surfaces (observation + honest status).
   */
  async #bootstrapAndAdapt(ctx) {
    const bootstrap = {
      via: "none",
      seeds: 0,
      bootstrapSeeds: 0,
      registryRoots: 0,
      adapters: [],
    };
    const roots = [];

    if (this.seeds.length) {
      await seedFrontierFromConfig(this.frontier, this.seeds);
      bootstrap.seeds = this.seeds.length;
      bootstrap.via = "seeds";
      for (const s of this.seeds) {
        const host = hostOf(s);
        if (host) roots.push(originOf(s) ?? `https://${host}/`);
      }
    }

    // Optional bootstrap seed URLs (never mandatory).
    for (const s of this.discoverySeeds) {
      const o = originOf(s) ?? null;
      if (o) {
        roots.push(o);
        bootstrap.bootstrapSeeds++;
      }
    }

    // Registry-first bootstrap: eligible registered domains become roots. This
    // is what lets discovery run with an empty CRAWL_URLS.
    const eligible = this.eligibleDomains().slice(0, this.maxRoots);
    bootstrap.registryRoots = eligible.length;
    for (const d of eligible) roots.push(`https://${d}/`);

    const uniqueRoots = [...new Set(roots)].slice(0, this.maxRoots);
    if (bootstrap.via === "none" && uniqueRoots.length) {
      bootstrap.via = bootstrap.registryRoots > 0 ? "registry" : "bootstrap-seeds";
    }

    for (const adapter of this.adapters) {
      let res;
      try {
        res = await adapter.discover({ roots: uniqueRoots, log: this.log });
      } catch (err) {
        res = { status: "error", reason: err?.message ?? "adapter-error", candidates: [], diagnostics: {} };
      }
      const report = {
        name: adapter.name,
        kind: adapter.kind,
        status: res.status ?? "error",
        reason: res.reason ?? null,
        found: res.candidates?.length ?? 0,
        enqueued: 0,
        duplicate: 0,
        rejected: 0,
        diagnostics: res.diagnostics ?? {},
      };
      for (const cand of res.candidates ?? []) {
        const url = cand?.url;
        if (!url) {
          report.rejected++;
          continue;
        }
        const decision = this.policy.decide(url);
        if (!decision.allowed) {
          report.rejected++;
          continue;
        }
        const dom = canonicalDomain(url);
        if (dom && this.domainRegistry?.get?.(dom)?.policy === "blocked") {
          report.rejected++;
          continue;
        }
        if (dom && this.domainRegistry?.recordDiscovery) {
          await this.domainRegistry.recordDiscovery(dom, {
            url,
            parentUrl: cand.provenance?.sitemapUrl ?? cand.provenance?.feedUrl ?? null,
            depth: 0,
            trust: "discovered",
          });
        }
        const enqueued = await this.frontier.enqueue(url, {
          depth: 0,
          discoveryProvenance: cand.provenance ?? null,
        });
        if (enqueued) report.enqueued++;
        else report.duplicate++;
      }
      bootstrap.adapters.push(report);
    }

    return { bootstrap, uniqueRoots };
  }

  /**
   * Fetch up to `maxPages` documents from the frontier this cycle, following
   * policy-approved links. Returns the raw-doc shape the learning job curates.
   */
  async collect(ctx = {}) {
    const maxPages = Number.isFinite(ctx.maxPages) ? ctx.maxPages : config.crawlPagesPerCycle;
    const maxCycles = Number.isFinite(ctx.maxCycles) ? ctx.maxCycles : maxPages;

    await this.frontier.init();
    if (this.domainRegistry?.init) await this.domainRegistry.init().catch(() => {});
    // Recover URLs left in-progress by a crashed cycle before claiming new ones.
    await this.frontier.recoverStaleClaims({ claimTimeoutMs: config.crawlCooldownMs }).catch(() => {});

    const frontierBefore = this.frontier.summary();

    // Bootstrap + adapters. Crucially this REPLACED an unconditional
    // `frontier.clear()` on empty seeds: pending frontier entries are legitimate
    // persisted work and are never silently discarded.
    const { bootstrap, uniqueRoots } = await this.#bootstrapAndAdapt(ctx);

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
      languageFilter: ctx.languageFilter ?? config.languageFilter,
    });

    const frontierAfter = this.frontier.summary();
    const providerAvailable = bootstrap.adapters.some((a) => a.status === "ok" || a.status === "idle");
    const hadFrontierWork = frontierBefore.queued + frontierBefore.deferred > 0;
    const hasAnySource =
      this.seeds.length > 0 ||
      uniqueRoots.length > 0 ||
      providerAvailable ||
      hadFrontierWork ||
      frontierAfter.total > 0;
    const status = hasAnySource ? "ok" : "no-source-configured";

    this.log(
      "out",
      `discovery status=${status} via=${bootstrap.via} roots=${uniqueRoots.length} frontierQueued=${frontierAfter.queued} adapters=${bootstrap.adapters
        .map((a) => `${a.name}:${a.status}/${a.enqueued}`)
        .join(",") || "none"}`,
    );

    return {
      mode: "real",
      capability: CAPABILITY.real,
      documents: result.documents,
      failures: result.failures,
      discovered: result.discovered,
      cycles: result.cycles,
      totalPagesFetched: result.totalPagesFetched,
      totalUrlsEnqueued: result.totalUrlsEnqueued,
      languageFiltered: result.languageFiltered ?? 0,
      skipped: result.skipped ?? [],
      shadowRejected: result.shadowRejected ?? [],
      frontier: frontierAfter,
      policy: this.policy.mode,
      discovery: {
        status,
        via: bootstrap.via,
        roots: uniqueRoots.length,
        providerAvailable,
        bootstrap,
      },
    };
  }
}

function originOf(urlString) {
  try {
    return new URL(urlString).origin + "/";
  } catch {
    return null;
  }
}
