import { createBudget, type CreateBudgetOptions, type TelemetryReport } from "framebudget";
import { describe, expect, it, vi } from "vitest";
import { validateReport } from "../src/validate";
import { validReport, validReportV2 } from "./helpers";

/** The report as mutable JSON; tests write deliberately wrong values into it. */
interface Loose {
  [key: string]: unknown;
  hints: Record<string, unknown>;
  kernels: Record<string, unknown>;
  fps: Record<string, unknown>;
  effects: unknown[];
}
type Mutate = (r: Loose) => void;

const variant = (mutate: Mutate, base: () => Record<string, unknown> = validReport) => {
  const r = base() as Loose;
  mutate(r);
  return validateReport(JSON.parse(JSON.stringify(r)));
};

/**
 * A loaded page with just enough browser for the library: a real clock for the
 * benchmark, timers that run when the test drains them, event listeners it can
 * fire, and a navigator whose sendBeacon records what the library sends. No
 * DOM types are needed.
 */
function fakePage() {
  const listeners: Record<string, (() => void)[]> = {};
  const timers: (() => void)[] = [];
  const beacons: { url: string; body: string }[] = [];
  const addEventListener = (type: string, listener: () => void) => (listeners[type] ??= []).push(listener);
  const scope = {
    document: { readyState: "complete", visibilityState: "visible", addEventListener },
    navigator: {
      hardwareConcurrency: 8,
      deviceMemory: 4,
      sendBeacon: (url: string, body: string) => beacons.push({ url, body }) > 0,
    },
    location: { search: "" },
    performance: { now: () => performance.now() },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    setTimeout: (callback: () => void) => timers.push(callback),
    addEventListener,
  } as unknown as NonNullable<CreateBudgetOptions["scope"]>;
  return { scope, listeners, timers, beacons };
}

