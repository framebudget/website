/**
 * The guardrails between a proposed threshold and the one applied, in order:
 * step limit, drift limit, tier floors, minimum change, cadence. Shared with
 * scripts/calibrate.mjs. Thresholds are kept on tenths, the lab's score precision.
 */

/** Most an applied value moves away from the current one per change, as a fraction of it. */
export const STEP_LIMIT = 0.2;
/** Applied values stay within [DRIFT_MIN, DRIFT_MAX] times the baseline in shared/site-effects.json. */
export const DRIFT_MIN = 0.5;
export const DRIFT_MAX = 2;
/** Changes smaller than this fraction of the current value are skipped. */
export const MIN_CHANGE = 0.05;
/** At most one applied change per effect within this many seconds (7 days). */
export const CADENCE_SECONDS = 7 * 86400;

/** Why the applied value is not the proposed one; null when the proposal went through as is. */
export type LimitedBy = "devices" | "step" | "drift" | "tier" | "min-change" | "cadence";

export interface GuardInput {
  /** Threshold in shared/site-effects.json. */
  baseline: number;
  /** Threshold in force: the last applied auto value, else the baseline. */
  current: number;
  /** Threshold the lab data supports; null when too few devices. */
  proposed: number | null;
  /** Tier floors from shared/site-effects.json. */
  floors: readonly number[];
  /** Epoch seconds of the effect's last applied change, null for none. */
  lastChangedAt: number | null;
  nowSec: number;
}

export interface GuardResult {
  to: number;
  limitedBy: LimitedBy | null;
}

const ceilTenth = (x: number) => Math.ceil(x * 10 - 1e-9) / 10;
const floorTenth = (x: number) => Math.floor(x * 10 + 1e-9) / 10;

/**
 * Range a threshold may take without moving the effect between tiers: an effect
 * runs on a tier when its threshold is at most the tier floor, so the threshold
 * stays above the highest floor below the baseline and at most the lowest floor
 * at or above it.
 */
export function tierRange(baseline: number, floors: readonly number[]): { min: number; max: number } {
  const below = floors.filter((f) => f < baseline);
  const atOrAbove = floors.filter((f) => f >= baseline);
  return {
    min: below.length ? Math.round(floorTenth(Math.max(...below)) * 10 + 1) / 10 : 0,
    max: atOrAbove.length ? floorTenth(Math.min(...atOrAbove)) : Infinity,
  };
}

/**
 * The threshold to apply. Step, drift and tier clamp the proposal in that order
 * (the last one that moved it is `limitedBy`); minimum change and cadence then
 * keep the current value. Drift and tier are hard limits: a current value
 * outside them (a human moved the baseline) is pulled back even without a
 * proposal, and neither minimum change nor cadence holds that back.
 */
export function guard(input: GuardInput): GuardResult {
  const { baseline, current, proposed } = input;
  let to = Math.round((proposed ?? current) * 10) / 10;
  let limitedBy: LimitedBy | null = proposed === null ? "devices" : null;
  const clamp = (min: number, max: number, reason: LimitedBy) => {
    const next = Math.min(Math.max(to, min), max);
    if (next !== to) {
      to = Math.round(next * 10) / 10;
      limitedBy = reason;
    }
  };
  if (proposed !== null) clamp(ceilTenth(current * (1 - STEP_LIMIT)), floorTenth(current * (1 + STEP_LIMIT)), "step");
  const drift = { min: ceilTenth(baseline * DRIFT_MIN), max: floorTenth(baseline * DRIFT_MAX) };
  const tier = tierRange(baseline, input.floors);
  clamp(drift.min, drift.max, "drift");
  clamp(tier.min, tier.max, "tier");

  const currentAllowed = current >= Math.max(drift.min, tier.min) && current <= Math.min(drift.max, tier.max);
  if (to === current || !currentAllowed) return { to, limitedBy };
  if (Math.abs(to - current) < MIN_CHANGE * current - 1e-9) return { to: current, limitedBy: "min-change" };
  if (input.lastChangedAt !== null && input.nowSec - input.lastChangedAt < CADENCE_SECONDS) return { to: current, limitedBy: "cadence" };
  return { to, limitedBy };
}
