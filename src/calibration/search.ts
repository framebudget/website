/**
 * The threshold search, shared by the daily auto calibration and
 * scripts/calibrate.mjs (Node runs this file with type stripping), so both
 * propose the same numbers from the same runs.
 */

/** Frame rate a device must keep with an effect on, at 60 Hz. */
export const TARGET_FPS = 55;
/** Largest tolerated fraction of devices over the target at or above a threshold (strictly below it). */
export const MAX_UNDER = 0.05;
/** Fewest devices at or above a threshold to trust it. */
export const MIN_DEVICES = 10;

/** p95 frame time a device at `refreshHz` must stay within: 1000 / targetFps ms at 60 Hz, scaled by the refresh rate. */
export function labTargetMs(targetFps: number, refreshHz: number): number {
  return (1000 / targetFps) * (60 / refreshHz);
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
