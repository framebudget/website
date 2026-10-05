import { describe, expect, it } from "vitest";
import registry from "../shared/site-effects.json";
import { evaluate } from "../src/calibration/evaluate.ts";
import { CADENCE_SECONDS, guard, tierRange, type GuardInput } from "../src/calibration/guardrails.ts";
import { stateFromLog } from "../src/calibration/log.ts";
import { deepMerge, parseAutoPatch } from "../src/calibration/patch.ts";
import { selectRuns } from "../src/calibration/runs.ts";
import { labTargetMs, lowestThreshold } from "../src/calibration/search.ts";
import { fixtureRows, labRow, type RunSpec } from "./lab-rows";

const NOW = Date.UTC(2026, 9, 4, 3, 17);
const NOW_SEC = NOW / 1000;
const DAY = 86400;
const FLOORS = Object.values(registry.tiers);
const EMPTY = { patch: { effects: {} }, lastChanged: {} };
const rows = (specs: RunSpec[]) => specs.map(labRow);

describe("run selection", () => {
  it("counts clean runs and excludes each kind of bad run", () => {
    const selection = selectRuns(
      rows([
        { score: 50 },
        { score: 51, baseline: null },
        { score: 52, end: null },
        // 1.5 refresh intervals: 25 ms at 60 Hz, 12.5 ms at 120 Hz.
        { score: 53, baseline: 25.1 },
        { score: 54, hz: 120, baseline: 12.6 },
        { score: 55, hz: 120, baseline: 12.4, end: 12.4 },
        // baseline-end more than 25% above the baseline.
        { score: 56, baseline: 16, end: 20.1 },
        { score: 57, baseline: 16, end: 20 },
        { score: 58, hz: 29 },
        { score: 59, hz: 361 },
        { score: 60, hz: 30 },
        { score: 61, hz: 360, baseline: 4, end: 4 },
      ]),
      NOW,
    );
    expect(selection.runs.map((r) => r.score)).toEqual([50, 55, 57, 60, 61]);
    expect(selection.exclusions).toEqual({ refresh: 2, baseline: 2, busy: 2, thermal: 1 });
    expect(selection.excluded).toBe(7);
  });

  it("ignores protocol 1, other calibration versions, unfinished and old runs without counting them as excluded", () => {
    const selection = selectRuns(
      rows([
        { score: 50 },
        { score: 51 },
        { score: 52, protocol: 1 },
        { score: 53, protocol: 3 },
        { score: 54, cal: "provisional-0" },
        { score: 55, completed: 0 },
        { score: 56, day: "2025-08-30" },
        { score: 57, day: "2025-08-29", baseline: null },
      ]),
      NOW,
    );
    expect(selection).toMatchObject({ cal: "provisional-1", excluded: 0 });
    expect(selection.runs.map((r) => r.score)).toEqual([50, 51, 53, 56]);
  });

  it("uses the most common calibration version among the protocol 2 runs", () => {
    const selection = selectRuns(
      rows([{ score: 1, cal: "a" }, { score: 2, cal: "b" }, { score: 3, cal: "b" }, { score: 4, cal: "a", protocol: 1 }, { score: 5, cal: "a", protocol: 1 }]),
      NOW,
    );
    expect(selection.cal).toBe("b");
    expect(selection.runs.map((r) => r.score)).toEqual([2, 3]);
    expect(selectRuns([], NOW)).toMatchObject({ cal: null, runs: [], excluded: 0 });
  });
});

