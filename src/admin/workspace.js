import { existsSync } from "node:fs";
import { ArticleStore } from "../storage/article-store.js";
import { RegistryStore } from "../storage/registry-store.js";
import { GovernanceStore } from "./governance-store.js";
import { readPythonStore } from "./python-store.js";
import { createMissionService } from "./services/mission.js";
import { createStrategyService } from "./services/strategy.js";
import { createReviewCyclesService } from "./services/review-cycles.js";

/**
 * Workspace registry for the Observatory.
 *
 * There is exactly ONE live, writable store per server process: the
 * `development` workspace, whose services are the instances the server booted
 * with (GraphQL, chat and the portal all share them). Additional workspaces are
 * allow-listed in config (`SMA_WORKSPACES`) and are ALWAYS inspection-only:
 * they are opened read-only, with no mkdir and no append streams, so viewing a
 * completed trial can never create or mutate a file.
 *
 * The browser only ever names a workspace by id; it can never supply a
 * filesystem path. Unknown ids are a 404; configured-but-missing stores are a
 * 503, never fabricated data.
 */

export class WorkspaceError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "WorkspaceError";
    this.statusCode = statusCode;
  }
}

/** A live chat is meaningless for a frozen trial; report that honestly. */
const INSPECTION_CHAT = Object.freeze({
  identity: () => ({
    available: false,
    mode: "inspection",
    version: null,
    reason: "inspection-only workspace has no live chat",
  }),
  respond: async () => {
    throw new WorkspaceError("chat is disabled for inspection-only workspaces", 403);
  },
  isUnavailable: () => true,
});

/** Bind the governance-backed services to one workspace's governance log. */
function buildServices(governance) {
  const mission = createMissionService({ governance });
  const strategy = createStrategyService({ governance });
  const reviewCycles = createReviewCyclesService({ governance, mission, strategy });
  return { mission, strategy, reviewCycles };
}

function inspectionReadiness(paths) {
  const reasons = [];
  if (!paths.pythonStore) reasons.push("python store path not configured");
  else if (!existsSync(paths.pythonStore)) reasons.push(`python store not found at ${paths.pythonStore}`);
  if (!paths.articles) reasons.push("articles path not configured");
  if (!paths.registry) reasons.push("registry path not configured");
  return { available: reasons.length === 0, reason: reasons.length ? reasons.join("; ") : null };
}

/** Accept either the normalised `paths` shape (from config) or a flat object. */
function workspacePaths(w) {
  if (w.paths) return w.paths;
  const registry = w.registry ?? w.registryDir ?? null;
  return {
    pythonStore: w.pythonStore ?? w.store ?? null,
    articles: w.articles ?? w.articleDir ?? null,
    registry,
    governance: w.governance ?? w.governanceDir ?? registry,
    snapshots: w.snapshots ?? w.snapshotDir ?? null,
    models: w.models ?? w.modelDir ?? null,
    evaluation: w.evaluation ?? w.evaluationDir ?? null,
    raw: w.raw ?? w.rawDir ?? null,
  };
}

export function createWorkspaceRegistry({
  store,
  registry,
  governance,
  chat,
  pythonStorePath = null,
  workspaces = [],
} = {}) {
  const entries = new Map();

  // The development workspace is the live process store — unchanged behaviour.
  entries.set("development", {
    id: "development",
    label: "Development store",
    kind: "development",
    readOnly: false,
    pythonStorePath,
    paths: null,
    services: { store, registry, governance, chat },
    ...buildServices(governance),
  });

  for (const w of workspaces) {
    if (entries.has(w.id)) throw new WorkspaceError(`duplicate workspace id: ${w.id}`);
    const kind = w.kind === "development" ? "development" : "inspection";
    const paths = workspacePaths(w);
    entries.set(w.id, {
      id: w.id,
      label: w.label ?? w.id,
      kind,
      // Only a development-kind workspace may be writable; everything else is
      // inspection-only, regardless of any `readOnly` hint.
      readOnly: kind === "development" ? Boolean(w.readOnly) : true,
      pythonStorePath: paths.pythonStore ?? null,
      paths,
      services: null,
      _ready: null,
    });
  }

  function describe(w) {
    if (w.kind === "development") {
      const py = readPythonStore(w.pythonStorePath);
      return {
        id: w.id,
        label: w.label,
        kind: w.kind,
        readOnly: false,
        available: true,
        reason: null,
        root: py.root,
        activeVersion: py.activeVersion,
        versions: py.versions.length,
      };
    }
    const readiness = inspectionReadiness(w.paths);
    let root = w.paths.pythonStore ?? null;
    let activeVersion = null;
    let versions = 0;
    if (readiness.available) {
      const py = readPythonStore(w.paths.pythonStore);
      root = py.root;
      activeVersion = py.activeVersion;
      versions = py.versions.length;
    }
    return {
      id: w.id,
      label: w.label,
      kind: w.kind,
      readOnly: w.readOnly,
      available: readiness.available,
      reason: readiness.reason,
      root,
      activeVersion,
      versions,
    };
  }

  async function openInspection(w) {
    if (w.services) return w;
    if (!w._ready) {
      w._ready = (async () => {
        const readiness = inspectionReadiness(w.paths);
        if (!readiness.available) {
          throw new WorkspaceError(`workspace '${w.id}' is unavailable: ${readiness.reason}`, 503);
        }
        const s = await ArticleStore.open(w.paths.articles, { readOnly: true });
        const r = await RegistryStore.open(w.paths.registry, { readOnly: true });
        const g = await GovernanceStore.open(w.paths.governance ?? w.paths.registry, { readOnly: true });
        w.services = { store: s, registry: r, governance: g, chat: INSPECTION_CHAT };
        Object.assign(w, buildServices(g));
      })();
    }
    await w._ready;
    return w;
  }

  return {
    defaultId: "development",
    has: (id) => entries.has(id),
    list: () => [...entries.values()].map(describe),
    async get(id) {
      const w = entries.get(id);
      if (!w) throw new WorkspaceError(`unknown workspace: ${id}`, 404);
      if (w.kind !== "development") await openInspection(w);
      return w;
    },
  };
}
