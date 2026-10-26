import { Frontier } from "../frontier.js";
import { config } from "../config.js";
import { CAPABILITY, runCrawlBatches, seedFrontierFromConfig } from "../harness/crawler.js";
import { createDiscoveryPolicy, hostOf } from "./discovery-policy.js";
import { createDomainRegistry, canonicalDomain } from "../storage/domain-registry.js";
import { buildAdapters, createAdapterFetchText } from "./adapters/index.js";
import { resolveSearchQueries } from "./mission-queries.js";
import { classifyDiscoveryLanguage, DISCOVERY_LANGUAGE_PRIORS } from "./language-prior.js";

/**
 * Round-robin window over a root pool. When there are more roots than the
 * per-cycle adapter cap (`maxRoots`), successive cycles rotate the window so
 * every root eventually gets its sitemap/feed probed instead of only the first
 * `maxRoots` forever. Pure so it is directly testable.
 *
 * @returns {{roots: string[], nextCursor: number}}
 */
export function rotateRoots(roots, cursor = 0, maxRoots = 0) {
  const list = [...new Set((roots ?? []).filter(Boolean))];
  if (!Number.isFinite(maxRoots) || maxRoots <= 0 || list.length <= maxRoots) {
    return { roots: list, nextCursor: 0 };
  }
  const start = ((cursor % list.length) + list.length) % list.length;
  const window = [];
  for (let i = 0; i < maxRoots; i++) window.push(list[(start + i) % list.length]);
  return { roots: window, nextCursor: (start + maxRoots) % list.length };
}