describe("validateReport", () => {
  it("accepts the report the library sends", async () => {
    const page = fakePage();
    const budget = createBudget({ scope: page.scope, random: () => 0, pause: () => Promise.resolve() });
    budget.configure({ share: { sampleRate: 1, calibrationUrl: "/api/calibration" }, governor: { auto: false } });
    // Load runs on a timer; after the warm benchmark, sharing arms the report on pagehide. The governor
    // listens to pagehide from load too, so fire it until the report goes out (it is sent once).
    await vi.waitFor(() => {
      page.timers.splice(0).forEach((timer) => timer());
      page.listeners.pagehide?.forEach((listener) => listener());
      expect(page.beacons.length).toBeGreaterThan(0);
    });

    expect(page.beacons.map((b) => b.url)).toEqual(["https://framebudget.dev/api/report"]);
    const report = JSON.parse(page.beacons[0]!.body) as TelemetryReport;
    // The real benchmark and the default effects: kernel rates, a warm score and allowed effects all present.
    expect(report.warm).not.toBeNull();
    expect(Object.keys(report.kernels).length).toBeGreaterThan(0);
    expect(report.effects.length).toBeGreaterThan(0);
    expect(report.effects).toEqual([...budget.effects()].sort());
    expect(validateReport(report)).not.toBeNull();
  });

  it("accepts minimal reports: no bench, no optional hints, empty lists", () => {
    expect(
      variant((r) => {
        r.cold = r.warm = r.tickMs = null;
        r.kernels = {};
        r.hints = { reducedMotion: true };
        r.effects = [];
        r.fps = {};
      }),
    ).not.toBeNull();
  });

  it.each<[string, Mutate]>([
    ["extra top-level key", (r) => (r.ua = "x")],
    ["extra hints key", (r) => (r.hints.gpc = false)],
    ["extra kernel", (r) => (r.kernels.canvas = 10)],
    ["missing required key", (r) => delete (r as Record<string, unknown>).fps],
    ["missing reducedMotion", (r) => delete r.hints.reducedMotion],
    ["__proto__ key", (r) => Object.defineProperty(r, "__proto__", { value: 1, enumerable: true })],
  ])("rejects %s", (_name, mutate) => {
    expect(variant(mutate)).toBeNull();
  });

  it.each<[string, Mutate]>([
    ["v 3", (r) => (r.v = 3)],
    ["v 2 with a v1 shape", (r) => (r.v = 2)],
    ["v as string", (r) => (r.v = "1")],
    ["empty cal", (r) => (r.cal = "")],
    ["cal over 64 chars", (r) => (r.cal = "x".repeat(65))],
    ["cal with control char", (r) => (r.cal = "a\nb")],
    ["fractional score", (r) => (r.score = 61.5)],
    ["negative score", (r) => (r.score = -1)],
    ["huge score", (r) => (r.score = 1e7)],
    ["score as string", (r) => (r.score = "62")],
    ["warm undefined (absent)", (r) => delete r.warm],
    ["zero kernel rate", (r) => (r.kernels.float = 0)],
    ["zero raster rate", (r) => (r.kernels.raster = 0)],
    ["raster rate over MAX_RATE", (r) => (r.kernels.raster = 2e9)],
    ["raster rate as string", (r) => (r.kernels.raster = "812")],
    ["kernels as array", (r) => ((r as Record<string, unknown>).kernels = [1, 2])],
    ["negative tick", (r) => (r.tickMs = -0.1)],
    ["fractional cores", (r) => (r.hints.cores = 2.5)],
    ["zero memory", (r) => (r.hints.memoryGb = 0)],
    ["null cores", (r) => (r.hints.cores = null)],
    ["unknown pressure", (r) => (r.hints.pressure = "high")],
    ["reducedMotion as number", (r) => (r.hints.reducedMotion = 0)],
    ["unknown tier", (r) => (r.tier = "Ultra")],
    ["effects not array", (r) => ((r as Record<string, unknown>).effects = "hover")],
    ["duplicate effect", (r) => r.effects.push("hover")],
    ["bad effect name", (r) => r.effects.push("<script>")],
    ["effect name too long", (r) => r.effects.push("a".repeat(33))],
    ["too many effects", (r) => (r.effects = Array.from({ length: 65 }, (_, i) => "e" + i))],
    ["non-string stepped", (r) => (r.stepped = [1])],
    ["fps over 1000", (r) => (r.fps.main = 1001)],
    ["fractional fps", (r) => (r.fps.main = 58.5)],
    ["bad fps key", (r) => (r.fps["main frame"] = 30)],
    ["too many fps keys", (r) => (r.fps = Object.fromEntries(Array.from({ length: 41 }, (_, i) => ["s" + i, 60])))],
  ])("rejects %s", (_name, mutate) => {
    expect(variant(mutate)).toBeNull();
  });

  it("accepts a v2 report and its minimal form", () => {
    expect(validateReport(validReportV2())).toEqual(validReportV2());
    expect(
      variant((r) => {
        r.cold = r.warm = r.tickMs = null;
        r.kernels = {};
        r.hints = { reducedMotion: true };
        r.effects = r.used = r.stepped = [];
        r.fps = r.late = {};
      }, validReportV2),
    ).not.toBeNull();
    expect(variant((r) => (r.explored = "canvasHiRes"), validReportV2)).not.toBeNull();
  });

  it("accepts the optional raster kernel in v1 and v2 reports", () => {
    const v1 = variant((r) => (r.kernels.raster = 812));
    expect(v1?.kernels).toEqual({ float: 7130, typed: 151000, alloc: 18200, path: 3010, raster: 812 });
    expect(variant((r) => (r.kernels.raster = 812), validReportV2)?.kernels.raster).toBe(812);
    expect(variant((r) => (r.kernels = { raster: 0.5 }), validReportV2)).not.toBeNull();
  });

  it.each<[string, Mutate]>([
    ["v2 missing late", (r) => delete r.late],
    ["v2 missing used", (r) => delete r.used],
    ["v2 missing explored", (r) => delete r.explored],
    ["v2 with an extra key", (r) => (r.ua = "x")],
    ["v1 shape under v 1", (r) => (r.v = 1)],
    ["explored as number", (r) => (r.explored = 1)],
    ["explored with a bad name", (r) => (r.explored = "<script>")],
    ["explored empty", (r) => (r.explored = "")],
    ["late over 1", (r) => ((r.late as Record<string, unknown>).main = 1.01)],
    ["late negative", (r) => ((r.late as Record<string, unknown>).main = -0.01)],
    ["late as string", (r) => ((r.late as Record<string, unknown>).main = "0.1")],
    ["late null", (r) => ((r.late as Record<string, unknown>).main = null)],
    ["late as array", (r) => (r.late = [0.1])],
    ["bad late key", (r) => ((r.late as Record<string, unknown>)["main frame"] = 0.1)],
    ["too many late keys", (r) => (r.late = Object.fromEntries(Array.from({ length: 41 }, (_, i) => ["s" + i, 0])))],
    ["duplicate used", (r) => (r.used as unknown[]).push("hover")],
    ["bad used name", (r) => (r.used as unknown[]).push("<script>")],
    ["used not array", (r) => (r.used = "hover")],
    ["unknown kernel next to raster", (r) => Object.assign(r.kernels, { raster: 812, blur: 10 })],
  ])("rejects v2 %s", (_name, mutate) => {
    expect(variant(mutate, validReportV2)).toBeNull();
  });

  it.each<[string, Mutate]>([
    ["used", (r) => (r.used = [])],
    ["explored", (r) => (r.explored = null)],
    ["late", (r) => (r.late = {})],
  ])("rejects the v2 key %s on a v1 report", (_name, mutate) => {
    expect(variant(mutate)).toBeNull();
  });

  it("rejects a non-finite late fraction", () => {
    const r = { ...validReportV2(), late: { main: Number.NaN } };
    expect(validateReport(r)).toBeNull();
    expect(validateReport({ ...r, late: { main: Number.POSITIVE_INFINITY } })).toBeNull();
  });

  it("accepts v2 limits at their edges", () => {
    expect(
      variant((r) => {
        r.used = Array.from({ length: 64 }, (_, i) => "e" + i);
        r.explored = "a".repeat(32);
        r.late = Object.fromEntries(Array.from({ length: 40 }, (_, i) => ["s" + i, i === 0 ? 1 : 0]));
      }, validReportV2),
    ).not.toBeNull();
  });

  it.each([null, [], "report", 1])("rejects non-object %j", (input) => {
    expect(validateReport(input)).toBeNull();
  });

  it("accepts limits at their edges", () => {
    expect(
      variant((r) => {
        r.cal = "x".repeat(64);
        r.effects = Array.from({ length: 64 }, (_, i) => "e" + i);
        r.fps = Object.fromEntries(Array.from({ length: 40 }, (_, i) => ["s" + i, i === 0 ? 1000 : 0]));
      }),
    ).not.toBeNull();
  });
});
