/**
 * The auto patch: a CalibrationPatch holding effect thresholds only, never
 * reference rates, version, tiers, hysteresis, costs or flags. Shared with
 * scripts/calibrate.mjs.
 */

export interface AutoPatch {
  effects: Record<string, { threshold: number }>;
}

/**
 * The auto patch in `value` (JSON text or parsed): only `effects.<name>.threshold`
 * entries with a finite positive number survive; anything else reads as no patch.
 */
export function parseAutoPatch(value: unknown): AutoPatch {
  let data = value;
  if (typeof value === "string") {
    try {
      data = JSON.parse(value);
    } catch {
      data = null;
    }
  }
  const patch: AutoPatch = { effects: {} };
  const effects = (data as { effects?: unknown } | null)?.effects;
  if (!effects || typeof effects !== "object" || Array.isArray(effects)) return patch;
  for (const [name, effect] of Object.entries(effects)) {
    const threshold = (effect as { threshold?: unknown } | null)?.threshold;
    if (typeof threshold === "number" && Number.isFinite(threshold) && threshold > 0) patch.effects[name] = { threshold };
  }
  return patch;
}

/** The patch in force after an evaluation: `current` without effects gone from the registry, with `thresholds` set. */
export function nextPatch(current: AutoPatch, registry: readonly string[], thresholds: Readonly<Record<string, number>>): AutoPatch {
  const effects: AutoPatch["effects"] = {};
  for (const name of registry) {
    const threshold = thresholds[name] ?? current.effects[name]?.threshold;
    if (threshold !== undefined) effects[name] = { threshold };
  }
  return { effects };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `base` deep-merged with `patch`: objects merge key by key, anything else from `patch` wins. */
export function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isObject(base) || !isObject(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) out[key] = key in base ? deepMerge(base[key], value) : value;
  return out;
}
