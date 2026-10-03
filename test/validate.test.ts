import { createBudget, type CreateBudgetOptions, type TelemetryReport } from "framebudget";
import { describe, expect, it, vi } from "vitest";
import { validateReport } from "../src/validate";
import { validReport } from "./helpers";

/** The report as mutable JSON; tests write deliberately wrong values into it. */
interface Loose {
  [key: string]: unknown;
  hints: Record<string, unknown>;
  kernels: Record<string, unknown>;
  fps: Record<string, unknown>;
  effects: unknown[];
}
type Mutate = (r: Loose) => void;

const variant = (mutate: Mutate) => {
  const r = validReport() as Loose;
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
    budget.configure({ share: { endpoint: "/api/report", sampleRate: 1 }, governor: { auto: false } });
    // Load runs on a timer; after the warm benchmark, sharing arms the report on pagehide.
    await vi.waitFor(() => {
      page.timers.splice(0).forEach((timer) => timer());
      expect(page.listeners.pagehide).toBeDefined();
    });
    page.listeners.pagehide!.forEach((listener) => listener());

    expect(page.beacons.map((b) => b.url)).toEqual(["/api/report"]);
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
    ["v 2", (r) => (r.v = 2)],
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
