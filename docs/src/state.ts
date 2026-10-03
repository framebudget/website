import { budget, type BudgetSnapshot, type ChangeReason } from "framebudget";
import { schedule } from "./loop";

/**
 * One subscription to framebudget for the whole page. A change is read once
 * and every view renders in the same animation frame, so a burst of changes
 * (a slider drag, a governor step during a device change) costs one render.
 */
export type View = (snap: BudgetSnapshot, reasons: readonly ChangeReason[]) => void;

const views: View[] = [];
let current: BudgetSnapshot = budget.snapshot();
let reasons: ChangeReason[] = [];

function flush(): void {
  current = budget.snapshot();
  const batch = reasons;
  reasons = [];
  for (const view of views) view(current, batch);
}

budget.on("change", (_snap, reason) => {
  reasons.push(reason);
  schedule(flush);
});

/** Renders now with the current decision, then after every change. */
export function watch(view: View): void {
  views.push(view);
  view(current, []);
}

export const snapshot = (): BudgetSnapshot => current;

/**
 * The warm benchmark runs after load in five tasks and only emits "change"
 * when the decision moves. Its score and kernel rates still belong on the
 * page, so render once more when they arrive.
 */
function awaitWarm(): void {
  let tries = 0;
  const check = (): void => {
    if (budget.snapshot().warm) schedule(flush);
    else if (++tries < 40) window.setTimeout(check, 250);
  };
  window.setTimeout(check, 250);
}
if (document.readyState === "complete") awaitWarm();
else window.addEventListener("load", awaitWarm, { once: true });

/**
 * Starts or stops something with an effect. `apply` runs only when the
 * effect's state flips, never on unrelated changes.
 */
export function onEffect(name: string, apply: (on: boolean) => void): void {
  let state: boolean | null = null;
  watch((snap) => {
    const on = snap.effects.includes(name);
    if (on === state) return;
    state = on;
    apply(on);
  });
}

export const allows = (name: string): boolean => current.effects.includes(name);
/** Coalesces simulate calls to one per frame, for a dragged slider. Clicks call budget.simulate directly. */
let pendingScore: number | null | undefined;
function applySimulate(): void {
  if (pendingScore === undefined) return;
  const score = pendingScore;
  pendingScore = undefined;
  budget.simulate(score);
}
export function simulateSoon(score: number | null): void {
  pendingScore = score;
  schedule(applySimulate);
}
