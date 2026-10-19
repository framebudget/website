#!/usr/bin/env node
/**
 * Proposes framebudget calibration numbers from exported reports (reference
 * rates, effect thresholds, effect weights and the load capacity), and effect
 * thresholds from exported lab runs.
 *
 *   npx wrangler d1 execute framebudget --remote --json --command "SELECT * FROM reports" > export.json
 *   node scripts/calibrate.mjs export.json [--percentile 50] [--max-late 0.1] [--max-under 0.05] [--band 0.25] [--calibration <file>]
 *
 *   npx wrangler d1 execute framebudget --remote --json --command "SELECT * FROM lab_runs" > lab.json
 *   node scripts/calibrate.mjs --lab lab.json [--max-under 0.05] [--min-samples 10] [--current <file>]
 *
 * Node 22.18 or later; the only import outside Node and this repository is
 * `defaultCalibration` from the installed `framebudget` package (`npm ci` at the
 * repository root), for the current reference rates, effect costs, thresholds and
 * weights. The lab threshold search and the auto calibration come from src/calibration/ (TypeScript, run with Node's type
 * stripping), the same code the Worker's daily cron runs, and its run selection is
 * the cron's SQL, run over the export in an in-memory node:sqlite. Accepts the wrangler JSON
 * export (an array of `{ results: [...] }`), a plain JSON array of rows, or a CSV
 * export with a header row. Reads report v1 and v2 rows.
 */
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { defaultCalibration } from "framebudget";
import { evaluate } from "../src/calibration/evaluate.ts";
import { stateFromLog } from "../src/calibration/log.ts";
import { parseAutoPatch } from "../src/calibration/patch.ts";
import { MAX_RUNS, readCalibrationInput } from "../src/calibration/runs.ts";
import { LATE_MAX, LATE_OVER_BASELINE, lowestThreshold, MAX_UNDER, MIN_DEVICES, missedLateFrames } from "../src/calibration/search.ts";

export { lowestThreshold, missedLateFrames };

export const KERNELS = ["float", "typed", "alloc", "path"];

/** Defaults of every analysis option; `reference` and `calibration` default to the library's. */
export const DEFAULT_OPTIONS = {
  percentile: 50,
  targetFps: 55,
  maxLate: 0.1,
  maxUnder: 0.05,
  minSamples: 10,
  band: 0.25,
  cal: undefined,
  reference: undefined,
  calibration: undefined,
};

/** Fewest samples the weights fit needs, whatever --min-samples says. */
export const MIN_FIT_SAMPLES = 20;
/** Fewest failures and fewest passes the weights fit needs. */
export const MIN_FIT_CLASS = 3;
const FIT_ITERATIONS = 2000;
const FIT_RATE = 0.5;
const FIT_L2 = 0.01;

const USAGE = `Usage: node calibrate.mjs <export.json|export.csv> [options]
       node calibrate.mjs --lab <lab.json> [options]

In reports, a device failed an effect when the governor stepped it down (still off at report
time) or, without a step-down, when its frames were judged bad: v2 reports compare the fraction
of late frames (late[effect], else late.main) with --max-late, v1 reports compare fps
(fps[effect], else fps.main) with --target-fps.

Options:
  --lab <file>         Export of the lab_runs table (JSON or CSV): per effect, frame cost over the
                       baseline by score bucket and a proposed threshold from late frames (protocol 2
                       runs only, when any exist), from protocol 2 runs the main-thread work per frame
                       on the score 100 device next to the current ms in shared/site-effects.json, and
                       the thresholds the daily auto calibration would apply today. Can be combined
                       with a reports export.
  --current <file>     With --lab: the auto calibration in force. Either the export of the
                       calibration_log table (the patch in force and the 7-day cadence, as the cron reads
                       them) or a patch JSON such as GET /api/calibration (the patch only; cadence
                       unchecked). Default: no auto patch, every effect at its baseline.
  --percentile <p>     Device percentile (0-100) that becomes score 100. Default 50.
  --max-late <f>       Reports, v2 rows: largest fraction of late frames a device may show with an
                       effect on. Default 0.1, the governor's default maxLateFraction.
  --target-fps <fps>   Reports, v1 rows only: frame rate a device must reach with an effect on. Default 55.
  --max-under <f>      Largest tolerated fraction of devices that missed: in reports, the failure rate
                       of any band at or above a threshold (and of any load band at or below the
                       capacity); with --lab, too many late frames at or above a threshold. Default 0.05.
  --band <f>           Reports only: width of a band, scores T <= score < T x (1 + f), loads
                       L / (1 + f) < load <= L. Default 0.25.
  --min-samples <n>    Fewest samples for a band to count in reports; fewest devices at or above a
                       threshold to trust it, and fewest devices behind a proposed effect ms with --lab.
                       Default 10.
  --cal <version>      Calibration version whose scores are the current scale.
                       Default: the most common version in the export.
  --calibration <file> Reports only: a calibration patch (JSON, e.g. a site's own effect registry)
                       applied after the library defaults and calibration.json at the repository root.
                       Effects merge by name, field by field (threshold, cost, weights); invalid values
                       are ignored.
  --reference <list>   Current reference rates, e.g. float=10800,typed=219000,alloc=30900,path=4860.
                       Default: defaultCalibration.reference of the installed framebudget package,
                       overridden by calibration.json, then by the --calibration patch.`;

/** Parses RFC 4180 CSV (quoted fields, doubled quotes, newlines inside quotes). */
export function parseCsv(text) {
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      record.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || record.length) {
    record.push(field);
    records.push(record);
  }
  const [header, ...rows] = records.filter((r) => r.length > 1 || r[0] !== "");
  if (!header) return [];
  return rows.map((r) => Object.fromEntries(header.map((name, i) => [name, r[i] ?? ""])));
}

