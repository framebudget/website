/**
 * The threshold search, shared by the daily auto calibration and
 * scripts/calibrate.mjs (Node runs this file with type stripping), so both
 * propose the same numbers from the same runs.
 */

/**
 * Largest tolerated share of late frames (over 1.5 refresh intervals, the step's
 * `over` / `frames`) with an effect on; reaching exactly this share is not a miss.
 */
export const LATE_MAX = 0.05;
/**
 * Least rise of that share over the run's own baseline steps for the effect to
 * count as missed: cheap phones drop a few frames with nothing on, and that
 * jitter is the device's, not the effect's.
 */
export const LATE_OVER_BASELINE = 0.02;
/** Largest tolerated fraction of devices that missed at or above a threshold (strictly below it). */
export const MAX_UNDER = 0.05;
/** Fewest devices at or above a threshold to trust it. */
export const MIN_DEVICES = 10;

/**
 * Whether a device missed with an effect on: more than LATE_MAX of the effect
 * step's frames were late, and that share is at least LATE_OVER_BASELINE above the
 * share over the run's `baseline` and `baseline-end` steps pooled (`baseOver` late
 * of `baseFrames`). The p95 frame time is not used: on cheap phones the gaps
 * between animation frames jitter, so it sits above a 55 fps target even with no
 * effect on and no frame dropped. `frames` and `baseFrames` must be positive.
 */
export function missedLateFrames(over: number, frames: number, baseOver: number, baseFrames: number): boolean {
  const rate = over / frames;
  return rate > LATE_MAX && rate - baseOver / baseFrames >= LATE_OVER_BASELINE;
}

export interface Sample {
  score: number;
  /** The device missed the target with the effect on. */
  missed: boolean;
}

export interface Found {
  threshold: number;
  /** Devices at or above the threshold. */
  devices: number;
  /** Fraction of them that missed the target. */
  under: number;
}

/**
 * Lowest score T such that, among the samples with score >= T, fewer than
 * `maxUnder` missed the target, with at least `minSamples` of them. Candidates
 * are the sample scores; one sorted pass, so it stays linear past the sort.
 */
export function lowestThreshold(samples: readonly Sample[], maxUnder: number, minSamples: number): Found | null {
  const sorted = [...samples].sort((a, b) => a.score - b.score);
  let missedAbove = sorted.filter((s) => s.missed).length;
  for (let i = 0; i < sorted.length; i++) {
    const sample = sorted[i]!;
    if (i === 0 || sorted[i - 1]!.score !== sample.score) {
      const devices = sorted.length - i;
      if (devices < minSamples) break;
      const under = missedAbove / devices;
      if (under < maxUnder) return { threshold: sample.score, devices, under };
    }
    if (sample.missed) missedAbove--;
  }
  return null;
}