describe("threshold search", () => {
  const samples = (n: number, missedBelow = 0) => Array.from({ length: n }, (_, i) => ({ score: (i + 1) * 10, missed: (i + 1) * 10 < missedBelow }));

  it("proposes nothing with fewer than 10 devices at or above any threshold", () => {
    expect(lowestThreshold(samples(9), 0.05, 10)).toBeNull();
    expect(lowestThreshold(samples(10), 0.05, 10)).toEqual({ threshold: 10, devices: 10, under: 0 });
  });

  it("needs strictly fewer than 5% of the devices at or above over the target", () => {
    // One miss in 20 is 5%: not accepted. One in 21 is 4.8%: accepted.
    const twenty = samples(20).map((s, i) => ({ ...s, missed: i === 0 }));
    expect(lowestThreshold(twenty, 0.05, 10)).toEqual({ threshold: 20, devices: 19, under: 0 });
    const twentyOne = samples(21).map((s, i) => ({ ...s, missed: i === 0 }));
    expect(lowestThreshold(twentyOne, 0.05, 10)).toEqual({ threshold: 10, devices: 21, under: 1 / 21 });
    // Nine slow devices under 100: at 90, one miss in 22 is 4.5%.
    expect(lowestThreshold(samples(30, 100), 0.05, 10)).toEqual({ threshold: 90, devices: 22, under: 1 / 22 });
    // A slow device at the top keeps every candidate above the limit once fewer than 20 remain.
    expect(lowestThreshold([...samples(15), { score: 1000, missed: true }], 0.05, 10)).toBeNull();
  });

  it("scales the target by the refresh rate", () => {
    expect(labTargetMs(55, 60)).toBeCloseTo(1000 / 55, 9);
    expect(labTargetMs(55, 120)).toBeCloseTo(500 / 55, 9);
    // p95 12 ms with the effect on: within the target at 60 Hz, over it at 120 Hz.
    const lab = (hz: number) => rows(Array.from({ length: 12 }, (_, i) => ({ score: 40 + i * 5, hz, baseline: 8, end: 8, effects: { blur: i < 2 ? 12 : 8 } })));
    const proposed = (hz: number) => evaluate(lab(hz), registry, EMPTY, NOW).changes[0]!.proposed;
    expect(proposed(60)).toBe(40);
    // At 120 Hz the two slowest miss: 2 of 12 and 1 of 11 are over 5%, 0 of 10 is not.
    expect(proposed(120)).toBe(50);
    const mixed = rows(Array.from({ length: 14 }, (_, i) => ({ score: 40 + i * 5, hz: i < 2 ? 120 : 60, baseline: 8, end: 8, effects: { blur: 12 } })));
    expect(evaluate(mixed, registry, EMPTY, NOW).changes[0]).toMatchObject({ proposed: 50, devices: 14 });
  });
});

