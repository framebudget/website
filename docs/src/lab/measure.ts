import { setProbe } from "../loop";
import { round1 } from "./device";

/** Frame statistics of one step, as sent to the server. */
export interface FrameStats {
  frames: number;
  durationMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  /** Frames longer than 1.5 refresh intervals. */
  over: number;
}

/** The server bounds every millisecond value and the frame count at this. */
const LIMIT = 10000;

const clamp = (value: number): number => Math.min(LIMIT, Math.max(0, value));

/** Value at quantile `q` of an ascending list, nearest rank. */
function quantile(sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? 0;
}

export function summarize(gaps: readonly number[], refreshHz: number): FrameStats {
  const sorted = gaps.slice().sort((a, b) => a - b);
  const late = (1000 / refreshHz) * 1.5;
  return {
    frames: clamp(gaps.length),
    durationMs: clamp(Math.round(gaps.reduce((sum, gap) => sum + gap, 0))),
    medianMs: clamp(round1(quantile(sorted, 0.5))),
    p95Ms: clamp(round1(quantile(sorted, 0.95))),
    maxMs: clamp(round1(sorted[sorted.length - 1] ?? 0)),
    over: clamp(gaps.filter((gap) => gap > late).length),
  };
}

/**
 * Records the real gap between frames for `durationMs`, from the page's own
 * requestAnimationFrame loop, calling `drive` once per frame before the
 * frame's work so the lab can scroll and feed the effects. Resolves with the
 * gaps, or null as soon as the tab is hidden (a hidden tab draws no frames).
 */
export function measureFrames(durationMs: number, drive: (elapsedMs: number) => void = () => {}): Promise<number[] | null> {
  // An executor, not Promise.withResolvers: the site still runs on browsers from before ES2024.
  return new Promise((resolve) => {
    if (document.hidden) {
      resolve(null);
      return;
    }
    const gaps: number[] = [];
    let elapsed = 0;
    const finish = (result: number[] | null): void => {
      setProbe(null);
      document.removeEventListener("visibilitychange", onVisibility);
      resolve(result);
    };
    const onVisibility = (): void => {
      if (document.hidden) finish(null);
    };
    document.addEventListener("visibilitychange", onVisibility);
    drive(0);
    setProbe((gap) => {
      gaps.push(gap);
      elapsed += gap;
      if (elapsed >= durationMs) finish(gaps);
      else drive(elapsed);
    });
  });
}

/** The display's refresh rate, from the median gap of a second of idle frames. */
export async function measureRefresh(): Promise<number | null> {
  const gaps = await measureFrames(1000);
  if (!gaps || gaps.length < 10) return null;
  const sorted = gaps.slice().sort((a, b) => a - b);
  return Math.min(1000, Math.max(1, Math.round(1000 / quantile(sorted, 0.5))));
}
