#!/usr/bin/env node
/**
 * Proposes framebudget calibration numbers from exported reports, and effect
 * thresholds from exported lab runs.
 *
 *   npx wrangler d1 execute framebudget --remote --json --command "SELECT * FROM reports" > export.json
 *   node scripts/calibrate.mjs export.json [--percentile 50] [--target-fps 55] [--max-under 0.05]
 *
 *   npx wrangler d1 execute framebudget --remote --json --command "SELECT * FROM lab_runs" > lab.json
 *   node scripts/calibrate.mjs --lab lab.json [--target-fps 55] [--max-under 0.05] [--min-samples 10]
 *
 * Plain Node; the only import outside Node is `defaultCalibration` from the
 * installed `framebudget` package (`npm ci` at the repository root), for the current
 * reference rates. Accepts the wrangler JSON export (an array of
 * `{ results: [...] }`), a plain JSON array of rows, or a CSV export with a header row.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { defaultCalibration } from "framebudget";

export const KERNELS = ["float", "typed", "alloc", "path"];

const USAGE = `Usage: node calibrate.mjs <export.json|export.csv> [options]
       node calibrate.mjs --lab <lab.json> [options]

Options:
  --lab <file>         Export of the lab_runs table (JSON or CSV): per effect, frame cost over the
                       baseline by score bucket and a proposed threshold, and, from protocol 2 runs, the
                       main-thread work per frame on the score 100 device next to the current ms in
                       docs/src/effects.ts. Can be combined with a reports export.
  --percentile <p>     Device percentile (0-100) that becomes score 100. Default 50.
  --target-fps <fps>   Frame rate a device must reach with an effect on. Default 55. With --lab, the
                       p95 frame time must stay within 1000/fps ms at 60 Hz, scaled by the refresh rate.
  --max-under <f>      Largest tolerated fraction of devices under the target. Default 0.05.
  --min-samples <n>    Fewest devices at or above a threshold to trust it, and fewest devices behind a
                       proposed effect ms with --lab. Default 10.
  --cal <version>      Calibration version whose scores are the current scale.
                       Default: the most common version in the export.
  --reference <list>   Current reference rates, e.g. float=10800,typed=219000,alloc=30900,path=4860.
                       Default: defaultCalibration.reference of the installed framebudget package,
                       overridden by calibration.json at the repository root.`;

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
  return {
    cal: String(row.cal ?? ""),
    score: num(row.score),
    warm: num(row.warm),
    kernels: Object.fromEntries(KERNELS.map((k) => [k, num(row["kernel_" + k])])),
    effects: json(row.effects, []),
    fps: json(row.fps, {}),
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

/**
 * Lowest score T such that, among devices with score >= T, fewer than `maxUnder`
 * missed the target (`missed: true`). Needs `minSamples` devices at or above T.
 */
export function lowestThreshold(samples, maxUnder, minSamples) {
  const candidates = [...new Set(samples.map((s) => s.score))].sort((a, b) => a - b);
  for (const t of candidates) {
    const above = samples.filter((s) => s.score >= t);
    if (above.length < minSamples) break;
    const under = above.filter((s) => s.missed).length / above.length;
    if (under < maxUnder) return { threshold: t, devices: above.length, under };
  }
  return null;
}

/**
 * Lowest score T such that, among devices with score >= T that ran the effect,
 * fewer than `maxUnder` reported fps under the target. Needs `minSamples` devices.
 */
export function effectThreshold(samples, targetFps, maxUnder, minSamples) {
  return lowestThreshold(
    samples.map((s) => ({ score: s.score, missed: s.fps < targetFps })),
    maxUnder,
    minSamples,
  );
}