describe("guardrails", () => {
  const input = (over: Partial<GuardInput>): GuardInput => ({ baseline: 100, current: 100, proposed: null, floors: [], lastChangedAt: null, nowSec: NOW_SEC, ...over });

  it("keeps the current value without a proposal", () => {
    expect(guard(input({ current: 110 }))).toEqual({ to: 110, limitedBy: "devices" });
  });

  it("applies a proposal within every limit as is", () => {
    expect(guard(input({ proposed: 112.3 }))).toEqual({ to: 112.3, limitedBy: null });
  });

  it("step: moves at most 20% away from the current value", () => {
    expect(guard(input({ proposed: 150 }))).toEqual({ to: 120, limitedBy: "step" });
    expect(guard(input({ proposed: 50 }))).toEqual({ to: 80, limitedBy: "step" });
    // From the last applied auto value, not from the baseline.
    expect(guard(input({ current: 120, proposed: 150 }))).toEqual({ to: 144, limitedBy: "step" });
  });

  it("drift: stays within 0.5x and 2x of the baseline", () => {
    expect(guard(input({ current: 190, proposed: 260 }))).toEqual({ to: 200, limitedBy: "drift" });
    expect(guard(input({ current: 55, proposed: 30 }))).toEqual({ to: 50, limitedBy: "drift" });
  });

  it("tier floors: an effect never moves between tiers", () => {
    expect(tierRange(80, [20, 90, 180])).toEqual({ min: 20.1, max: 90 });
    expect(tierRange(90, [20, 90, 180])).toEqual({ min: 20.1, max: 90 });
    expect(tierRange(10, [20, 90])).toEqual({ min: 0, max: 20 });
    expect(tierRange(200, [20, 180])).toEqual({ min: 180.1, max: Infinity });
    expect(guard(input({ baseline: 80, current: 80, proposed: 95, floors: [90] }))).toEqual({ to: 90, limitedBy: "tier" });
    expect(guard(input({ proposed: 70, floors: [90] }))).toEqual({ to: 90.1, limitedBy: "tier" });
  });

  it("tier floors hold for every effect of the site, whatever the proposal", () => {
    for (const [name, { threshold: baseline }] of Object.entries(registry.effects)) {
      const { min, max } = tierRange(baseline, FLOORS);
      for (let current = baseline * 0.5; current <= baseline * 2; current += baseline / 7) {
        for (const proposed of [1, baseline / 3, baseline * 0.9, baseline * 1.1, baseline * 3, 10000]) {
          const { to } = guard({ baseline, current: Math.round(current * 10) / 10, proposed, floors: FLOORS, lastChangedAt: null, nowSec: NOW_SEC });
          expect(to, name).toBeGreaterThanOrEqual(min);
          expect(to, name).toBeLessThanOrEqual(max);
        }
      }
    }
  });

  it("minimum change: skips a move under 5% of the current value", () => {
    expect(guard(input({ proposed: 104.9 }))).toEqual({ to: 100, limitedBy: "min-change" });
    expect(guard(input({ proposed: 95.1 }))).toEqual({ to: 100, limitedBy: "min-change" });
    expect(guard(input({ proposed: 105 }))).toEqual({ to: 105, limitedBy: null });
    // A clamp that leaves less than 5% is skipped too.
    expect(guard(input({ baseline: 88, current: 88, proposed: 100, floors: [90] }))).toEqual({ to: 88, limitedBy: "min-change" });
  });

  it("cadence: at most one applied change per effect every 7 days", () => {
    expect(guard(input({ proposed: 110, lastChangedAt: NOW_SEC - CADENCE_SECONDS + 1 }))).toEqual({ to: 100, limitedBy: "cadence" });
    expect(guard(input({ proposed: 110, lastChangedAt: NOW_SEC - CADENCE_SECONDS }))).toEqual({ to: 110, limitedBy: null });
  });

  it("combined: each limit in order, the last one that moved the value named", () => {
    // 260 -> step 216 -> drift 200 -> tier 180, the current value: nothing to apply.
    expect(guard(input({ current: 180, proposed: 260, floors: [180] }))).toEqual({ to: 180, limitedBy: "tier" });
    expect(guard(input({ baseline: 100, current: 150, proposed: 260, floors: [20, 175] }))).toEqual({ to: 175, limitedBy: "tier" });
    expect(guard(input({ baseline: 100, current: 150, proposed: 260, floors: [20, 175], lastChangedAt: NOW_SEC - DAY }))).toEqual({
      to: 150,
      limitedBy: "cadence",
    });
  });

  it("pulls a value outside the hard limits back, past minimum change and cadence", () => {
    // A human moved the baseline from 100 to 200: the auto value 90 is under 0.5x.
    expect(guard(input({ baseline: 200, current: 90, lastChangedAt: NOW_SEC - DAY }))).toEqual({ to: 100, limitedBy: "drift" });
    // A floor at 95 now sits between the baseline 100 and the auto value 92.
    expect(guard(input({ current: 92, proposed: 93, floors: [95], lastChangedAt: NOW_SEC - DAY }))).toEqual({ to: 95.1, limitedBy: "tier" });
  });
});

