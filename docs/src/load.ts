import { budget } from "framebudget";
import { frameMs, HEAT } from "./effects";
import { setMainReports, setTask } from "./loop";
import { snapshot } from "./state";

/**
 * The load test burns, on the main thread and inside the frame, the time
 * this page's effects would take on the simulated device. Frames really come
 * late, the governor sees them through budget.reportFrame, and steps effects
 * down; as effects go, the burn shrinks and the frames recover.
 *
 * The burn must never take the page hostage. The previous version spun up to
 * 40 ms in one go on every frame, so every click waited behind a whole burned
 * frame. Now the burn is capped at 24 ms and checks for pending input every
 * millisecond: when the visitor clicks or types, the burn stops at once and
 * the event runs. A click is never more than about a millisecond behind.
 */
export const load = { on: false, hot: false };

const MAX_BURN_MS = 24;
const listeners: Array<() => void> = [];

interface Scheduling {
  isInputPending?: (options?: { includeContinuous?: boolean }) => boolean;
}
const scheduling = (navigator as Navigator & { scheduling?: Scheduling }).scheduling;
const inputPending = (): boolean => scheduling?.isInputPending?.() ?? false;

/** Heat factor applied to every modeled frame while the test runs. */
export const heat = (): number => (load.on && load.hot ? HEAT : 1);

let lastFrame = 0;
let visible = false;

function burn(): void {
  const start = performance.now();
  // Report the real gap between callbacks: under load, rAF timestamps stay on
  // the vsync grid even when a callback runs late.
  if (lastFrame) budget.reportFrame(start - lastFrame, "loadTest");
  lastFrame = start;
  const snap = snapshot();
  const end = start + Math.min(MAX_BURN_MS, frameMs(snap.score ?? 100, snap.effects, heat()));
  let next = start + 1;
  while (performance.now() < end) {
    if (performance.now() >= next) {
      if (inputPending()) return;
      next += 1;
    }
  }
}

function apply(): void {
  lastFrame = 0;
  const running = load.on && visible;
  setMainReports(!running);
  setTask("loadTest", running ? burn : null);
}

/** The test pauses while the simulator is off screen, like every other moving part of the page. */
export function setLoadVisible(on: boolean): void {
  visible = on;
  apply();
}

export function setLoad(on: boolean, hot: boolean): void {
  load.on = on;
  load.hot = on && hot;
  apply();
  for (const fn of listeners) fn();
}

export function onLoad(fn: () => void): void {
  listeners.push(fn);
}
