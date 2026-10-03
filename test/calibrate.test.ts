import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyze, analyzeLab, analyzeLabWork, effectThreshold, labTargetMs, parseEffectMs, percentile, readRows, scoreOf } from "../scripts/calibrate.mjs";

const fixture = (name: string) => readFileSync(new URL("fixtures/" + name, import.meta.url), "utf8");
const REFERENCE = { float: 10800, typed: 219000, alloc: 30900, path: 4860 };
const OPTIONS = { percentile: 50, targetFps: 55, maxUnder: 0.05, minSamples: 10, cal: undefined, reference: REFERENCE };

describe("calibrate", () => {
  it("reads the CSV export into the same analysis as the wrangler JSON export", () => {
    const fromJson = readRows(fixture("export.json"));
    const fromCsv = readRows(fixture("export.csv"));
    expect(fromCsv).toHaveLength(fromJson.length);
    expect(analyze(fromCsv, OPTIONS)).toEqual(analyze(fromJson, OPTIONS));
  });

  it("matches the library's score: the stored warm score on the current reference", () => {
    for (const row of readRows(fixture("export.json")).filter((r) => r.warm !== null)) {
      const kernels = { float: row.kernel_float, typed: row.kernel_typed, alloc: row.kernel_alloc, path: row.kernel_path };
      expect(Math.round(scoreOf(kernels, REFERENCE)!)).toBe(row.warm);
    }
  });

  it("puts the percentile device at 100 and rescales every score by the reported factor", () => {
    const rows = readRows(fixture("export.json"));
    const result = analyze(rows, OPTIONS);
    const warm = rows.filter((r) => r.warm !== null);
    expect(result.proposed.float).toBe(percentile(warm.map((r) => r.kernel_float), 50));
    for (const row of warm) {
      const kernels = { float: row.kernel_float, typed: row.kernel_typed, alloc: row.kernel_alloc, path: row.kernel_path };
      expect(scoreOf(kernels, result.proposed)).toBeCloseTo(scoreOf(kernels, REFERENCE)! * result.factor!, 6);
    }
  });

  it("ignores cold-only rows for references and other calibration versions for thresholds", () => {
    const result = analyze(readRows(fixture("export.json")), OPTIONS);
    expect(result).toMatchObject({ rows: 30, warmRows: 29, cal: "provisional-1", scoredRows: 29 });
  });

  it("percentile interpolates between ranks", () => {
    expect(percentile([4, 1, 3, 2], 50)).toBe(2.5);
    expect(percentile([1, 2, 3, 4], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4], 100)).toBe(4);
    expect(percentile([], 50)).toBeNull();
  });

  it("finds the lowest threshold under the tolerated fraction, strictly", () => {
    // Scores 10..100; devices under 50 drop frames.
    const samples = Array.from({ length: 10 }, (_, i) => ({ score: (i + 1) * 10, fps: i < 4 ? 30 : 60 }));
    expect(effectThreshold(samples, 55, 0.05, 1)).toEqual({ threshold: 50, devices: 6, under: 0 });
    // At 40, 1 of 7 is under (14.3%): accepted only when the tolerance is above that.
    expect(effectThreshold(samples, 55, 0.15, 1)?.threshold).toBe(40);
    expect(effectThreshold(samples, 55, 1 / 7, 1)?.threshold).toBe(50);
    // Too few devices left above the clean threshold.
    expect(effectThreshold(samples, 55, 0.05, 7)).toBeNull();
  });

  describe("--lab", () => {
    const lab = () => analyzeLab(readRows(fixture("lab-export.json")), OPTIONS);
    const effect = (name: string) => lab().effects.find((e) => e.name === name)!;

    it("analyzes the runs of the main calibration version that measured a baseline", () => {
      expect(lab()).toMatchObject({ rows: 21, completed: 19, cal: "provisional-1", runs: 19 });
      expect(lab().effects.map((e) => e.name)).toEqual(["all", "blur", "canvasLowRes", "entrances"]);
    });

    it("reports the cost over the run's own baseline, by score bucket", () => {
      // Scores 12 and 18: canvasLowRes adds 120 / score ms to the baseline median (rounded to 0.1 ms).
      expect(effect("canvasLowRes").buckets[0]).toMatchObject({ label: "0-25", devices: 2 });
      expect(effect("canvasLowRes").buckets[0]!.medianCost).toBeCloseTo((10 + 6.7) / 2, 6);
      expect(effect("canvasLowRes").buckets[0]!.p95Cost).toBeCloseTo(6.7 + (10 - 6.7) * 0.95, 6);
      expect(effect("blur").buckets.slice(0, 4).every((b) => b.devices === 0 && b.medianCost === null)).toBe(true);
      expect(effect("canvasLowRes").buckets.reduce((n, b) => n + b.devices, 0)).toBe(18);
    });

    it("proposes the lowest score that keeps the p95 frame time within the target", () => {
      expect(effect("canvasLowRes")).toMatchObject({ devices: 18, threshold: 52, above: 12, under: 0 });
      expect(effect("entrances")).toMatchObject({ threshold: 12, above: 18 });
    });

    it("gives no threshold without enough devices at or above one", () => {
      expect(effect("blur")).toMatchObject({ devices: 5, threshold: null });
      expect(effect("all")).toMatchObject({ devices: 18, threshold: null });
      expect(analyzeLab(readRows(fixture("lab-export.json")), { ...OPTIONS, minSamples: 5 }).effects.find((e) => e.name === "blur")).toMatchObject({ threshold: 104 });
    });

    it("scales the frame time target by the refresh rate", () => {
      expect(labTargetMs(55, 60)).toBeCloseTo(1000 / 55, 9);
      expect(labTargetMs(55, 120)).toBeCloseTo(500 / 55, 9);
      // p95 12 ms is within the target at 60 Hz and over it at 120 Hz.
      const run = (score: number, hz: number) => ({
        cal: "c",
        score,
        refresh_hz: hz,
        steps: JSON.stringify([
          { name: "baseline", medianMs: 8, p95Ms: 9 },
          { name: "blur", medianMs: 10, p95Ms: 12 },
        ]),
      });
      const options = { ...OPTIONS, minSamples: 1 };
      expect(analyzeLab([run(40, 120), run(50, 60)], options).effects[0]).toMatchObject({ threshold: 50, above: 1 });
      expect(analyzeLab([run(40, 60), run(50, 60)], options).effects[0]).toMatchObject({ threshold: 40, above: 2 });
    });
  });

  describe("--lab, main-thread work (protocol 2)", () => {
    const rows = () => readRows(fixture("lab-work-export.json"));
    const CURRENT = { blur: 1.5, canvasLowRes: 0.6, entrances: 0.4 };
    const work = (options = OPTIONS) => analyzeLabWork(rows(), options, CURRENT);
    const effect = (name: string, options = OPTIONS) => work(options).effects.find((e) => e.name === name)!;

    it("uses only protocol 2 runs of the main calibration version with a baseline work sample", () => {
      // 17 rows: 3 protocol 1, one protocol 2 without baseline work, one without a baseline step, one on another version.
      expect(work()).toMatchObject({ protocolCounts: { 1: 3, 2: 14 }, cal: "provisional-1", runs: 11 });
      expect(work().effects.map((e) => e.name)).toEqual(["all", "blur", "canvasLowRes", "entrances"]);
      // The drop-based analysis still counts every run with a baseline, protocol 1 included.
      expect(analyzeLab(rows(), OPTIONS).runs).toBe(15);
    });

    it("summarizes the cost on the score 100 device next to the current ms, and proposes the median", () => {
      const canvas = effect("canvasLowRes");
      expect(canvas).toMatchObject({ devices: 11, currentMs: 0.6 });
      expect(canvas.medianMs).toBeCloseTo(0.8, 9);
      expect(canvas.p90Ms).toBeCloseTo(1.2, 9);
      expect(canvas.proposedMs).toBe(canvas.medianMs);
      expect(effect("all")).toMatchObject({ devices: 11, currentMs: null });
    });

    it("proposes nothing below --min-samples devices, and lowering it proposes", () => {
      // Five runs measured blur; one had no work sample.
      expect(effect("blur")).toMatchObject({ devices: 4, currentMs: 1.5, proposedMs: null });
      expect(effect("blur").medianMs).toBeCloseTo(0.2, 9);
      expect(effect("blur", { ...OPTIONS, minSamples: 4 }).proposedMs).toBeCloseTo(0.2, 9);
      expect(effect("canvasLowRes", { ...OPTIONS, minSamples: 12 }).proposedMs).toBeNull();
    });

    it("scales the cost by score / 100 and floors it at 0", () => {
      const run = (score: number, baseline: number, blur: number) => ({
        cal: "c",
        protocol: 2,
        score,
        steps: JSON.stringify([
          { name: "baseline", medianMs: 16.7, p95Ms: 17, workMeanMs: baseline },
          { name: "blur", medianMs: 16.7, p95Ms: 17, workMeanMs: blur },
        ]),
      });
      const options = { ...OPTIONS, minSamples: 1 };
      expect(analyzeLabWork([run(50, 2, 3)], options).effects[0]!.proposedMs).toBeCloseTo(0.5, 9);
      expect(analyzeLabWork([run(200, 2, 3)], options).effects[0]!.proposedMs).toBeCloseTo(2, 9);
      expect(analyzeLabWork([run(50, 3, 2)], options).effects[0]!.proposedMs).toBe(0);
    });

    it("reads the current ms of every effect from docs/src/effects.ts", () => {
      expect(parseEffectMs('  { name: "hover", label: "Hover states", threshold: 10, cost: 1, ms: 0.2, color: "#b8c0d0" },\n  { name: "blur", label: "x", cost: 6, ms: 1.5 },')).toEqual({ hover: 0.2, blur: 1.5 });
      const site = parseEffectMs(readFileSync(new URL("../docs/src/effects.ts", import.meta.url), "utf8"));
      expect(site).toMatchObject({ hover: 0.2, canvasLowRes: 0.6, blur: 1.5, canvasHiRes: 2.6 });
    });
  });
});