describe("evaluation", () => {
  const fixture = () => fixtureRows("2026-10-04");

  it("proposes and limits every measured effect of the registry", () => {
    const result = evaluate(fixture(), registry, EMPTY, NOW);
    expect(result).toMatchObject({ cal: "provisional-1", runs: 24, excluded: 4, exclusions: { refresh: 1, baseline: 1, busy: 1, thermal: 1 }, applied: true });
    expect(result.changes).toEqual([
      { effect: "counters", from: 12, to: 10, proposed: 10, devices: 24, limitedBy: null },
      { effect: "entrances", from: 24, to: 20.1, proposed: 10, devices: 24, limitedBy: "tier" },
      { effect: "canvasLowRes", from: 32, to: 34, proposed: 34, devices: 24, limitedBy: null },
      { effect: "shimmer", from: 38, to: 42, proposed: 42, devices: 24, limitedBy: null },
      { effect: "textReveal", from: 46, to: 46, proposed: 46, devices: 24, limitedBy: null },
      { effect: "parallax", from: 90, to: 72, proposed: 46, devices: 24, limitedBy: "step" },
      { effect: "blur", from: 135, to: 108, proposed: 70, devices: 24, limitedBy: "step" },
      { effect: "canvasHiRes", from: 180, to: 144, proposed: 60, devices: 24, limitedBy: "step" },
    ]);
  });

  it("changes only effect thresholds", () => {
    const { patch } = evaluate(fixture(), registry, EMPTY, NOW);
    expect(patch).toEqual({
      effects: { counters: { threshold: 10 }, entrances: { threshold: 20.1 }, canvasLowRes: { threshold: 34 }, shimmer: { threshold: 42 }, parallax: { threshold: 72 }, blur: { threshold: 108 }, canvasHiRes: { threshold: 144 } },
    });
    expect(Object.keys(patch)).toEqual(["effects"]);
    for (const effect of Object.values(patch.effects)) expect(Object.keys(effect)).toEqual(["threshold"]);
  });

  it("steps from the patch in force, keeps its other effects and honors the cadence", () => {
    const state = { patch: { effects: { blur: { threshold: 120 }, hover: { threshold: 9 }, gone: { threshold: 5 } } }, lastChanged: { canvasHiRes: NOW_SEC - DAY } };
    const result = evaluate(fixture(), registry, state, NOW);
    expect(result.changes.find((c) => c.effect === "blur")).toMatchObject({ from: 120, to: 96, limitedBy: "step" });
    expect(result.changes.find((c) => c.effect === "canvasHiRes")).toMatchObject({ from: 180, to: 180, limitedBy: "cadence" });
    expect(result.patch.effects).toMatchObject({ blur: { threshold: 96 }, hover: { threshold: 9 } });
    expect(result.patch.effects).not.toHaveProperty("gone");
    expect(result.patch.effects).not.toHaveProperty("canvasHiRes");
  });

  it("applies nothing and keeps the patch in force when no effect has enough devices", () => {
    const state = { patch: { effects: { blur: { threshold: 120 } } }, lastChanged: {} };
    const result = evaluate(fixture().slice(0, 9), registry, state, NOW);
    expect(result.applied).toBe(false);
    expect(result.changes.every((c) => c.proposed === null && c.limitedBy === "devices" && c.to === c.from)).toBe(true);
    expect(result.patch).toEqual(state.patch);
  });

  it("converges over days without crossing the hard limits", () => {
    let state = stateFromLog([]);
    const log: Record<string, unknown>[] = [];
    for (let day = 0; day < 60; day++) {
      const now = NOW + day * DAY * 1000;
      const result = evaluate(fixture(), registry, state, now);
      log.push({ id: day + 1, created_at: now / 1000, patch: JSON.stringify(result.patch), changes: JSON.stringify(result.changes), applied: result.applied ? 1 : 0 });
      state = stateFromLog(log);
    }
    const applied = log.filter((r) => r.applied === 1).map((r) => (Number(r.created_at) - NOW_SEC) / DAY);
    expect(applied).toEqual([0, 7, 14]);
    // blur: 135 -> 108 -> 90.1 (tier floor 90) ; canvasHiRes: 180 -> 144 -> 115.2 -> 92.2 ; parallax: 90 -> 72 -> 57.6 -> 49.1 (floor 49).
    expect(state.patch.effects).toMatchObject({ blur: { threshold: 90.1 }, canvasHiRes: { threshold: 92.2 }, parallax: { threshold: 49.1 }, entrances: { threshold: 20.1 } });
  });
});

describe("patch", () => {
  it("reads thresholds only and drops anything else", () => {
    expect(parseAutoPatch('{"effects":{"blur":{"threshold":120,"cost":9},"x":{"threshold":-1},"y":{"threshold":"5"}},"reference":{"float":1}}')).toEqual({
      effects: { blur: { threshold: 120 } },
    });
    expect(parseAutoPatch("not json")).toEqual({ effects: {} });
    expect(parseAutoPatch(null)).toEqual({ effects: {} });
  });

  it("deep-merges the auto patch over calibration.json, auto thresholds winning", () => {
    const base = { reference: { float: 1 }, effects: { blur: { threshold: 135, cost: 6 }, hover: { threshold: 10 } } };
    expect(deepMerge(base, { effects: { blur: { threshold: 108 } } })).toEqual({
      reference: { float: 1 },
      effects: { blur: { threshold: 108, cost: 6 }, hover: { threshold: 10 } },
    });
    expect(deepMerge({}, { effects: { blur: { threshold: 108 } } })).toEqual({ effects: { blur: { threshold: 108 } } });
  });
});
