/**
 * Pure cinematic-control helpers.
 *
 * The renderer owns geometry and timing, but every policy decision that can be
 * tested without WebGL lives here: clamped user settings, reduced-motion
 * semantics, which decorative layers may be animated, and the honest mapping
 * from live telemetry state to an ambient visual mood.
 */

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const numberOr = (value, fallback) => (
  Number.isFinite(Number(value)) ? Number(value) : fallback
);

export const DEFAULT_EFFECT_SETTINGS = Object.freeze({
  cinematic: true,
  ambientDensity: 1,
  signals: true,
  attention: true,
  intensity: 1,
  speed: 1,
  reducedMotion: false,
  activity: true,
});

/**
 * Normalise persisted/user settings. Callers pass the OS media-query result so
 * reduced motion is the default when the platform asks for it; an explicit
 * boolean in `raw` is treated as the user's deliberate choice.
 */
export function normalizeEffectSettings(raw = {}, { prefersReducedMotion = false } = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const reduced = typeof source.reducedMotion === "boolean"
    ? source.reducedMotion === true
    : prefersReducedMotion === true;
  return {
    cinematic: source.cinematic !== false,
    ambientDensity: clamp(numberOr(source.ambientDensity, 1), 0, 1.6),
    signals: source.signals !== false,
    attention: source.attention !== false,
    intensity: clamp(numberOr(source.intensity, 1), 0.3, 1.6),
    speed: clamp(numberOr(source.speed, 1), 0.25, 2.5),
    reducedMotion: reduced,
    activity: source.activity !== false,
  };
}

/** Derive the bounded motion envelope the renderer is allowed to use. */
export function effectiveMotion(settings = DEFAULT_EFFECT_SETTINGS) {
  const reduced = settings.reducedMotion === true;
  const cinematic = settings.cinematic !== false;
  const moving = cinematic && !reduced;
  return {
    moving,
    speed: (Number(settings.speed) || 1) * (reduced ? 0.18 : 1),
    amplitude: (Number(settings.intensity) || 1) * (reduced ? 0.42 : 1),
    rotate: moving,
    signals: moving && settings.signals !== false,
    attention: moving && settings.attention !== false,
    bursts: cinematic,
    rings: cinematic,
    strobe: moving,
    drift: reduced ? 0.15 : 1,
  };
}

/**
 * Per-effect visibility. Layers are independent: turning off one never hides a
 * different layer that the user left enabled. Architecture mode always hides
 * every illustrative/ambient layer.
 */
export function effectVisibility(settings = DEFAULT_EFFECT_SETTINGS, mode = "brain", options = {}) {
  const brain = mode === "brain";
  const motion = effectiveMotion(settings);
  const density = Number(settings.ambientDensity) || 0;
  const decorative = brain && density > 0;
  return {
    decorative,
    ambient: decorative,
    synaptic: decorative,
    signals: decorative && motion.signals,
    attention: decorative && motion.attention,
    atmosphere: brain && motion.moving && density > 0,
    activity: brain && settings.activity !== false,
    layerActivity: brain && options.layerActivity === true,
    deepSpace: decorative,
  };
}

const TELEMETRY_MOODS = Object.freeze({
  live: {
    key: "live",
    label: "Live telemetry",
    energy: 1,
    tint: "#67e8f9",
    ambientGain: 1.12,
    pulseGain: 1.35,
    allowStrobe: true,
  },
  stale: {
    key: "stale",
    label: "Telemetry stale",
    energy: 0.66,
    tint: "#fbbf24",
    ambientGain: 0.9,
    pulseGain: 0.62,
    allowStrobe: false,
  },
  disconnected: {
    key: "disconnected",
    label: "Telemetry disconnected",
    energy: 0.48,
    tint: "#fb7185",
    ambientGain: 0.82,
    pulseGain: 0.5,
    allowStrobe: false,
  },
  failed: {
    key: "failed",
    label: "Training failed",
    energy: 0.34,
    tint: "#fb7185",
    ambientGain: 0.66,
    pulseGain: 0.28,
    allowStrobe: false,
    alert: true,
  },
  completed: {
    key: "completed",
    label: "Run complete",
    energy: 0.72,
    tint: "#34d399",
    ambientGain: 0.95,
    pulseGain: 0.7,
    allowStrobe: false,
  },
  paused: {
    key: "paused",
    label: "Run waiting",
    energy: 0.56,
    tint: "#fbbf24",
    ambientGain: 0.86,
    pulseGain: 0.55,
    allowStrobe: false,
  },
  ambient: {
    key: "ambient",
    label: "Ambient only",
    energy: 0.62,
    tint: "#818cf8",
    ambientGain: 0.9,
    pulseGain: 0.78,
    allowStrobe: false,
  },
});

const PAUSED_STATUSES = new Set([
  "paused",
  "waiting",
  "pause-requested",
  "stop-requested",
  "stopping",
]);

/**
 * Map a display status from telemetry.js to a mood. This only controls the
 * atmosphere; it never pretends stale or ambient motion is a measurement.
 */
export function telemetryMood(status) {
  if (status === "live" || status === "running") return { ...TELEMETRY_MOODS.live };
  if (status === "stale") return { ...TELEMETRY_MOODS.stale };
  if (status === "disconnected" || status === "connecting") {
    return { ...TELEMETRY_MOODS.disconnected };
  }
  if (status === "failed" || status === "interrupted") return { ...TELEMETRY_MOODS.failed };
  if (status === "completed" || status === "stopped") return { ...TELEMETRY_MOODS.completed };
  if (PAUSED_STATUSES.has(status)) return { ...TELEMETRY_MOODS.paused };
  return { ...TELEMETRY_MOODS.ambient };
}

/**
 * Visual signature for a genuine telemetry event. These are acknowledgements,
 * not measurements of a particular layer.
 */
export function activityVisualSpec(kind) {
  switch (kind) {
    case "checkpoint":
      return {
        kind: "checkpoint",
        color: "#fbbf24",
        duration: 2600,
        particles: 96,
        rings: 3,
        ringColor: "#fbbf24",
        energy: 0.45,
      };
    case "evaluation":
      return {
        kind: "evaluation",
        color: "#c084fc",
        duration: 1800,
        particles: 44,
        rings: 1,
        ringColor: "#c084fc",
        energy: 0.2,
      };
    case "failure":
      return {
        kind: "failure",
        color: "#fb7185",
        duration: 3200,
        particles: 64,
        rings: 2,
        ringColor: "#fb7185",
        energy: -0.2,
      };
    case "recovery":
      return {
        kind: "recovery",
        color: "#34d399",
        duration: 2400,
        particles: 58,
        rings: 2,
        ringColor: "#34d399",
        energy: 0.3,
      };
    default:
      return {
        kind: "step",
        color: "#67e8f9",
        duration: 1100,
        particles: 34,
        rings: 0,
        ringColor: "#67e8f9",
        energy: 0.14,
      };
  }
}

/** Human label used by the legend/status. */
export function effectSummary(settings = DEFAULT_EFFECT_SETTINGS) {
  if (settings.reducedMotion) return "Reduced motion";
  if (settings.cinematic === false) return "Cinematic off";
  return "Cinematic";
}
