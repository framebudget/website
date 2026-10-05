/**
 * One auto calibration evaluation, pure: lab rows, the site registry and the
 * log state in, the log row's content out. The daily cron and
 * scripts/calibrate.mjs both call it, so the script prints what the cron applies.
 */
import { guard } from "./guardrails.ts";
import type { Change, LogState } from "./log.ts";
import { nextPatch, type AutoPatch } from "./patch.ts";
import { selectRuns, type Exclusions, type LabRow } from "./runs.ts";
import { labTargetMs, lowestThreshold, MAX_UNDER, MIN_DEVICES, TARGET_FPS } from "./search.ts";

/** shared/site-effects.json */
export interface SiteRegistry {
  tiers: Record<string, number>;
  effects: Record<string, { threshold: number; cost: number; ms: number; motion: boolean; data: boolean }>;
}

export interface Evaluation {
  cal: string | null;
  /** Runs counted. */
  runs: number;
  excluded: number;
  exclusions: Exclusions;
  /** The full auto patch in force after this evaluation. */
  patch: AutoPatch;
  /** Every effect of the registry that a counted run measured, in registry order. */
  changes: Change[];
  /** At least one threshold changed. */
  applied: boolean;
}

export function evaluate(rows: readonly LabRow[], registry: SiteRegistry, state: LogState, nowMs: number): Evaluation {
  const selection = selectRuns(rows, nowMs);
  const nowSec = Math.floor(nowMs / 1000);
  const floors = Object.values(registry.tiers);
  const changes: Change[] = [];
  const thresholds: Record<string, number> = {};
  for (const [effect, { threshold: baseline }] of Object.entries(registry.effects)) {
    const samples = selection.runs
      .filter((r) => r.p95.has(effect))
      .map((r) => ({ score: r.score, missed: r.p95.get(effect)! > labTargetMs(TARGET_FPS, r.refreshHz) }));
    if (!samples.length) continue;
    const proposed = lowestThreshold(samples, MAX_UNDER, MIN_DEVICES)?.threshold ?? null;
    const from = state.patch.effects[effect]?.threshold ?? baseline;
    const { to, limitedBy } = guard({ baseline, current: from, proposed, floors, lastChangedAt: state.lastChanged[effect] ?? null, nowSec });
    if (to !== from) thresholds[effect] = to;
    changes.push({ effect, from, to, proposed, devices: samples.length, limitedBy });
  }
  return {
    cal: selection.cal,
    runs: selection.runs.length,
    excluded: selection.excluded,
    exclusions: selection.exclusions,
    patch: nextPatch(state.patch, Object.keys(registry.effects), thresholds),
    changes,
    applied: Object.keys(thresholds).length > 0,
  };
}