/** Rows from the export text: wrangler JSON, a JSON array of rows, or CSV. */
export function readRows(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const data = JSON.parse(trimmed);
    const list = Array.isArray(data) ? data : [data];
    return list.flatMap((item) => (item && Array.isArray(item.results) ? item.results : [item]));
  }
  return parseCsv(text);
}

const num = (v) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const json = (v, fallback) => {
  if (typeof v !== "string") return v ?? fallback;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
};

/** Typed view of one stored row (CSV gives strings, JSON gives numbers and strings). */
export function normalize(row) {
  const list = (v) => {
    const parsed = json(v, null);
    return Array.isArray(parsed) ? parsed : null;
  };
  const object = (v) => {
    const parsed = json(v, null);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  };
  return {
    // Exports from before migration 0006 have no `v` column: every row there is v1.
    v: num(row.v) ?? 1,
    cal: String(row.cal ?? ""),
    score: num(row.score),
    warm: num(row.warm),
    kernels: Object.fromEntries(KERNELS.map((k) => [k, num(row["kernel_" + k])])),
    effects: list(row.effects) ?? [],
    used: list(row.used),
    stepped: list(row.stepped) ?? [],
    explored: typeof row.explored === "string" && row.explored !== "" ? row.explored : null,
    fps: object(row.fps) ?? {},
    late: object(row.late),
  };
}

/** Linear interpolation between closest ranks; p in 0..100. */
export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const at = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

export function roundSignificant(value, digits) {
  if (value === 0 || !Number.isFinite(value)) return value;
  const scale = Math.pow(10, digits - Math.ceil(Math.log10(Math.abs(value))));
  return Math.round(value * scale) / scale;
}

