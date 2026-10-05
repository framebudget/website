import type { BudgetSnapshot, Tier } from "framebudget";
import { LADDER_MAX } from "./effects";
import { watch } from "./state";
import { all, setText } from "./ui";

/** The live threshold of a site effect: the calibration framebudget decides with, not the baseline. */
export const thresholdOf = (snap: BudgetSnapshot, name: string): number => snap.calibration.effects[name]?.threshold ?? 0;

/**
 * The build renders thresholds and tier floors from the site's baseline
 * (render.ts). The calibration fetched from /api/calibration refines that
 * baseline from the next visit, so every marked element is rewritten from
 * `snapshot().calibration`: what the page shows is what framebudget decides
 * with. The calibration only changes with `configure()`, so the work runs once
 * per distinct calibration.
 */
export function mountThresholds(): void {
  const values = all("[data-threshold]");
  const floors = all("[data-floor]");
  const bars = all("[data-ladder-bar]");
  const rows = all("[data-registry]");
  if (!values.length && !floors.length) return;
  let rendered = "";
  watch((snap) => {
    const { effects, tiers, hysteresis } = snap.calibration;
    const key = JSON.stringify([effects, tiers, hysteresis]);
    if (key === rendered) return;
    rendered = key;

    for (const el of values) setText(el, String(thresholdOf(snap, el.dataset.threshold!)));
    for (const el of floors) setText(el, String(tiers[el.dataset.floor as Tier]));

    for (const bar of bars) {
      const t = thresholdOf(snap, bar.closest<HTMLElement>("[data-fx]")!.dataset.fx!) / LADDER_MAX;
      bar.style.setProperty("--t", t.toFixed(4));
      bar.style.setProperty("--lo", (t * (1 - hysteresis)).toFixed(4));
      bar.style.setProperty("--hi", Math.min(1, t * (1 + hysteresis)).toFixed(4));
    }

    for (const row of rows) {
      const threshold = thresholdOf(snap, row.dataset.registry!);
      for (const dot of all("[data-dot]", row)) {
        const tier = dot.dataset.dot as Tier;
        const kept = threshold <= tiers[tier];
        dot.classList.toggle("dot--no", !kept);
        dot.setAttribute("aria-label", kept ? `In ${tier}` : `Not in ${tier}`);
      }
    }
  });
}
