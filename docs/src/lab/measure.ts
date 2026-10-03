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

/**
 * Main-thread work per frame of one step (protocol 2): the page's JavaScript
 * plus style, layout and paint, not the compositor or the GPU. All null when
 * the step took no sample.
 */
export interface WorkStats {
  workMeanMs: number | null;
  workMedianMs: number | null;
  workP95Ms: number | null;
  /** Frames with a work sample. */
  workFrames: number | null;
}

/** The server bounds every millisecond value and the frame count at this. */
const LIMIT = 10000;

const clamp = (value: number): number => Math.min(LIMIT, Math.max(0, value));

const round2 = (value: number): number => Math.round(value * 100) / 100;

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
 * The mean as well as the median: Safari's clock resolves to 1 ms, so single
 * samples are quantized, while the mean over hundreds of frames stays usable.
 */
export function summarizeWork(work: readonly number[]): WorkStats {
  if (!work.length) return { workMeanMs: null, workMedianMs: null, workP95Ms: null, workFrames: null };
  const sorted = work.slice().sort((a, b) => a - b);
  return {
    workMeanMs: clamp(round2(work.reduce((sum, ms) => sum + ms, 0) / work.length)),
    workMedianMs: clamp(round2(quantile(sorted, 0.5))),
    workP95Ms: clamp(round2(quantile(sorted, 0.95))),
    workFrames: clamp(work.length),
  };
}

/**
 * Records the real gap between frames for `durationMs`, from the page's own
 * requestAnimationFrame loop, calling `drive` once per frame before the
 * frame's work so the lab can scroll and feed the effects. Resolves with the
 * gaps, or null as soon as the tab is hidden (a hidden tab draws no frames).
 * With a `work` array, it also collects each measured frame's main-thread
 * work into it (loop.ts `setProbe`), at most one sample per frame and none
 * once the measurement ended.
 */
export function measureFrames(
  durationMs: number,
  drive: (elapsedMs: number) => void = () => {},
  work: number[] | null = null,
): Promise<number[] | null> {
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
    setProbe(
      (gap) => {
        gaps.push(gap);
        elapsed += gap;
        if (elapsed >= durationMs) finish(gaps);
        else drive(elapsed);
      },
      work && ((ms) => work.push(ms)),
    );
  });
}

/** The display's refresh rate, from the median gap of a second of idle frames. */
export async function measureRefresh(): Promise<number | null> {
  const gaps = await measureFrames(1000);
  if (!gaps || gaps.length < 10) return null;
  const sorted = gaps.slice().sort((a, b) => a - b);
  return Math.min(1000, Math.max(1, Math.round(1000 / quantile(sorted, 0.5))));
}