/** Score on a given reference: geometric mean of rate / reference over measured kernels, times 100 (as bench.ts). */
export function scoreOf(kernels, reference) {
  const ratios = KERNELS.filter((k) => kernels[k] > 0 && reference[k] > 0).map((k) => kernels[k] / reference[k]);
  if (!ratios.length) return null;
  return Math.exp(ratios.reduce((s, r) => s + Math.log(r), 0) / ratios.length) * 100;
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const nonNegative = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const positive = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Positive finite rates of `rates` copied onto `target`, per kernel. */
function applyRates(target, rates) {
  if (!isObject(rates)) return;
  for (const k of KERNELS) if (positive(rates[k])) target[k] = rates[k];
}

/**
 * Applies a calibration patch onto `current` (mutated and returned): positive reference
 * and cold reference rates, a non-negative capacity, and per effect (merged by name, field
 * by field) a non-negative threshold and cost and positive kernel weights. Invalid values
 * are ignored; a `weights` object with at least one positive weight replaces the previous one.
 */
export function applyPatch(current, patch) {
  if (!isObject(patch)) return current;
  applyRates(current.reference, patch.reference);
  applyRates(current.coldReference, patch.coldReference);
  if (nonNegative(patch.capacity)) current.capacity = patch.capacity;
  if (isObject(patch.effects)) {
    for (const [name, def] of Object.entries(patch.effects)) {
      if (!isObject(def)) continue;
      const effect = (current.effects[name] ??= {});
      if (nonNegative(def.threshold)) effect.threshold = def.threshold;
      if (nonNegative(def.cost)) effect.cost = def.cost;
      if (isObject(def.weights)) {
        const weights = Object.fromEntries(KERNELS.filter((k) => positive(def.weights[k])).map((k) => [k, def.weights[k]]));
        if (Object.keys(weights).length) effect.weights = weights;
      }
    }
  }
  return current;
}

/**
 * @typedef {{ threshold?: number, cost?: number, weights?: Record<string, number> }} EffectCalibration
 * @typedef {{ reference: Record<string, number>, coldReference: Record<string, number>, capacity: number, effects: Record<string, EffectCalibration> }} Calibration
 */

/**
 * The library's defaultCalibration (reference, coldReference, capacity, effects) with each patch applied in order.
 * @param {...unknown} patches
 * @returns {Calibration}
 */
export function currentCalibration(...patches) {
  /** @type {Calibration} */
  const current = { reference: {}, coldReference: {}, capacity: 0, effects: {} };
  applyPatch(current, defaultCalibration);
  for (const patch of patches) applyPatch(current, patch);
  return current;
}

/** `100 * exp(sum(w_k * ln(rate_k / reference_k)) / sum(w_k))` over kernels with a positive weight and rate, as the library. */
export function weightedScore(kernels, reference, weights) {
  let sum = 0;
  let total = 0;
  for (const k of KERNELS) {
    const w = weights[k];
    if (w > 0 && kernels[k] > 0 && reference[k] > 0) {
      sum += w * Math.log(kernels[k] / reference[k]);
      total += w;
    }
  }
  return total > 0 ? 100 * Math.exp(sum / total) : null;
}

const EQUAL_WEIGHTS = Object.fromEntries(KERNELS.map((k) => [k, 1]));

/**
 * Moving the references multiplies every (weighted) score by the weighted geomean of
 * current / proposed over the kernels (exact for devices that measured every kernel).
 */
export function rescaleFactor(reference, proposed, weights = EQUAL_WEIGHTS) {
  let sum = 0;
  let total = 0;
  for (const k of KERNELS) {
    const w = weights[k];
    if (w > 0 && proposed[k] > 0 && reference[k] > 0) {
      sum += w * Math.log(reference[k] / proposed[k]);
      total += w;
    }
  }
  return total > 0 ? Math.exp(sum / total) : null;
}

/**
 * The score an effect is judged on: its weighted score when the current calibration gives it
 * weights, else the stored score. `reference` is the one the row's kernels were measured
 * against (warm rates on the warm reference, cold-only rows on the cold reference).
 */
function effectScore(row, effect, calibration, reference) {
  const weights = calibration.effects[effect]?.weights;
  if (!weights) return row.score;
  return weightedScore(row.kernels, reference, weights) ?? row.score;
}

/**
 * The row's page ran `effect`: allowed or stepped down, and on v2 also used by the page. An
 * empty `used` means the page reported no use, and then (as in the library) every allowed
 * effect counts.
 */
export function ran(row, effect) {
  if (row.v === 2 && row.used?.length && !row.used.includes(effect)) return false;
  return row.effects.includes(effect) || row.stepped.includes(effect);
}

/**
 * Whether the device failed `effect`: stepped down, else bad frames (v2: late fraction of
 * the effect, else main, over `maxLate`; v1: fps of the effect, else main, under `targetFps`).
 * null when there is no verdict.
 */
export function failed(row, effect, options) {
  if (row.stepped.includes(effect)) return true;
  if (row.v === 2) {
    const late = num(row.late?.[effect]) ?? num(row.late?.main);
    return late === null ? null : late > options.maxLate;
  }
  const fps = num(row.fps?.[effect]) ?? num(row.fps?.main);
  return fps === null ? null : fps < options.targetFps;
}

/** First index of ascending `values` holding a value >= x (strict: > x). */
function bound(values, x, strict = false) {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (strict ? values[mid] <= x : values[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Band criterion on `{ score, failed }` samples. Each unique score T is a candidate; its
 * band is the samples with T <= score < T x (1 + band), populated with `minSamples` or more.
 * Returns the lowest T whose band is populated and such that every populated band starting
 * at or above T fails under `maxUnder`, or null.
 */
export function bandThreshold(samples, { band, maxUnder, minSamples }) {
  const sorted = [...samples].sort((a, b) => a.score - b.score);
  const scores = sorted.map((s) => s.score);
  const failures = [0];
  for (const s of sorted) failures.push(failures[failures.length - 1] + (s.failed ? 1 : 0));
  const bands = [];
  for (let i = 0; i < sorted.length; ) {
    const t = scores[i];
    const next = bound(scores, t, true);
    const end = Math.max(next, bound(scores, t * (1 + band)));
    bands.push({ threshold: t, start: i, samples: end - i, failures: failures[end] - failures[i] });
    i = next;
  }
  let chosen = null;
  for (let j = bands.length - 1; j >= 0; j--) {
    const b = bands[j];
    if (b.samples < minSamples) continue;
    if (b.failures / b.samples >= maxUnder) break;
    chosen = b;
  }
  if (!chosen) return null;
  return { threshold: chosen.threshold, band: chosen.samples, failRate: chosen.failures / chosen.samples, devices: sorted.length - chosen.start };
}

/**
 * Load capacity on `{ load, failed }` rows. Each unique load L is a candidate; its band is
 * the rows with L / (1 + band) < load <= L, populated with `minSamples` or more. Returns the
 * highest L whose band is populated and such that every populated band ending at or below
 * L fails under `maxUnder`, or null.
 */
export function capacityFit(rows, { band, maxUnder, minSamples }) {
  const sorted = [...rows].sort((a, b) => a.load - b.load);
  const loads = sorted.map((r) => r.load);
  const failures = [0];
  for (const r of sorted) failures.push(failures[failures.length - 1] + (r.failed ? 1 : 0));
  let chosen = null;
  for (let i = 0; i < sorted.length; ) {
    const l = loads[i];
    const end = bound(loads, l, true);
    const start = Math.min(i, bound(loads, l / (1 + band), true));
    const n = end - start;
    i = end;
    if (n < minSamples) continue;
    const failRate = (failures[end] - failures[start]) / n;
    if (failRate >= maxUnder) break;
    chosen = { capacity: l, band: n, failRate };
  }
  return chosen && { ...chosen, rows: sorted.length };
}

/**
 * L2-regularised logistic regression of failure on x_k = ln(rate_k / reference_k), by plain
 * gradient descent on standardised features (fixed iterations, deterministic). A kernel whose
 * higher rate lowers the failure odds gets weight -beta_k; weights are clamped at 0,
 * normalised to sum 1 and rounded to 2 decimals. Samples are `{ kernels, failed }` with
 * every kernel measured.
 */
export function fitWeights(samples, reference, minSamples) {
  const usable = samples.filter((s) => KERNELS.every((k) => s.kernels[k] > 0 && reference[k] > 0));
  const failures = usable.filter((s) => s.failed).length;
  /** @type {{ samples: number, failures: number, weights: Record<string, number> | null, reason: string | null }} */
  const result = { samples: usable.length, failures, weights: null, reason: null };
  const needed = Math.max(minSamples, MIN_FIT_SAMPLES);
  if (usable.length < needed) return { ...result, reason: `fewer than ${needed} samples` };
  if (failures < MIN_FIT_CLASS || usable.length - failures < MIN_FIT_CLASS) {
    return { ...result, reason: `needs ${MIN_FIT_CLASS} failures and ${MIN_FIT_CLASS} passes` };
  }
  const n = usable.length;
  const x = usable.map((s) => KERNELS.map((k) => Math.log(s.kernels[k] / reference[k])));
  const y = usable.map((s) => (s.failed ? 1 : 0));
  const mean = KERNELS.map((_, k) => x.reduce((sum, row) => sum + row[k], 0) / n);
  // A constant column has no spread; its rounded sd can come out a tiny positive number, so test it exactly.
  const spread = KERNELS.map((_, k) => x.some((row) => row[k] !== x[0][k]));
  const sd = KERNELS.map((_, k) => (spread[k] ? Math.sqrt(x.reduce((sum, row) => sum + (row[k] - mean[k]) ** 2, 0) / n) : 0));
  const z = x.map((row) => row.map((v, k) => (spread[k] ? (v - mean[k]) / sd[k] : 0)));
  let bias = 0;
  const beta = KERNELS.map(() => 0);
  for (let iteration = 0; iteration < FIT_ITERATIONS; iteration++) {
    let gradBias = 0;
    const grad = beta.map(() => 0);
    for (let i = 0; i < n; i++) {
      let logit = bias;
      for (let k = 0; k < beta.length; k++) logit += beta[k] * z[i][k];
      const error = 1 / (1 + Math.exp(-logit)) - y[i];
      gradBias += error;
      for (let k = 0; k < beta.length; k++) grad[k] += error * z[i][k];
    }
    bias -= (FIT_RATE * gradBias) / n;
    for (let k = 0; k < beta.length; k++) beta[k] -= FIT_RATE * (grad[k] / n + FIT_L2 * beta[k]);
  }
  const raw = KERNELS.map((_, k) => (spread[k] ? Math.max(0, -beta[k] / sd[k]) : 0));
  const total = raw.reduce((s, w) => s + w, 0);
  if (!(total > 0)) return { ...result, reason: "no kernel predicts failure" };
  /** @type {Record<string, number>} */
  const weights = {};
  KERNELS.forEach((k, i) => {
    const w = Math.round((raw[i] / total) * 100) / 100;
    if (w > 0) weights[k] = w;
  });
  return { ...result, weights };
}

/** The whole analysis, as data. Options missing from `options` take DEFAULT_OPTIONS. */
export function analyze(rawRows, options) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const calibration = opts.calibration ?? currentCalibration();
  const reference = opts.reference ?? calibration.reference;
  /** The reference a row's kernels were scored against: warm rates on `reference`, cold-only rows on the cold reference. */
  const rowReference = (r) => (r.warm !== null ? reference : calibration.coldReference);
  const rows = rawRows.map(normalize);
  const warmRows = rows.filter((r) => r.warm !== null);
  /** @type {Record<string, number | null>} */
  const proposed = {};
  for (const k of KERNELS) {
    const rates = warmRows.map((r) => r.kernels[k]).filter((v) => v !== null && v > 0);
    const p = percentile(rates, opts.percentile);
    proposed[k] = p === null ? null : roundSignificant(p, 3);
  }
  const factor = rescaleFactor(reference, proposed);

  const calCounts = {};
  for (const r of rows) calCounts[r.cal] = (calCounts[r.cal] ?? 0) + 1;
  const versions = {};
  for (const r of rows) versions[r.v] = (versions[r.v] ?? 0) + 1;
  const cal = opts.cal ?? Object.entries(calCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const scored = rows.filter((r) => r.cal === cal && r.score !== null);

  const effectNames = [...new Set(scored.flatMap((r) => [...r.effects, ...r.stepped]))].filter((e) => typeof e === "string").sort();
  const effects = [];
  const weights = [];
  for (const name of effectNames) {
    const current = calibration.effects[name];
    const samples = scored.flatMap((r) => {
      if (!ran(r, name)) return [];
      const verdict = failed(r, name, opts);
      return verdict === null ? [] : [{ row: r, score: effectScore(r, name, calibration, rowReference(r)), failed: verdict }];
    });
    const found = bandThreshold(samples, opts);
    const effectFactor = current?.weights ? rescaleFactor(reference, proposed, current.weights) : factor;
    effects.push({
      name,
      currentThreshold: current?.threshold ?? null,
      weighted: Boolean(current?.weights),
      samples: samples.length,
      explored: samples.filter((s) => s.row.explored === name).length,
      lowestScore: samples.length ? Math.min(...samples.map((s) => s.score)) : null,
      threshold: found?.threshold ?? null,
      proposedThreshold: found && effectFactor !== null ? Math.round(found.threshold * effectFactor) : null,
      failRate: found?.failRate ?? null,
      devices: found?.devices ?? 0,
    });

    const fitSamples = samples.filter((s) => s.row.warm !== null).map((s) => ({ kernels: s.row.kernels, failed: s.failed }));
    const fit = fitWeights(fitSamples, reference, opts.minSamples);
    let weightedFound = null;
    if (fit.weights) {
      const weightedSamples = fitSamples
        .map((s) => ({ score: weightedScore(s.kernels, reference, fit.weights), failed: s.failed }))
        .filter((s) => s.score !== null);
      weightedFound = bandThreshold(weightedSamples, opts);
    }
    const weightedFactor = fit.weights ? rescaleFactor(reference, proposed, fit.weights) : null;
    weights.push({
      name,
      ...fit,
      threshold: weightedFound?.threshold ?? null,
      proposedThreshold: weightedFound && weightedFactor !== null ? Math.round(weightedFound.threshold * weightedFactor) : null,
      failRate: weightedFound?.failRate ?? null,
    });
  }

  // Capacity: v2 rows with a non-empty `used` only, since only they say which effects the page used.
  // A row that ran an effect without a cost in the current calibration has no load and is skipped.
  let uncosted = 0;
  const loadRows = scored.filter((r) => r.v === 2 && r.used?.length).flatMap((r) => {
    const names = [...new Set([...r.effects, ...r.stepped])].filter((e) => ran(r, e));
    if (names.some((e) => calibration.effects[e]?.cost === undefined)) {
      uncosted++;
      return [];
    }
    let load = 0;
    for (const e of names) {
      load += (calibration.effects[e].cost * 100) / Math.max(effectScore(r, e, calibration, rowReference(r)), 1);
    }
    if (!(load > 0)) return [];
    const stepped = names.some((e) => r.stepped.includes(e));
    const late = ["main", ...names].map((s) => num(r.late?.[s])).filter((v) => v !== null);
    if (!stepped && !late.length) return [];
    return [{ load, failed: stepped || late.some((v) => v > opts.maxLate) }];
  });
  const capacity = capacityFit(loadRows, opts);

  const proposedScores = warmRows.map((r) => scoreOf(r.kernels, proposed)).filter((s) => s !== null);
  return {
    rows: rows.length,
    warmRows: warmRows.length,
    versions,
    calCounts,
    cal,
    scoredRows: scored.length,
    proposed,
    factor,
    atOrAbove100: proposedScores.length ? proposedScores.filter((s) => s >= 100).length / proposedScores.length : null,
    effects,
    weights,
    capacity: {
      current: calibration.capacity,
      rows: loadRows.length,
      uncosted,
      proposed: capacity?.capacity ?? null,
      band: capacity?.band ?? 0,
      failRate: capacity?.failRate ?? null,
    },
  };
}

/** Upper edges of the device score buckets in the lab table; the last bucket is open. */
export const LAB_BUCKETS = [25, 50, 75, 100, 150, 200];
/** Lab steps that measure no effect: the reference for every other step, and its repeat at the end. */
const LAB_BASELINES = ["baseline", "baseline-end"];
/** A share printed as a percentage, for the explanations. */
const percent = (share) => `${+(share * 100).toFixed(2)}%`;
/** LATE_OVER_BASELINE in percentage points. */
const LATE_POINTS = +(LATE_OVER_BASELINE * 100).toFixed(2);

/**
 * Typed view of one lab_runs row. Steps by name; a repeated name keeps the last one.
 * `workMeanMs` is null on protocol 1 steps and on steps without a work sample;
 * `over` (late frames) and `frames` are null when the step does not carry them.
 */
export function normalizeLab(row) {
  const steps = new Map();
  const list = json(row.steps, []);
  for (const step of Array.isArray(list) ? list : []) {
    const medianMs = num(step?.medianMs);
    const p95Ms = num(step?.p95Ms);
    if (typeof step?.name === "string" && medianMs !== null && p95Ms !== null) {
      steps.set(step.name, { medianMs, p95Ms, workMeanMs: num(step.workMeanMs), over: num(step.over), frames: num(step.frames) });
    }
  }
  return {
    cal: String(row.cal ?? ""),
    protocol: num(row.protocol) ?? 1,
    score: num(row.score),
    completed: num(row.completed) === 1,
    steps,
  };
}

/** A step with a positive frame count and a late frame count: a sample of the late-frame rule. */
const lateSample = (step) => step !== undefined && step.frames > 0 && step.over !== null;

/** Late frames and frames of a run's baseline steps pooled, as the cron's SQL pools them. */
function baselineLate(run) {
  let over = 0;
  let frames = 0;
  for (const name of LAB_BASELINES) {
    const step = run.steps.get(name);
    if (lateSample(step)) {
      over += step.over;
      frames += step.frames;
    }
  }
  return { over, frames };
}

/** Rows per calibration version, and the version to analyze: `requested`, else the most common one. */
function pickCal(rows, requested) {
  const calCounts = {};
  for (const r of rows) calCounts[r.cal] = (calCounts[r.cal] ?? 0) + 1;
  return { calCounts, cal: requested ?? Object.entries(calCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null };
}

export function bucketLabel(i) {
  const lo = i === 0 ? 0 : LAB_BUCKETS[i - 1];
  return i === LAB_BUCKETS.length ? `${lo}+` : `${lo}-${LAB_BUCKETS[i]}`;
}

/**
 * The lab analysis, as data. Per effect (every step but the baselines), over the
 * runs of one calibration version that measured a baseline with frames, protocol 2
 * runs only whenever any exist (a device that ran both protocols must not count twice),
 * and the steps with a positive frame count:
 * - cost: the step's median frame time minus the run's baseline median, summarized
 *   per score bucket by its median and p95 across devices;
 * - threshold: the lowest score at which fewer than `maxUnder` of the devices at or
 *   above it missed (missedLateFrames: too many late frames, over the run's own
 *   baseline), with at least `minSamples` of them.
 */
export function analyzeLab(rawRows, options) {
  const all = rawRows.map(normalizeLab);
  const protocol2Only = all.some((r) => r.protocol >= 2);
  const rows = protocol2Only ? all.filter((r) => r.protocol >= 2) : all;
  const { calCounts, cal } = pickCal(rows, options.cal);
  const runs = rows
    .filter((r) => r.cal === cal && r.score !== null && r.steps.has("baseline"))
    .map((r) => ({ ...r, base: baselineLate(r) }))
    .filter((r) => r.base.frames > 0);
  const names = [...new Set(runs.flatMap((r) => [...r.steps.keys()]))].filter((n) => !LAB_BASELINES.includes(n)).sort();
  const effects = names.map((name) => {
    const samples = runs
      .filter((r) => lateSample(r.steps.get(name)))
      .map((r) => {
        const step = r.steps.get(name);
        return {
          score: r.score,
          cost: step.medianMs - r.steps.get("baseline").medianMs,
          missed: missedLateFrames(step.over, step.frames, r.base.over, r.base.frames),
        };
      });
    const buckets = Array.from({ length: LAB_BUCKETS.length + 1 }, (_, i) => {
      const inBucket = samples.filter((s) => (i === 0 || s.score >= LAB_BUCKETS[i - 1]) && (i === LAB_BUCKETS.length || s.score < LAB_BUCKETS[i]));
      const costs = inBucket.map((s) => s.cost);
      return { label: bucketLabel(i), devices: inBucket.length, medianCost: percentile(costs, 50), p95Cost: percentile(costs, 95) };
    });
    const found = lowestThreshold(samples, options.maxUnder, options.minSamples);
    return { name, devices: samples.length, buckets, threshold: found?.threshold ?? null, above: found?.devices ?? 0, under: found?.under ?? null };
  });
  return { rows: all.length, completed: all.filter((r) => r.completed).length, protocol2Only, calCounts, cal, runs: runs.length, effects };
}

/**
 * The protocol 2 lab analysis, as data. Per effect (every step but the baselines),
 * over the protocol 2 runs of one calibration version with a baseline work sample:
 * - cost: the step's mean main-thread work per frame minus the run's baseline mean, floored at 0;
 * - msAt100: that cost on the score 100 device, cost * score / 100, the inverse of `msAt`
 *   in docs/src/effects.ts;
 * - the median and p90 of msAt100 across devices, next to the effect's current `ms`
 *   (`currentMs`, by name, from shared/site-effects.json), and the median as the
 *   proposed `ms` once at least `minSamples` devices measured the effect.
 */
export function analyzeLabWork(rawRows, options, currentMs = {}) {
  const rows = rawRows.map(normalizeLab);
  const { cal } = pickCal(rows, options.cal);
  const protocolCounts = {};
  for (const r of rows) protocolCounts[r.protocol] = (protocolCounts[r.protocol] ?? 0) + 1;
  const runs = rows.filter((r) => r.protocol === 2 && r.cal === cal && r.score !== null && (r.steps.get("baseline")?.workMeanMs ?? null) !== null);
  const names = [...new Set(runs.flatMap((r) => [...r.steps.keys()]))].filter((n) => !LAB_BASELINES.includes(n)).sort();
  const effects = names.map((name) => {
    const msAt100 = runs
      .filter((r) => (r.steps.get(name)?.workMeanMs ?? null) !== null)
      .map((r) => (Math.max(0, r.steps.get(name).workMeanMs - r.steps.get("baseline").workMeanMs) * Math.max(r.score, 1)) / 100);
    const medianMs = percentile(msAt100, 50);
    return {
      name,
      devices: msAt100.length,
      medianMs,
      p90Ms: percentile(msAt100, 90),
      currentMs: currentMs[name] ?? null,
      proposedMs: msAt100.length >= options.minSamples ? medianMs : null,
    };
  });
  return { protocolCounts, cal, runs: runs.length, effects };
}

/** A calibration patch file; a missing calibration.json is an empty patch, a missing --calibration file is an error. */
function readPatch(url, required) {
  let text;
  try {
    text = readFileSync(url, "utf8");
  } catch (error) {
    if (required) throw new Error(`cannot read ${url}: ${error.message}`);
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${url} is not JSON: ${error.message}`);
  }
}

/**
 * The auto calibration in force, from the text of --current: a calibration_log export
 * gives the patch and the cadence exactly as the cron reads them; a patch JSON (or
 * GET /api/calibration) gives the patch only, and the cadence goes unchecked.
 */
export function readCurrent(text) {
  const rows = readRows(text);
  if (rows.some((r) => r && typeof r === "object" && "changes" in r && "applied" in r)) return { state: stateFromLog(rows), cadence: true };
  return { state: { patch: parseAutoPatch(rows[0] ?? null), lastChanged: {} }, cadence: false };
}

/**
 * The export's lab runs in an in-memory SQLite built from the Worker's migrations,
 * behind the part of the D1 API readCalibrationInput uses, so the cron's own SQL
 * picks the runs, applies the exclusions and unnests the steps.
 */
export function labDatabase(rows) {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
  const columns = new Set(db.prepare("SELECT name FROM pragma_table_info('lab_runs')").all().map((c) => c.name));
  rows.forEach((row, i) => {
    const entries = Object.entries({ id: `export-${i}`, ...row }).filter(([name]) => columns.has(name));
    const values = entries.map(([, v]) => (v === null || typeof v === "number" || typeof v === "string" ? v : JSON.stringify(v)));
    db.prepare(`INSERT INTO lab_runs (${entries.map(([name]) => name).join(", ")}) VALUES (${entries.map(() => "?").join(", ")})`).run(...values);
  });
  return { prepare: (sql) => ({ bind: (...params) => ({ all: async () => ({ results: db.prepare(sql).all(...params) }) }) }) };
}

function parseArgs(argv) {
  const options = { ...DEFAULT_OPTIONS, calibrationFile: undefined, current: undefined };
  let file;
  let lab;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    const number = (min, max) => {
      const n = Number(value());
      if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${arg} must be between ${min} and ${max}`);
      return n;
    };
    if (arg === "--percentile") options.percentile = number(0, 100);
    else if (arg === "--target-fps") options.targetFps = number(1, 1000);
    else if (arg === "--max-late") options.maxLate = number(0, 1);
    else if (arg === "--max-under") options.maxUnder = number(0, 1);
    else if (arg === "--band") options.band = number(0.001, 10);
    else if (arg === "--min-samples") options.minSamples = number(1, 1e9);
    else if (arg === "--cal") options.cal = value();
    else if (arg === "--calibration") options.calibrationFile = value();
    else if (arg === "--lab") lab = value();
    else if (arg === "--current") options.current = value();
    else if (arg === "--reference") {
      options.reference = {};
      for (const pair of value().split(",")) {
        const [k, v] = pair.split("=");
        if (!KERNELS.includes(k) || !(Number(v) > 0)) throw new Error(`bad --reference entry ${pair}`);
        options.reference[k] = Number(v);
      }
    } else if (arg === "--help" || arg === "-h") return null;
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else file = arg;
  }
  if (!file && !lab) throw new Error("missing export file");
  if (options.current !== undefined && !lab) throw new Error("--current needs --lab");
  if (options.calibrationFile !== undefined && !file) throw new Error("--calibration needs a reports export");
  return { file, lab, options };
}

const fmt = (v, digits = 0) => (v === null || v === undefined ? "-" : v.toFixed(digits));
const pct = (v) => (v === null || v === undefined ? "-" : (v * 100).toFixed(1) + "%");

function print(result, options) {
  const out = [];
  out.push(`Reports: ${result.rows} (${result.warmRows} with a warm run)`);
  out.push(`Report versions: ${Object.entries(result.versions).map(([k, v]) => `v${k}=${v}`).join(", ") || "-"}`);
  out.push(`Calibration versions: ${Object.entries(result.calCounts).map(([k, v]) => `${k}=${v}`).join(", ") || "-"}`);
  out.push("");
  out.push(`Reference rates (warm rate of the device at percentile ${options.percentile}, which becomes score 100):`);
  out.push("  kernel    current    proposed");
  for (const k of KERNELS) {
    out.push(`  ${k.padEnd(8)}  ${fmt(options.reference[k]).padStart(9)}  ${fmt(result.proposed[k]).padStart(10)}`);
  }
  out.push("");
  out.push(
    result.factor === null
      ? "Rescale factor: - (no kernel has both a current and a proposed rate)"
      : `Rescale factor: ${result.factor.toFixed(3)} (new score = old score x factor)`,
  );
  out.push(`Warm devices at or above 100 on the proposed scale: ${result.atOrAbove100 === null ? "-" : (result.atOrAbove100 * 100).toFixed(0) + "%"}`);
  out.push("");
  out.push(`Effect thresholds (cal ${result.cal}, ${result.scoredRows} reports). A device failed an effect it ran when the governor`);
  out.push(`stepped it down, or its late frames exceeded ${options.maxLate} (v2), or its fps was under ${options.targetFps} (v1). A band is the`);
  out.push(`devices with T <= score < T x ${1 + options.band}, counted from ${options.minSamples} devices; the threshold is the lowest T`);
  out.push(`whose band counts and from which every counted band above fails under ${+(options.maxUnder * 100).toFixed(2)}%.`);
  out.push("Effects marked * have weights in the current calibration and are judged on their weighted score.");
  out.push("  effect                 samples  explored  lowest      now  threshold  proposed  band fail  devices");
  for (const e of result.effects) {
    out.push(
      `  ${(e.name + (e.weighted ? "*" : "")).padEnd(22)} ${String(e.samples).padStart(7)}  ${String(e.explored).padStart(8)}  ${fmt(e.lowestScore).padStart(6)}  ${fmt(e.currentThreshold).padStart(7)}  ${fmt(e.threshold).padStart(9)}  ${fmt(e.proposedThreshold).padStart(8)}  ${pct(e.failRate).padStart(9)}  ${String(e.devices).padStart(7)}`,
    );
  }
  out.push("");
  out.push(`Effect weights (one score per effect): logistic fit of failure on ln(rate / current reference) over samples`);
  out.push(`with a warm run and all four kernels, from max(${options.minSamples}, ${MIN_FIT_SAMPLES}) samples with ${MIN_FIT_CLASS} failures and ${MIN_FIT_CLASS} passes.`);
  out.push("The threshold is the band threshold on the weighted score, on the current and on the proposed reference.");
  out.push("  effect                 samples  failed  weights                                         threshold  proposed  band fail");
  for (const w of result.weights) {
    const shown = w.weights ? Object.entries(w.weights).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(", ") : `- (${w.reason})`;
    out.push(
      `  ${w.name.padEnd(22)} ${String(w.samples).padStart(7)}  ${String(w.failures).padStart(6)}  ${shown.padEnd(46)}  ${fmt(w.threshold).padStart(9)}  ${fmt(w.proposedThreshold).padStart(8)}  ${pct(w.failRate).padStart(9)}`,
    );
  }
  out.push("");
  const c = result.capacity;
  out.push(`Capacity (v2 reports, ${c.rows} with a used, costed effect and a verdict; ${c.uncosted} skipped for an effect without a cost): load = sum(cost x 100 / max(score, 1)) over the`);
  out.push(`effects the page ran; a page failed when one was stepped down or late frames of main or of one exceeded ${options.maxLate}.`);
  out.push(`Load bands are L / ${1 + options.band} < load <= L; the capacity is the highest L from which every counted band below fails under`);
  out.push(`${+(options.maxUnder * 100).toFixed(2)}%.`);
  out.push(`  current ${fmt(c.current, 2)}, proposed ${fmt(c.proposed, 2)} (band of ${c.band}, ${pct(c.failRate)} failing)`);
  out.push("");
  out.push("Notes: only devices that ran an effect say anything about it, so thresholds can only move below the lowest score that");
  out.push("ran an effect through exploration (share.explore turns one effect on a little below its threshold on some page views;");
  out.push("those rows are the explored column). Proposed thresholds scale the stored final score, which includes hardware caps");
  out.push("and pressure multipliers, so they are approximate for capped devices. Apply weights as `weights` on the effect and the");
  out.push("capacity as `capacity` in calibration.json (or in the library defaults).");
  return out.join("\n");
}

function printLab(result, options) {
  const out = [];
  out.push(`Lab runs: ${result.rows} (${result.completed} completed)`);
  out.push(`Calibration versions: ${Object.entries(result.calCounts).map(([k, v]) => `${k}=${v}`).join(", ") || "-"}`);
  out.push(`Runs analyzed (cal ${result.cal}, with baseline frames${result.protocol2Only ? ", protocol 2 or later only" : ""}): ${result.runs}`);
  out.push("");
  out.push("Frame cost over baseline in ms (step median frame time minus the run's baseline median),");
  out.push("median / p95 across devices, devices in parentheses, by device score:");
  const cell = (b) => (b.devices ? `${fmt(b.medianCost, 1)} / ${fmt(b.p95Cost, 1)} (${b.devices})` : "-");
  const labels = Array.from({ length: LAB_BUCKETS.length + 1 }, (_, i) => bucketLabel(i));
  out.push(`  ${"effect".padEnd(22)} ${labels.map((l) => l.padStart(18)).join("")}`);
  for (const e of result.effects) out.push(`  ${e.name.padEnd(22)} ${e.buckets.map((b) => cell(b).padStart(18)).join("")}`);
  out.push("");
  out.push(`Proposed thresholds: lowest score where under ${percent(options.maxUnder)} of the devices at or above it missed, with at least ${options.minSamples} devices.`);
  out.push(`A device missed when more than ${percent(LATE_MAX)} of the step's frames were late (over 1.5 refresh intervals) and that share is`);
  out.push(`at least ${LATE_POINTS} points above the share in the run's baseline and baseline-end steps together. The p95 frame time is not`);
  out.push("used: animation frame gaps jitter on cheap phones and keep it over a 55 fps target with no effect on and no frame dropped.");
  out.push("  effect                 devices  threshold  at/above  missed");
  for (const e of result.effects) {
    const found = e.threshold === null
      ? `not enough devices (${e.devices} ran it, ${options.minSamples} needed at or above a threshold)`
      : `${fmt(e.threshold, 1).padStart(9)}  ${String(e.above).padStart(8)}  ${(e.under * 100).toFixed(1).padStart(4)}%`;
    out.push(`  ${e.name.padEnd(22)} ${String(e.devices).padStart(7)}  ${found}`);
  }
  out.push("");
  out.push("Notes: the score is the lab's framebudget score on the calibration version above. Apply a threshold to");
  out.push("shared/site-effects.json on the same scale, or rescale it by the factor the reports analysis prints.");
  return out.join("\n");
}

function printLabWork(result, options) {
  const out = [];
  out.push(`Lab protocols: ${Object.entries(result.protocolCounts).map(([k, v]) => `${k}=${v}`).join(", ") || "-"}`);
  out.push(`Protocol 2 runs analyzed (cal ${result.cal}, with a baseline work sample): ${result.runs}`);
  out.push("");
  out.push("Main-thread work per frame: the step's mean work per frame minus the run's baseline mean, floored at 0,");
  out.push("scaled to the score 100 device as docs/src/effects.ts models it (ms at 100 = cost x score / 100).");
  out.push(`Median and p90 across devices, the current ms in shared/site-effects.json, and the median as the proposed ms`);
  out.push(`once at least ${options.minSamples} devices measured the effect.`);
  out.push("  effect                 devices  median     p90  current  proposed");
  for (const e of result.effects) {
    const proposed = e.proposedMs === null ? `not enough devices (${e.devices} of ${options.minSamples})` : fmt(e.proposedMs, 2).padStart(8);
    out.push(`  ${e.name.padEnd(22)} ${String(e.devices).padStart(7)}  ${fmt(e.medianMs, 2).padStart(6)}  ${fmt(e.p90Ms, 2).padStart(6)}  ${fmt(e.currentMs, 2).padStart(7)}  ${proposed}`);
  }
  out.push("");
  out.push("Notes: work covers the page's JavaScript, style, layout and paint on the main thread; compositor and GPU");
  out.push("work (backdrop blur, for one) is not in it, so such effects read near 0 here. `all` has no current ms of its own.");
  return out.join("\n");
}

/** What the daily cron would apply today: the same evaluation, guardrails included. */
function printAuto(evaluation, current) {
  const out = [];
  const x = evaluation.exclusions;
  out.push("Automatic calibration: what the daily cron would apply today, with its fixed settings (missed: more than");
  out.push(
    `${percent(LATE_MAX)} of the step's frames late and at least ${LATE_POINTS} points above the run's baseline steps; under ${percent(MAX_UNDER)} of devices missed, at least ${MIN_DEVICES} devices;`,
  );
  out.push("--max-under, --min-samples and --cal do not apply here).");
  out.push(
    `Runs: ${evaluation.runs} counted (the most recent ${MAX_RUNS} at most), ${evaluation.excluded} excluded (refresh rate ${x.refresh}, no baseline ${x.baseline}, busy baseline ${x.busy}, thermal ${x.thermal}), cal ${evaluation.cal ?? "-"}.`,
  );
  out.push(
    current.file === undefined
      ? "Current auto patch: none, every effect at its baseline."
      : `Current auto patch: ${current.file}; cadence ${current.cadence ? "from the log" : "not checked (a patch, not the calibration_log export)"}.`,
  );
  out.push("  effect                 devices  proposed      from        to  limited by");
  for (const c of evaluation.changes) {
    out.push(
      `  ${c.effect.padEnd(22)} ${String(c.devices).padStart(7)}  ${String(c.proposed ?? "-").padStart(8)}  ${String(c.from).padStart(8)}  ${String(c.to).padStart(8)}  ${c.limitedBy ?? "-"}`,
    );
  }
  if (!evaluation.changes.length) out.push("  (no counted run measured an effect of the registry)");
  out.push(`Applied: ${evaluation.applied ? "yes" : "no"}`);
  out.push(`Patch: ${JSON.stringify(evaluation.patch)}`);
  return out.join("\n");
}

async function main() {
  let parsed;
  let calibration;
  try {
    parsed = parseArgs(process.argv.slice(2));
    if (parsed?.file) {
      const patches = [readPatch(new URL("../calibration.json", import.meta.url), false)];
      if (parsed.options.calibrationFile) patches.push(readPatch(pathToFileURL(parsed.options.calibrationFile), true));
      calibration = currentCalibration(...patches);
    }
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (!parsed) {
    console.log(USAGE);
    return;
  }
  const { file, lab, options } = parsed;
  const sections = [];
  if (file) {
    options.calibration = calibration;
    options.reference ??= { ...calibration.reference };
    const missing = KERNELS.filter((k) => !(options.reference[k] > 0));
    if (missing.length) {
      console.error(`No current reference rate for ${missing.join(", ")}; pass --reference.`);
      process.exit(2);
    }
    sections.push(print(analyze(readRows(readFileSync(file, "utf8")), options), options));
  }
  if (lab) {
    const rows = readRows(readFileSync(lab, "utf8"));
    const registry = JSON.parse(readFileSync(new URL("../shared/site-effects.json", import.meta.url), "utf8"));
    const currentMs = Object.fromEntries(Object.entries(registry.effects).map(([name, e]) => [name, e.ms]));
    sections.push(printLab(analyzeLab(rows, options), options));
    sections.push(printLabWork(analyzeLabWork(rows, options, currentMs), options));
    const current = options.current === undefined ? { state: stateFromLog([]), cadence: false } : readCurrent(readFileSync(options.current, "utf8"));
    const now = Date.now();
    const input = await readCalibrationInput(labDatabase(rows), now, Object.keys(registry.effects));
    sections.push(printAuto(evaluate(input, registry, current.state, now), { file: options.current, cadence: current.cadence }));
  }
  console.log(sections.join("\n\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