/** The whole analysis, as data. */
export function analyze(rawRows, options) {
  const rows = rawRows.map(normalize);
  const warmRows = rows.filter((r) => r.warm !== null);
  /** @type {Record<string, number | null>} */
  const proposed = {};
  for (const k of KERNELS) {
    const rates = warmRows.map((r) => r.kernels[k]).filter((v) => v !== null && v > 0);
    const p = percentile(rates, options.percentile);
    proposed[k] = p === null ? null : roundSignificant(p, 3);
  }
  // Every score is 100 * geomean(rate / ref), so moving the references multiplies all scores
  // by geomean(ref / proposed) over the kernels (exact for devices that measured every kernel).
  const both = KERNELS.filter((k) => proposed[k] > 0 && options.reference[k] > 0);
  const factor = both.length
    ? Math.exp(both.reduce((s, k) => s + Math.log(options.reference[k] / proposed[k]), 0) / both.length)
    : null;

  const calCounts = {};
  for (const r of rows) calCounts[r.cal] = (calCounts[r.cal] ?? 0) + 1;
  const cal = options.cal ?? Object.entries(calCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const scored = rows.filter((r) => r.cal === cal && r.score !== null);

  const effectNames = [...new Set(scored.flatMap((r) => (Array.isArray(r.effects) ? r.effects : [])))].sort();
  const effects = effectNames.map((name) => {
    const samples = scored
      .filter((r) => r.effects.includes(name))
      .map((r) => ({ score: r.score, fps: num(r.fps?.[name]) ?? num(r.fps?.main) }))
      .filter((s) => s.fps !== null);
    const found = effectThreshold(samples, options.targetFps, options.maxUnder, options.minSamples);
    return {
      name,
      samples: samples.length,
      lowestScore: samples.length ? Math.min(...samples.map((s) => s.score)) : null,
      threshold: found?.threshold ?? null,
      proposedThreshold: found && factor !== null ? Math.round(found.threshold * factor) : null,
      devices: found?.devices ?? 0,
      under: found?.under ?? null,
    };
  });

  const proposedScores = warmRows.map((r) => scoreOf(r.kernels, proposed)).filter((s) => s !== null);
  return {
    rows: rows.length,
    warmRows: warmRows.length,
    calCounts,
    cal,
    scoredRows: scored.length,
    proposed,
    factor,
    atOrAbove100: proposedScores.length ? proposedScores.filter((s) => s >= 100).length / proposedScores.length : null,
    effects,
  };
}

/** Upper edges of the device score buckets in the lab table; the last bucket is open. */
export const LAB_BUCKETS = [25, 50, 75, 100, 150, 200];
/** Lab steps that measure no effect: the reference for every other step, and its repeat at the end. */
const LAB_BASELINES = ["baseline", "baseline-end"];

/**
 * Typed view of one lab_runs row. Steps by name; a repeated name keeps the last one.
 * `workMeanMs` is null on protocol 1 steps and on steps without a work sample.
 */
export function normalizeLab(row) {
  const steps = new Map();
  const list = json(row.steps, []);
  for (const step of Array.isArray(list) ? list : []) {
    const medianMs = num(step?.medianMs);
    const p95Ms = num(step?.p95Ms);
    if (typeof step?.name === "string" && medianMs !== null && p95Ms !== null) steps.set(step.name, { medianMs, p95Ms, workMeanMs: num(step.workMeanMs) });
  }
  return {
    cal: String(row.cal ?? ""),
    protocol: num(row.protocol) ?? 1,
    score: num(row.score),
    refreshHz: num(row.refresh_hz),
    completed: num(row.completed) === 1,
    steps,
  };
}

/** Rows per calibration version, and the version to analyze: `requested`, else the most common one. */
function pickCal(rows, requested) {
  const calCounts = {};
  for (const r of rows) calCounts[r.cal] = (calCounts[r.cal] ?? 0) + 1;
  return { calCounts, cal: requested ?? Object.entries(calCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null };
}

/** p95 frame time a device at `refreshHz` must stay within: 1000 / targetFps ms at 60 Hz, scaled by the refresh rate. */
export function labTargetMs(targetFps, refreshHz) {
  return (1000 / targetFps) * (60 / refreshHz);
}

export function bucketLabel(i) {
  const lo = i === 0 ? 0 : LAB_BUCKETS[i - 1];
  return i === LAB_BUCKETS.length ? `${lo}+` : `${lo}-${LAB_BUCKETS[i]}`;
}

/**
 * The lab analysis, as data. Per effect (every step but the baselines), over the
 * runs of one calibration version that measured a baseline:
 * - cost: the step's median frame time minus the run's baseline median, summarized
 *   per score bucket by its median and p95 across devices;
 * - threshold: the lowest score at which fewer than `maxUnder` of the devices at or
 *   above it had a p95 frame time over labTargetMs, with at least `minSamples` of them.
 */
export function analyzeLab(rawRows, options) {
  const rows = rawRows.map(normalizeLab);
  const { calCounts, cal } = pickCal(rows, options.cal);
  const runs = rows.filter((r) => r.cal === cal && r.score !== null && r.refreshHz > 0 && r.steps.has("baseline"));
  const names = [...new Set(runs.flatMap((r) => [...r.steps.keys()]))].filter((n) => !LAB_BASELINES.includes(n)).sort();
  const effects = names.map((name) => {
    const samples = runs
      .filter((r) => r.steps.has(name))
      .map((r) => {
        const step = r.steps.get(name);
        return { score: r.score, cost: step.medianMs - r.steps.get("baseline").medianMs, missed: step.p95Ms > labTargetMs(options.targetFps, r.refreshHz) };
      });
    const buckets = Array.from({ length: LAB_BUCKETS.length + 1 }, (_, i) => {
      const inBucket = samples.filter((s) => (i === 0 || s.score >= LAB_BUCKETS[i - 1]) && (i === LAB_BUCKETS.length || s.score < LAB_BUCKETS[i]));
      const costs = inBucket.map((s) => s.cost);
      return { label: bucketLabel(i), devices: inBucket.length, medianCost: percentile(costs, 50), p95Cost: percentile(costs, 95) };
    });
    const found = lowestThreshold(samples, options.maxUnder, options.minSamples);
    return { name, devices: samples.length, buckets, threshold: found?.threshold ?? null, above: found?.devices ?? 0, under: found?.under ?? null };
  });
  return { rows: rows.length, completed: rows.filter((r) => r.completed).length, calCounts, cal, runs: runs.length, effects };
}

/** `ms` of every effect in docs/src/effects.ts (its frame time on the score 100 device), by name. */
export function parseEffectMs(source) {
  const ms = {};
  for (const m of source.matchAll(/\{\s*name:\s*"([A-Za-z][A-Za-z0-9]*)"[^\n]*?\bms:\s*([0-9]+(?:\.[0-9]+)?)\b/g)) ms[m[1]] = Number(m[2]);
  return ms;
}

/**
 * The protocol 2 lab analysis, as data. Per effect (every step but the baselines),
 * over the protocol 2 runs of one calibration version with a baseline work sample:
 * - cost: the step's mean main-thread work per frame minus the run's baseline mean, floored at 0;
 * - msAt100: that cost on the score 100 device, cost * score / 100, the inverse of `msAt`
 *   in docs/src/effects.ts;
 * - the median and p90 of msAt100 across devices, next to the effect's current `ms`
 *   (`currentMs`, by name), and the median as the proposed `ms` once at least
 *   `minSamples` devices measured the effect.
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

/** Library default reference rates, overridden by the worker's calibration patch when it has any. */
function defaultReference(patchUrl) {
  const reference = {};
  for (const k of KERNELS) if (defaultCalibration.reference[k] > 0) reference[k] = defaultCalibration.reference[k];
  try {
    const patch = JSON.parse(readFileSync(patchUrl, "utf8"));
    for (const k of KERNELS) if (patch?.reference?.[k] > 0) reference[k] = patch.reference[k];
  } catch {
    // No patch.
  }
  return reference;
}

/** Current effect ms from the site's sources; none when the file is missing (the script run outside the repository). */
function currentEffectMs(effectsUrl) {
  try {
    return parseEffectMs(readFileSync(effectsUrl, "utf8"));
  } catch {
    return {};
  }
}

function parseArgs(argv) {
  const options = { percentile: 50, targetFps: 55, maxUnder: 0.05, minSamples: 10, cal: undefined, reference: undefined };
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
    else if (arg === "--max-under") options.maxUnder = number(0, 1);
    else if (arg === "--min-samples") options.minSamples = number(1, 1e9);
    else if (arg === "--cal") options.cal = value();
    else if (arg === "--lab") lab = value();
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
  return { file, lab, options };
}

const fmt = (v, digits = 0) => (v === null || v === undefined ? "-" : v.toFixed(digits));

function print(result, options) {
  const out = [];
  out.push(`Reports: ${result.rows} (${result.warmRows} with a warm run)`);
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
  out.push(
    `Effect thresholds (cal ${result.cal}, ${result.scoredRows} reports): lowest score where under ${+(options.maxUnder * 100).toFixed(2)}% of devices at or above it`,
  );
  out.push(`ran the effect under ${options.targetFps} fps (fps of the effect, else main), with at least ${options.minSamples} devices.`);
  out.push("  effect                 samples  lowest  current  proposed  devices  under");
  for (const e of result.effects) {
    out.push(
      `  ${e.name.padEnd(22)} ${String(e.samples).padStart(7)}  ${fmt(e.lowestScore).padStart(6)}  ${fmt(e.threshold).padStart(7)}  ${fmt(e.proposedThreshold).padStart(8)}  ${String(e.devices).padStart(7)}  ${e.under === null ? "    -" : (e.under * 100).toFixed(1).padStart(4) + "%"}`,
    );
  }
  out.push("");
  out.push("Notes: only devices that ran an effect report its fps, so no threshold can go below the lowest score");
  out.push("that ran it. Proposed thresholds scale the stored final score, which includes hardware caps and");
  out.push("pressure multipliers, so they are approximate for capped devices.");
  return out.join("\n");
}

function printLab(result, options) {
  const out = [];
  out.push(`Lab runs: ${result.rows} (${result.completed} completed)`);
  out.push(`Calibration versions: ${Object.entries(result.calCounts).map(([k, v]) => `${k}=${v}`).join(", ") || "-"}`);
  out.push(`Runs analyzed (cal ${result.cal}, with a baseline step): ${result.runs}`);
  out.push("");
  out.push("Frame cost over baseline in ms (step median frame time minus the run's baseline median),");
  out.push("median / p95 across devices, devices in parentheses, by device score:");
  const cell = (b) => (b.devices ? `${fmt(b.medianCost, 1)} / ${fmt(b.p95Cost, 1)} (${b.devices})` : "-");
  const labels = Array.from({ length: LAB_BUCKETS.length + 1 }, (_, i) => bucketLabel(i));
  out.push(`  ${"effect".padEnd(22)} ${labels.map((l) => l.padStart(18)).join("")}`);
  for (const e of result.effects) out.push(`  ${e.name.padEnd(22)} ${e.buckets.map((b) => cell(b).padStart(18)).join("")}`);
  out.push("");
  out.push(
    `Proposed thresholds: lowest score where under ${+(options.maxUnder * 100).toFixed(2)}% of the devices at or above it had a p95 frame time`,
  );
  out.push(
    `over ${labTargetMs(options.targetFps, 60).toFixed(2)} ms at 60 Hz (${options.targetFps} fps, scaled by refresh rate: ${labTargetMs(options.targetFps, 120).toFixed(2)} ms at 120 Hz), with at least ${options.minSamples} devices.`,
  );
  out.push("  effect                 devices  threshold  at/above  over");
  for (const e of result.effects) {
    const found = e.threshold === null
      ? `not enough devices (${e.devices} ran it, ${options.minSamples} needed at or above a threshold)`
      : `${fmt(e.threshold, 1).padStart(9)}  ${String(e.above).padStart(8)}  ${(e.under * 100).toFixed(1).padStart(4)}%`;
    out.push(`  ${e.name.padEnd(22)} ${String(e.devices).padStart(7)}  ${found}`);
  }
  out.push("");
  out.push("Notes: the score is the lab's framebudget score on the calibration version above. Apply a threshold to");
  out.push("docs/src/effects.ts on the same scale, or rescale it by the factor the reports analysis prints.");
  return out.join("\n");
}

function printLabWork(result, options) {
  const out = [];
  out.push(`Lab protocols: ${Object.entries(result.protocolCounts).map(([k, v]) => `${k}=${v}`).join(", ") || "-"}`);
  out.push(`Protocol 2 runs analyzed (cal ${result.cal}, with a baseline work sample): ${result.runs}`);
  out.push("");
  out.push("Main-thread work per frame: the step's mean work per frame minus the run's baseline mean, floored at 0,");
  out.push("scaled to the score 100 device as docs/src/effects.ts models it (ms at 100 = cost x score / 100).");
  out.push(`Median and p90 across devices, the current ms in docs/src/effects.ts, and the median as the proposed ms`);
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

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
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
    options.reference ??= defaultReference(new URL("../calibration.json", import.meta.url));
    const missing = KERNELS.filter((k) => !(options.reference[k] > 0));
    if (missing.length) {
      console.error(`No current reference rate for ${missing.join(", ")}; pass --reference.`);
      process.exit(2);
    }
    sections.push(print(analyze(readRows(readFileSync(file, "utf8")), options), options));
  }
  if (lab) {
    const rows = readRows(readFileSync(lab, "utf8"));
    sections.push(printLab(analyzeLab(rows, options), options));
    sections.push(printLabWork(analyzeLabWork(rows, options, currentEffectMs(new URL("../docs/src/effects.ts", import.meta.url))), options));
  }
  console.log(sections.join("\n\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
