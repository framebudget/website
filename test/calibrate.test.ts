import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  analyze,
  analyzeLab,
  analyzeLabWork,
  bandThreshold,
  capacityFit,
  currentCalibration,
  failed,
  fitWeights,
  normalize,
  percentile,
  ran,
  readRows,
  scoreOf,
} from "../scripts/calibrate.mjs";

const fixture = (name: string) => readFileSync(new URL("fixtures/" + name, import.meta.url), "utf8");
const REFERENCE = { float: 10800, typed: 219000, alloc: 30900, path: 4860 };
const COLD_REFERENCE = { float: 5500, typed: 45000, alloc: 12400, path: 1780 };
const OPTIONS = { percentile: 50, targetFps: 55, maxUnder: 0.05, minSamples: 10, cal: undefined, reference: REFERENCE };

const KERNEL_NAMES = ["float", "typed", "alloc", "path"] as const;
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

interface RowFields {
  v?: 1 | 2;
  effects?: string[];
  used?: string[];
  stepped?: string[];
  explored?: string | null;
  fps?: Record<string, number>;
  late?: Record<string, number>;
}

/** A stored row (as the D1 export has it) for a device whose every kernel sits at `score` percent of the reference. */
function row(score: number, fields: RowFields): Record<string, unknown> {
  const v = fields.v ?? 2;
  return {
    v,
    cal: "provisional-1",
    score,
    warm: score,
    ...Object.fromEntries(KERNEL_NAMES.map((k) => ["kernel_" + k, (REFERENCE[k] * score) / 100])),
    effects: JSON.stringify(fields.effects ?? []),
    used: v === 2 ? JSON.stringify(fields.used ?? []) : null,
    stepped: JSON.stringify(fields.stepped ?? []),
    explored: fields.explored ?? null,
    fps: JSON.stringify(fields.fps ?? {}),
    late: v === 2 ? JSON.stringify(fields.late ?? {}) : null,
  };
}

const effectOf = (rows: Record<string, unknown>[], name: string, options = {}) =>
  analyze(rows, { ...OPTIONS, minSamples: 5, ...options }).effects.find((e: { name: string }) => e.name === name);

