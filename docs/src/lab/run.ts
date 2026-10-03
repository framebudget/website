import { forceEffects } from "../state";
import { LabError, sendStep, type Run, type StepReport } from "./api";
import { measureFrames, summarize, summarizeWork } from "./measure";
import type { Stage } from "./stage";
import { STEPS, type Step } from "./steps";

/** Time for a forced set to take hold (views render, motion starts, rolls settle) before measuring. */
const SETTLE_MS = 900;
/** Measured time per step. */
const MEASURE_MS = 5000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

/** Resolves once the tab is visible. */
export function whenVisible(): Promise<void> {
  if (!document.hidden) return Promise.resolve();
  // An executor, not Promise.withResolvers: the site still runs on browsers from before ES2024.
  return new Promise((resolve) => {
    const onChange = (): void => {
      if (document.hidden) return;
      document.removeEventListener("visibilitychange", onChange);
      resolve();
    };
    document.addEventListener("visibilitychange", onChange);
  });
}

/**
 * One attempt at a step: force its set, build the stage, let it settle, then
 * measure while driving the scroll and the counters. Null when the tab was
 * hidden at any point, since those frames do not describe the device.
 */
async function attempt(step: Step, refreshHz: number, stage: Stage): Promise<StepReport | null> {
  let hidden = false;
  const onChange = (): void => {
    if (document.hidden) hidden = true;
  };
  document.addEventListener("visibilitychange", onChange);
  try {
    forceEffects(step.effects);
    stage.prepare(step.effects);
    await sleep(SETTLE_MS);
    if (hidden) return null;
    const work: number[] = [];
    const gaps = await measureFrames(MEASURE_MS, (elapsed) => stage.drive(elapsed, MEASURE_MS), work);
    if (!gaps || hidden) return null;
    return { name: step.name, effects: [...step.effects], ...summarize(gaps, refreshHz), ...summarizeWork(work) };
  } finally {
    document.removeEventListener("visibilitychange", onChange);
    // Nothing animates and nothing is measured while the step is sent.
    forceEffects([]);
    stage.clear();
  }
}

/**
 * Runs every step in order and sends each one as soon as it ends, before the
 * next one starts; the last one closes the run. A step that sees the tab
 * hidden is discarded and run once more; a second hidden attempt stops the
 * run, which the server then closes when it expires.
 */
export async function runSteps(run: Run, refreshHz: number, stage: Stage, onStep: (index: number, step: Step) => void): Promise<StepReport[]> {
  const reports: StepReport[] = [];
  for (const [index, step] of STEPS.entries()) {
    onStep(index, step);
    await whenVisible();
    let report = await attempt(step, refreshHz, stage);
    if (!report) {
      await whenVisible();
      report = await attempt(step, refreshHz, stage);
    }
    if (!report) throw new LabError("hidden");
    await sendStep(run, report, index === STEPS.length - 1);
    reports.push(report);
  }
  return reports;
}
