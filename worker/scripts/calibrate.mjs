#!/usr/bin/env node
/**
 * Proposes framebudget calibration numbers from exported reports.
 *
 *   npx wrangler d1 execute framebudget --remote --json --command "SELECT * FROM reports" > export.json
 *   node worker/scripts/calibrate.mjs export.json [--percentile 50] [--target-fps 55] [--max-under 0.05]
 *
 * Plain Node; the only import outside Node is `defaultCalibration` from the
 * installed `framebudget` package (`npm ci --prefix worker`), for the current
 * reference rates. Accepts the wrangler JSON export (an array of
 * `{ results: [...] }`), a plain JSON array of rows, or a CSV export with a header row.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { defaultCalibration } from "framebudget";

export const KERNELS = ["float", "typed", "alloc", "path"];

const USAGE = `Usage: node calibrate.mjs <export.json|export.csv> [options]

Options:
  --percentile <p>     Device percentile (0-100) that becomes score 100. Default 50.
  --target-fps <fps>   Frame rate a device must reach with an effect on. Default 55.
  --max-under <f>      Largest tolerated fraction of devices under the target. Default 0.05.
  --min-samples <n>    Fewest devices at or above a threshold to trust it. Default 10.
  --cal <version>      Calibration version whose scores are the current scale.
                       Default: the most common version in the export.
  --reference <list>   Current reference rates, e.g. float=10800,typed=219000,alloc=30900,path=4860.
                       Default: defaultCalibration.reference of the installed framebudget package,
                       overridden by worker/calibration.json.`;

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
 * Lowest score T such that, among devices with score >= T that ran the effect,
 * fewer than `maxUnder` reported fps under the target. Needs `minSamples` devices.
 */
export function effectThreshold(samples, targetFps, maxUnder, minSamples) {
  const candidates = [...new Set(samples.map((s) => s.score))].sort((a, b) => a - b);
  for (const t of candidates) {
    const above = samples.filter((s) => s.score >= t);
    if (above.length < minSamples) break;
    const under = above.filter((s) => s.fps < targetFps).length / above.length;
    if (under < maxUnder) return { threshold: t, devices: above.length, under };
  }
  return null;
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

function parseArgs(argv) {
  const options = { percentile: 50, targetFps: 55, maxUnder: 0.05, minSamples: 10, cal: undefined, reference: undefined };
  let file;
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
  if (!file) throw new Error("missing export file");
  return { file, options };
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
  const { file, options } = parsed;
  options.reference ??= defaultReference(new URL("../calibration.json", import.meta.url));
  const missing = KERNELS.filter((k) => !(options.reference[k] > 0));
  if (missing.length) {
    console.error(`No current reference rate for ${missing.join(", ")}; pass --reference.`);
    process.exit(2);
  }
  const result = analyze(readRows(readFileSync(file, "utf8")), options);
  console.log(print(result, options));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
