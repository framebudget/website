import { budget } from "framebudget";

/**
 * The lab's override (lab.html): an exact set of effects that replaces
 * framebudget's decision on this page until it is lifted, so every device runs
 * every effect it measures. The site asks `allows()` here instead of
 * `budget.allows()`, and state.ts hands the forced set to every view, so a
 * forced set reaches scripts, CSS (the attribute on <html>) and the motion
 * gate alike. While a set is forced no frame reaches the governor, so a lab
 * run neither steps effects down nor teaches framebudget to skip them later.
 */
const ATTRIBUTE = "data-framebudget-effects";

let forced: readonly string[] | null = null;
let guard: MutationObserver | null = null;

/** The forced set, or null while framebudget decides. */
export const forcedEffects = (): readonly string[] | null => forced;

/** May this effect run now? The forced set while there is one, else framebudget's answer. */
export const allows = (name: string): boolean => (forced ? forced.includes(name) : budget.allows(name));

/** Reports a frame gap to the governor, except while a set is forced. */
export function reportFrame(gapMs: number, source: string): void {
  if (!forced) budget.reportFrame(gapMs, source);
}

/**
 * Forces exactly `effects`, or returns to framebudget's decision with null.
 * Only writes the attribute on <html>: state.ts re-renders the views.
 */
export function setForced(effects: readonly string[] | null): void {
  forced = effects ? [...effects] : null;
  guard?.disconnect();
  guard = null;
  const root = document.documentElement;
  const value = (forced ?? budget.snapshot().effects).join(" ");
  root.setAttribute(ATTRIBUTE, value);
  if (!forced) return;
  // framebudget rewrites the attribute whenever it recomputes (pressure, a
  // late benchmark), even when its decision did not change. Put the forced
  // set back before the next style recalculation.
  guard = new MutationObserver(() => {
    if (root.getAttribute(ATTRIBUTE) !== value) root.setAttribute(ATTRIBUTE, value);
  });
  guard.observe(root, { attributes: true, attributeFilter: [ATTRIBUTE] });
}