/**
 * DiscoveryService — the acquisition front end for the learning job.
 *
 * Each cycle it resolves where URLs should come from, feeds candidate URLs into
 * the persistent URL frontier, then fetches the next eligible frontier URLs and
 * extracts policy-approved links. CRAWL_URLS are BOOTSTRAP seeds, not a
 * permanent boundary, and an EMPTY CRAWL_URLS is not a dead end:
 *
 *   1. configured seeds (CRAWL_URLS) AND optional CRAWL_DISCOVERY_SEEDS are
 *      enqueued when present — both are fetched as documents, not merely used as
 *      adapter roots;
 *   2. discovery also bootstraps from ELIGIBLE REGISTERED DOMAINS and the
 *      configured adapters (sitemap / feed / an optional search provider);
 *   3. a BRAND-NEW install (no seeds, no registered domains) falls back to a
 *      small BUILT-IN seed set so the first crawl can discover — never a dead
 *      end on a virgin host;
 *   4. if none of those yield roots or a provider, it reports a clear
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
    defaultSeeds = config.crawlDiscoveryDefaultSeeds,
    adapters = null,
    log = () => {},
    domainRegistry = null,
    fetchText = null,
    maxRoots = config.crawlDiscoveryMaxRoots,
    missionTexts = [],
    missionQueriesEnabled = config.missionQueriesEnabled,
    missionQueryMax = config.missionQueryMax,
    corpusTexts = [],
    corpusQueriesEnabled = config.corpusQueriesEnabled,
    corpusQueryMax = config.corpusQueryMax,
    corpusQueryMinFreq = config.corpusQueryMinFreq,
    languagePrior = config.discoveryLanguagePrior,
    admissionGateway = null,
    fetchImpl = undefined,
  } = {}) {
    this.frontier = frontier ?? new Frontier({ dir: config.paths.frontier });
    this.seeds = (seeds ?? []).filter(Boolean);
    this.discoverySeeds = (discoverySeeds ?? []).filter(Boolean);
    this.defaultSeeds = (defaultSeeds ?? []).filter(Boolean);
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
    // Round-robin cursor so the adapter window advances across cycles when the
    // root pool is larger than maxRoots (root rotation).
    this.rootCursor = 0;
    // Adapters and their network access are injectable so tests can drive the
    // whole pipeline deterministically without touching the network.
    this.fetchText = fetchText ?? createAdapterFetchText();
    this.fetchImpl = fetchImpl;
    this.admissionGateway = admissionGateway;
    // Adapter discovery (sitemap/feed/search) performs network I/O outside the
    // target-acquisition boundary. When the gateway is enabled those paths are
    // disabled until they have an explicit admission integration; caller-supplied
    // adapters are rejected rather than silently bypassing the gateway.
    if (admissionGateway && Array.isArray(adapters) && adapters.length > 0) {
      const err = new Error(
        "discovery adapters are disabled while the admission gateway is enabled; no adapter admission integration exists",
      );
      err.code = "ADMISSION_PATH_DISABLED";
      throw err;
    }
    // Mission-driven acquisition (P4): when enabled, deterministic queries derived
    // from the mission(s) are appended to the configured search queries. They are
    // only candidates — the search adapter proposes them and this service still
    // subjects them to the discovery policy and the domain registry. When the flag
    // is off (default) `searchQueries` is exactly CRAWL_SEARCH_QUERIES.
    this.missionTexts = missionTexts;
    this.missionQueriesEnabled = Boolean(missionQueriesEnabled);
    // Corpus keyphrase queries (P4 keyphrase generator): mine the REVIEWED corpus
    // for recurring phrases. Advisory, appended after mission queries.
    this.corpusTexts = (corpusTexts ?? []).filter((t) => typeof t === "string" && t.trim());
    this.corpusQueriesEnabled = Boolean(corpusQueriesEnabled);
    // Discovery language prior (P4): advisory classification of foreign-language
    // hosts, independent of the ingest filter. Default `warn` (count only).
    this.languagePrior = DISCOVERY_LANGUAGE_PRIORS.includes(languagePrior) ? languagePrior : "warn";
    this.searchQueries = resolveSearchQueries({
      configured: config.crawlSearchQueries,
      missionTexts: this.missionTexts,
      enabled: this.missionQueriesEnabled,
      max: missionQueryMax,
      corpusTexts: this.corpusTexts,
      corpusQueriesEnabled: this.corpusQueriesEnabled,
      corpusQueryMax,
      corpusQueryMinFreq,
    });
    this.adapters = admissionGateway
      ? []
      : adapters ?? buildAdapters({ fetchText: this.fetchText, opts: { searchQueries: this.searchQueries, knownUrls: (url) => this.frontier.has(url) } });
  }

  /** Reporting descriptor — must match what `collect` actually does. */
  descriptor() {
    return {
      mode: this.mode,
      urls: this.seeds,
      source: "discovery",
      policy: this.policy.mode,
      adapters: this.adapters.map((a) => a.name),
      searchQueries: this.searchQueries.length,
      missionQueriesEnabled: this.missionQueriesEnabled,
      corpusQueriesEnabled: this.corpusQueriesEnabled,
      languagePrior: this.languagePrior,
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
  async #bootstrapAndAdapt() {
    const bootstrap = {
      via: "none",
      seeds: 0,
      bootstrapSeeds: 0,
      registryRoots: 0,
      defaultSeeds: 0,
      adapters: [],
      languagePrior: { mode: this.languagePrior, warned: 0, rejected: 0 },
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

    // Optional bootstrap seed URLs (CRAWL_DISCOVERY_SEEDS). These are a REAL
    // source, not adapter metadata: enqueue them into the frontier at depth 0 so
    // the cycle FETCHES them as documents, exactly like CRAWL_URLS. Using their
    // origins only as sitemap/feed roots is not enough — a site without a
    // parseable sitemap/feed (e.g. Wikipedia) then yields nothing, and a host
    // configured only with discovery seeds would report `sources-exhausted` on an
    // empty frontier forever, no matter the target.
    if (this.discoverySeeds.length) {
      await seedFrontierFromConfig(this.frontier, this.discoverySeeds);
      for (const s of this.discoverySeeds) {
        const o = originOf(s) ?? null;
        if (o) {
          roots.push(o);
          bootstrap.bootstrapSeeds++;
        }
      }
    }

    // Registry-first bootstrap: eligible registered domains become roots. This
    // is what lets discovery run with an empty CRAWL_URLS. Keep the full eligible
    // pool here; the per-cycle adapter window is chosen by rotation below.
    const eligible = this.eligibleDomains();
    bootstrap.registryRoots = eligible.length;
    for (const d of eligible) roots.push(`https://${d}/`);

    let uniqueRoots = [...new Set(roots)];
    if (bootstrap.via === "none" && uniqueRoots.length) {
      bootstrap.via = bootstrap.registryRoots > 0 ? "registry" : "bootstrap-seeds";
    }

    // Built-in bootstrap fallback. A brand-new install has no CRAWL_URLS, no
    // CRAWL_DISCOVERY_SEEDS and an empty domain registry, so nothing yields a root
    // and the sitemap/feed adapters would have nothing to probe. Rather than report
    // `no-source-configured` on a virgin host, fall back to a small default seed
    // set so the FIRST cycle can discover and register domains. Operators disable
    // it with CRAWL_DISCOVERY_DEFAULT_SEEDS= (empty) to return to strict
    // operator-provided sourcing.
    if (!uniqueRoots.length && this.defaultSeeds.length) {
      // Enqueue the default seeds so the FIRST cycle actually FETCHES them as
      // documents (link extraction then expands the frontier). Relying on the
      // sitemap/feed adapters alone is not enough: not every site advertises a
      // parseable sitemap (Wikipedia's robots.txt points at a REST endpoint the
      // sitemap adapter cannot read). This mirrors exactly how CRAWL_URLS seeds
      // behave — enqueued at depth 0, idempotent, and their origins become roots.
      await seedFrontierFromConfig(this.frontier, this.defaultSeeds);
      for (const s of this.defaultSeeds) {
        const o = originOf(s) ?? null;
        if (o) {
          uniqueRoots.push(o);
          bootstrap.defaultSeeds++;
        }
      }
      uniqueRoots = [...new Set(uniqueRoots)];
      if (uniqueRoots.length) bootstrap.via = "default-seeds";
    }

    // Rotate the adapter window across cycles (root rotation). The policy trusts
    // the ENTIRE pool; only the adapters see the rotating window.
    const rotation = rotateRoots(uniqueRoots, this.rootCursor, this.maxRoots);
    this.rootCursor = rotation.nextCursor;
    const adapterRoots = rotation.roots;
    bootstrap.rootRotation = {
      pool: uniqueRoots.length,
      window: adapterRoots.length,
      nextCursor: rotation.nextCursor,
    };

    // The roots we just chose (CRAWL_URLS + CRAWL_DISCOVERY_SEEDS + registered
    // domains + the default-seed fallback) are the bootstrap SOURCES for this
    // cycle, so the policy must trust their hosts — not just use them to drive the
    // adapters. Without this the default `seeds-only` policy rejects every
    // candidate from a registry root as `not-seed-host`, and discovery could never
    // run with an empty CRAWL_URLS.
    this.policy.addSeedHosts?.(uniqueRoots.map(hostOf).filter(Boolean));

    for (const adapter of this.adapters) {
      let res;
      try {
        res = await adapter.discover({ roots: adapterRoots, log: this.log });
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
        // Discovery language prior: a URL whose HOST declares a non-English
        // language is classified before it is fetched. `warn` counts it and keeps
        // the candidate; `reject` refuses it. The ingest filter still inspects the
        // actual text later and remains the authoritative gate.
        const langPrior = classifyDiscoveryLanguage(url, this.languagePrior);
        if (langPrior.action === "reject") {
          report.rejected++;
          bootstrap.languagePrior.rejected++;
          continue;
        }
        if (langPrior.action === "warn") {
          bootstrap.languagePrior.warned++;
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
    const { bootstrap, uniqueRoots } = await this.#bootstrapAndAdapt();

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
      // Apply the discovery language prior to EXTRACTED LINKS too, not only to
      // adapter candidates, so foreign hosts never enter the frontier.
      discoveryLanguagePrior: this.languagePrior,
      admissionGateway: this.admissionGateway,
      fetchImpl: this.fetchImpl,
    });

    const frontierAfter = this.frontier.summary();
    const providerAvailable = bootstrap.adapters.some(
      (a) => a.status === "ok" || a.status === "idle" || a.status === "degraded",
    );
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
      admissionRejected: result.admissionRejected ?? 0,
      admissionCapDeferred: result.admissionCapDeferred ?? 0,
      capExhausted: result.capExhausted === true,
      capEpoch: result.capEpoch ?? null,
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