/** Deterministic uniform numbers in [0, 1). */
function lcg(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

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

  it("counts a stepped-down effect as a failure, so low scores that were all stepped get no threshold", () => {
    // Every device under 30 had blur stepped down (it left `effects`); every device from 30 ran it at full speed.
    const rows = [
      ...range(10, 29).map((score) => row(score, { v: 1, stepped: ["blur"], fps: { main: 60 } })),
      ...range(30, 79).map((score) => row(score, { v: 1, effects: ["blur"], fps: { main: 60 } })),
    ];
    expect(failed(normalize(rows[0]!), "blur", { maxLate: 0.1, targetFps: 55 })).toBe(true);
    expect(effectOf(rows, "blur")).toMatchObject({ samples: 70, lowestScore: 10, threshold: 30, failRate: 0, devices: 50 });
  });

  it("band criterion rejects a threshold whose band just above it fails, where the cumulative rate passes", () => {
    // Scores 40..139, one device each; 45, 46 and 47 fail: 3% of everything at or above 40.
    const samples = range(40, 139).map((score) => ({ score, failed: score >= 45 && score <= 47 }));
    const cumulative = samples.filter((s) => s.failed).length / samples.length;
    expect(cumulative).toBeLessThan(0.05);
    // The band of 40 is 40..49: 3 of 10 fail. Every band starting at 41..47 holds a failure; 48 is the first clean one.
    expect(bandThreshold(samples, { band: 0.25, maxUnder: 0.05, minSamples: 5 })).toEqual({ threshold: 48, band: 12, failRate: 0, devices: 92 });
    // A band needs its samples to count: with a minimum above every band size, nothing is proposed.
    expect(bandThreshold(samples, { band: 0.25, maxUnder: 0.05, minSamples: 1000 })).toBeNull();
    // A tolerance above the worst band (30%) accepts the lowest candidate.
    expect(bandThreshold(samples, { band: 0.25, maxUnder: 0.31, minSamples: 5 })?.threshold).toBe(40);
  });

  it("judges v2 rows on late frames and ignores rows where the effect was allowed but not used", () => {
    const rows = [
      // Allowed, used something else: would all fail on late.main, but say nothing about shimmer.
      ...range(50, 79).map((score) => row(score, { effects: ["shimmer"], used: ["hover"], late: { main: 0.5 } })),
      // Used, few late frames for shimmer itself; fps is ignored on v2 rows.
      ...range(60, 79).map((score) => row(score, { effects: ["shimmer"], used: ["shimmer"], late: { main: 0.5, shimmer: 0.02 }, fps: { main: 20 } })),
      // Used, no late entry for shimmer: late.main decides, and it is over --max-late.
      ...range(40, 49).map((score) => row(score, { effects: ["shimmer"], used: ["shimmer"], late: { main: 0.3 } })),
    ];
    expect(effectOf(rows, "shimmer")).toMatchObject({ samples: 30, lowestScore: 40, threshold: 60, failRate: 0, devices: 20 });
    // A looser --max-late passes the late.main devices too.
    expect(effectOf(rows, "shimmer", { maxLate: 0.3 })).toMatchObject({ threshold: 40 });
  });

  it("counts every allowed or stepped effect on a v2 row whose page reported no use", () => {
    // used: [] means the page reported no use: blur stepped down there is still a failure of blur.
    const rows = [
      ...range(10, 29).map((score) => row(score, { stepped: ["blur"], late: { main: 0.02 } })),
      ...range(30, 79).map((score) => row(score, { effects: ["blur"], late: { main: 0.02 } })),
    ];
    expect(ran(normalize(rows[0]!), "blur")).toBe(true);
    expect(effectOf(rows, "blur")).toMatchObject({ samples: 70, lowestScore: 10, threshold: 30, failRate: 0 });
    // Capacity needs to know what the page used: none of these rows counts.
    expect(analyze(rows, { ...OPTIONS, minSamples: 3 }).capacity).toMatchObject({ rows: 0, uncosted: 0, proposed: null });
  });

  it("scores cold-only rows against the cold reference, for weighted effects and capacity loads", () => {
    // Cold-only devices: kernels at `score` percent of the cold reference, no warm run.
    const cold = (score: number) => ({
      ...row(score, { effects: ["blur"], used: ["blur"], late: { main: 0.02 } }),
      warm: null,
      ...Object.fromEntries(KERNEL_NAMES.map((k) => ["kernel_" + k, (COLD_REFERENCE[k] * score) / 100])),
    });
    const rows = range(40, 79).map(cold);
    const calibration = currentCalibration({ effects: { blur: { weights: { path: 1 } } } });
    const result = analyze(rows, { ...OPTIONS, minSamples: 3, calibration });
    // On the warm reference, path at 40% of the cold one would score about 14.6.
    expect(result.effects.find((e: { name: string }) => e.name === "blur")!.lowestScore).toBeCloseTo(40, 6);
    // blur costs 6: the heaviest load is 600 / 40.
    expect(result.capacity.proposed).toBeCloseTo(15, 6);
  });

  it("lets explored rows below the current threshold lower it", () => {
    // parallax is at 70 in the library defaults; exploration turned it on from 53 and it ran clean.
    const rows = [
      ...range(70, 99).map((score) => row(score, { effects: ["parallax"], used: ["parallax"], late: { main: 0.02 } })),
      ...range(53, 69).map((score) => row(score, { effects: ["parallax"], used: ["parallax"], explored: "parallax", late: { main: 0.03 } })),
    ];
    expect(effectOf(rows, "parallax")).toMatchObject({ currentThreshold: 70, samples: 47, explored: 17, lowestScore: 53, threshold: 53 });
  });

  it("puts the weight on the kernel that separates failures", () => {
    const random = lcg(7);
    const samples = range(1, 120).map(() => {
      const x = Object.fromEntries(KERNEL_NAMES.map((k) => [k, random() * 2 - 1])) as Record<(typeof KERNEL_NAMES)[number], number>;
      return {
        kernels: Object.fromEntries(KERNEL_NAMES.map((k) => [k, REFERENCE[k] * Math.exp(x[k])])),
        failed: x.path < -0.2,
      };
    });
    const fit = fitWeights(samples, REFERENCE, 10);
    expect(fit).toMatchObject({ samples: 120, reason: null });
    // Most of the weight on path; what the others get is sampling noise.
    expect(fit.weights!.path).toBeGreaterThanOrEqual(0.8);
    for (const k of ["float", "typed", "alloc"] as const) expect(fit.weights![k] ?? 0).toBeLessThan(0.15);
    expect(fitWeights(samples.slice(0, 19), REFERENCE, 10)).toMatchObject({ weights: null, reason: "fewer than 20 samples" });
    expect(fitWeights(samples.map((s) => ({ ...s, failed: false })), REFERENCE, 10)).toMatchObject({ weights: null });
  });

  it("gives no weight to a kernel that is the same on every sample", () => {
    const random = lcg(11);
    const samples = range(1, 120).map(() => {
      const x = Object.fromEntries(KERNEL_NAMES.map((k) => [k, random() * 2 - 1])) as Record<(typeof KERNEL_NAMES)[number], number>;
      // float is constant: ln(1.3) summed and averaged leaves a spread of about 7e-16, not 0.
      const kernels = Object.fromEntries(KERNEL_NAMES.map((k) => [k, REFERENCE[k] * Math.exp(x[k])]));
      return { kernels: { ...kernels, float: REFERENCE.float * 1.3 }, failed: x.path < -0.2 };
    });
    const fit = fitWeights(samples, REFERENCE, 10);
    expect(fit.weights!.float).toBeUndefined();
    expect(fit.weights!.path).toBeGreaterThanOrEqual(0.8);
  });

  describe("raster kernel", () => {
    const WITH_RASTER = { ...REFERENCE, raster: 900 };
    const BASE = ["float", "typed", "alloc", "path"];

    /** 120 samples with random base kernels; the first `withRaster` also measured raster. */
    function mixed(seed: number, withRaster: number, fails: (x: Record<string, number>) => boolean) {
      const random = lcg(seed);
      return range(1, 120).map((i) => {
        const x = Object.fromEntries([...KERNEL_NAMES, "raster"].map((k) => [k, random() * 2 - 1]));
        const kernels: Record<string, number> = Object.fromEntries(KERNEL_NAMES.map((k) => [k, REFERENCE[k] * Math.exp(x[k]!)]));
        if (i <= withRaster) kernels.raster = WITH_RASTER.raster * Math.exp(x.raster!);
        return { kernels, failed: fails(x) };
      });
    }

    it("scores over the kernels with both a rate and a reference above 0", () => {
      const half = Object.fromEntries(KERNEL_NAMES.map((k) => [k, REFERENCE[k] * 0.5]));
      expect(scoreOf(half, WITH_RASTER)).toBeCloseTo(50, 9);
      // raster at a quarter: geomean of 0.5 x 4 and 0.25.
      expect(scoreOf({ ...half, raster: 225 }, WITH_RASTER)).toBeCloseTo(100 * 2 ** (-6 / 5), 9);
      // A reference without raster, or the cold reference's 0, leaves the rate out.
      expect(scoreOf({ ...half, raster: 225 }, REFERENCE)).toBeCloseTo(50, 9);
      expect(scoreOf({ ...half, raster: 225 }, { ...WITH_RASTER, raster: 0 })).toBeCloseTo(50, 9);
    });

    it("fits the base kernels on every sample while few samples measured raster", () => {
      const samples = mixed(13, 40, (x) => x.path! < -0.2);
      const fit = fitWeights(samples, WITH_RASTER, 10);
      expect(fit).toMatchObject({ samples: 120, kernels: BASE, reason: null });
      expect(fit.weights!.raster).toBeUndefined();
      expect(fit.weights!.path).toBeGreaterThanOrEqual(0.8);
    });

    it("adds raster, on the samples that measured it, once enough of them did", () => {
      const samples = mixed(17, 90, (x) => x.raster! < -0.2);
      const fit = fitWeights(samples, WITH_RASTER, 10);
      expect(fit).toMatchObject({ samples: 90, kernels: [...BASE, "raster"], reason: null });
      expect(fit.weights!.raster).toBeGreaterThanOrEqual(0.8);
      // Without a raster reference, raster never joins and no sample is dropped.
      expect(fitWeights(samples, REFERENCE, 10)).toMatchObject({ samples: 120, kernels: BASE });
    });

    it("keeps rows without raster in the report analysis", () => {
      const rows = range(40, 79).flatMap((score) => {
        const fast = row(score, { effects: ["blur"], used: ["blur"], late: { main: 0.01 } });
        const slow = row(score, { effects: ["blur"], used: ["blur"], late: { main: 0.4 } });
        slow.kernel_path = (REFERENCE.path * score) / 200;
        slow.kernel_float = (REFERENCE.float * score) / 50;
        // A quarter of the rows come from a library that measures raster.
        if (score % 4 === 0) fast.kernel_raster = slow.kernel_raster = (WITH_RASTER.raster * score) / 100;
        return [fast, slow];
      });
      const result = analyze(rows, { ...OPTIONS, reference: WITH_RASTER, minSamples: 5 });
      const blur = result.weights.find((w: { name: string }) => w.name === "blur")!;
      expect(blur).toMatchObject({ samples: 80, kernels: BASE });
      expect(blur.weights!.path).toBeGreaterThanOrEqual(0.9);
      expect(result.proposed.raster).toBeGreaterThan(0);
    });
  });

  it("proposes weights and a weighted threshold from the report rows", () => {
    // Two device families with the same device score: only the slow-path one fails.
    const rows = range(40, 79).flatMap((score) => {
      const fast = row(score, { effects: ["blur"], used: ["blur"], late: { main: 0.01 } });
      const slow = row(score, { effects: ["blur"], used: ["blur"], late: { main: 0.4 } });
      slow.kernel_path = (REFERENCE.path * score) / 200;
      slow.kernel_float = (REFERENCE.float * score) / 50;
      return [fast, slow];
    });
    const blur = analyze(rows, { ...OPTIONS, minSamples: 5 }).weights.find((w: { name: string }) => w.name === "blur")!;
    expect(blur.weights!.path).toBeGreaterThanOrEqual(0.9);
    expect(blur.threshold).not.toBeNull();
  });

  it("capacity fit picks the highest load whose bands at or below it all pass", () => {
    // Two pages at each load 1..40; pages above 30 fail.
    const rows = range(1, 40).flatMap((load) => [0, 1].map(() => ({ load, failed: load > 30 })));
    // The band of 30 is 24 < load <= 30: 12 pages, all passing; the band of 31 holds failures.
    expect(capacityFit(rows, { band: 0.25, maxUnder: 0.05, minSamples: 3 })).toEqual({ capacity: 30, band: 12, failRate: 0, rows: 80 });
    // A failing band low down stops the search there, whatever passes above it.
    const low = rows.map((r) => ({ ...r, failed: r.load === 5 || r.load > 30 }));
    expect(capacityFit(low, { band: 0.25, maxUnder: 0.05, minSamples: 2 })?.capacity).toBe(4);
  });

  it("computes the load from the current costs on v2 rows", () => {
    // blur costs 6: load = 600 / score. Under score 20 (load over 30) blur was stepped down.
    const rows = range(10, 60).map((score) =>
      score < 20 ? row(score, { used: ["blur"], stepped: ["blur"], late: { main: 0.02 } }) : row(score, { effects: ["blur"], used: ["blur"], late: { main: 0.02 } }),
    );
    const v1 = row(15, { v: 1, effects: ["blur"], fps: { main: 20 } });
    const { capacity } = analyze([...rows, v1], { ...OPTIONS, minSamples: 3 });
    expect(capacity).toMatchObject({ current: 0, rows: 51, band: 5, failRate: 0 });
    expect(capacity.proposed).toBeCloseTo(30, 6);
    // A patch with a cheaper blur halves every load.
    const cheaper = analyze(rows, { ...OPTIONS, minSamples: 3, calibration: currentCalibration({ effects: { blur: { cost: 3 } } }) });
    expect(cheaper.capacity.proposed).toBeCloseTo(15, 6);
  });

  it("skips capacity rows that ran an effect without a cost", () => {
    const rows = range(20, 60).map((score) => row(score, { effects: ["blur"], used: ["blur"], late: { main: 0.02 } }));
    // `mine` has no cost anywhere: its late frames would count against blur's load.
    const uncosted = range(20, 30).map((score) => row(score, { effects: ["blur", "mine"], used: ["blur", "mine"], late: { main: 0.5 } }));
    const { capacity } = analyze([...rows, ...uncosted], { ...OPTIONS, minSamples: 3 });
    expect(capacity).toMatchObject({ rows: 41, uncosted: 11, failRate: 0 });
    expect(capacity.proposed).toBeCloseTo(30, 6);
  });

  it("merges calibration patches by effect, field by field, ignoring invalid values", () => {
    const merged = currentCalibration(
      { effects: { blur: { threshold: 80, cost: -1 } }, capacity: 12, coldReference: { path: 2000, float: -1 } },
      { effects: { blur: { weights: { path: 1, gpu: 2, float: "x", typed: 0 } }, mine: { cost: 2 } }, capacity: -3, reference: { path: 0 } },
    );
    expect(merged.effects.blur).toEqual({ threshold: 80, cost: 6, weights: { path: 1 } });
    expect(merged.effects.mine).toEqual({ cost: 2 });
    expect(merged.capacity).toBe(12);
    expect(merged.reference).toEqual(REFERENCE);
    expect(merged.coldReference).toEqual({ ...COLD_REFERENCE, path: 2000 });
    // Weights that are all zero are no weights.
    expect(currentCalibration({ effects: { blur: { weights: { path: 0, float: 0 } } } }).effects.blur).toEqual({ threshold: 90, cost: 6 });
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

    it("proposes the lowest score at which devices keep their late frames near their baseline", () => {
      expect(effect("canvasLowRes")).toMatchObject({ devices: 18, threshold: 52, above: 12, under: 0 });
      expect(effect("entrances")).toMatchObject({ threshold: 12, above: 18 });
    });

    it("gives no threshold without enough devices at or above one", () => {
      expect(effect("blur")).toMatchObject({ devices: 5, threshold: null });
      // `all` keeps a p95 of 24.5 ms with 1 of 300 frames late at 60 Hz (no miss), but drops 20% at 120 Hz.
      expect(effect("all")).toMatchObject({ devices: 18, threshold: null });
      expect(analyzeLab(readRows(fixture("lab-export.json")), { ...OPTIONS, minSamples: 5 }).effects.find((e) => e.name === "blur")).toMatchObject({ threshold: 104 });
    });

    it("judges a step by its late frames over the run's baseline, not by its p95 frame time", () => {
      const run = (score: number, blur: { over: number; frames: number }, baselineFrames = 304) => ({
        cal: "c",
        score,
        refresh_hz: 61,
        steps: JSON.stringify([
          { name: "baseline", medianMs: 16.4, p95Ms: 19, over: 4, frames: baselineFrames },
          { name: "blur", medianMs: 16.4, p95Ms: 19, ...blur },
          { name: "baseline-end", medianMs: 16.4, p95Ms: 19, over: 0, frames: baselineFrames },
        ]),
      });
      const options = { ...OPTIONS, minSamples: 1 };
      // Jitter: p95 19 ms, over a 55 fps target at 61 Hz, and as many late frames as the baseline.
      expect(analyzeLab([run(40, { over: 3, frames: 303 }), run(50, { over: 0, frames: 306 })], options).effects[0]).toMatchObject({ threshold: 40, above: 2 });
      // 17 of 246 late (6.9%) against 4 of 608 (0.7%): a miss.
      expect(analyzeLab([run(40, { over: 17, frames: 246 }), run(50, { over: 0, frames: 306 })], options).effects[0]).toMatchObject({ threshold: 50, above: 1 });
      // A run without baseline frames is not analyzed, and a step without frames is not a sample.
      expect(analyzeLab([run(40, { over: 17, frames: 246 }, 0), run(50, { over: 0, frames: 0 })], options)).toMatchObject({ runs: 1, effects: [{ name: "blur", devices: 0, threshold: null }] });
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
      // The drop-based analysis also uses protocol 2 runs only once any exist: 12 of the 15 runs with a baseline.
      expect(analyzeLab(rows(), OPTIONS)).toMatchObject({ rows: 17, protocol2Only: true, runs: 12 });
      expect(analyzeLab(readRows(fixture("lab-export.json")), OPTIONS)).toMatchObject({ protocol2Only: false, runs: 19 });
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

    it("counts a device that ran both protocols once in the drop-based analysis", () => {
      const run = (protocol: number, score: number) => ({
        cal: "c",
        protocol,
        score,
        refresh_hz: 60,
        steps: JSON.stringify([
          { name: "baseline", medianMs: 16.7, p95Ms: 17, over: 0, frames: 300 },
          { name: "blur", medianMs: 16.7, p95Ms: 17, over: 0, frames: 300 },
        ]),
      });
      const options = { ...OPTIONS, minSamples: 1 };
      expect(analyzeLab([run(1, 40), run(2, 40), run(1, 30)], options)).toMatchObject({ rows: 3, runs: 1, effects: [{ name: "blur", devices: 1, threshold: 40 }] });
      expect(analyzeLab([run(1, 40), run(1, 30)], options)).toMatchObject({ runs: 2, effects: [{ name: "blur", devices: 2, threshold: 30 }] });
    });
  });
});
