import { describe, expect, it } from "vitest";
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

describe("validateReport", () => {
  it("accepts the report the library's buildReport produces", async () => {
    // Imported through a runtime path so the worker typecheck stays free of DOM types.
    const lib = new URL("../../src/core/telemetry/build-report.ts", import.meta.url).href;
    const { buildReport } = (await import(lib)) as { buildReport: (input: unknown) => unknown };
    const bench = (score: number) => ({
      score,
      rates: { float: 7134.2, typed: 151234, alloc: 18234.5, path: 3011.7 },
      tickMs: 0.1000001,
      rounds: 5,
      sink: 1,
    });
    const report = buildReport({
      calibration: { version: "provisional-1" },
      score: 61.6,
      cold: bench(48.2),
      warm: bench(66.4),
      hints: { cores: 8, memoryGb: 4, reducedMotion: false, gpc: false, saveData: false },
      pressure: undefined,
      tier: "Medium",
      effects: ["hover", "entrances", "canvasLowRes"],
      stepped: ["canvasLowRes"],
      fps: { main: 58.4, canvasLowRes: 41.6 },
    });
    // sendBeacon sends JSON.stringify(report), which drops undefined keys.
    expect(validateReport(JSON.parse(JSON.stringify(report)))).not.toBeNull();
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
