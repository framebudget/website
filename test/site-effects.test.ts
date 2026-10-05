import { describe, expect, it } from "vitest";
import { SITE_EFFECTS, TIER_FLOORS } from "../docs/src/effects";
import registry from "../shared/site-effects.json";

// shared/site-effects.json is the one source of the site's effect numbers; until
// docs/src/effects.ts reads it, the two must never disagree.
describe("shared/site-effects.json", () => {
  it("has every effect of docs/src/effects.ts, in the same order", () => {
    expect(Object.keys(registry.effects)).toEqual(SITE_EFFECTS.map((e) => e.name));
  });

  it("matches every threshold, cost, ms, motion and data value", () => {
    const fromSite = Object.fromEntries(
      SITE_EFFECTS.map((e) => [e.name, { threshold: e.threshold, cost: e.cost, ms: e.ms, motion: !!e.motion, data: !!e.data }]),
    );
    expect(registry.effects).toEqual(fromSite);
  });

  it("matches the tier floors", () => {
    expect(registry.tiers).toEqual(TIER_FLOORS);
  });
});
