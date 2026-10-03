import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyze, effectThreshold, percentile, readRows, scoreOf } from "../scripts/calibrate.mjs";

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
});
