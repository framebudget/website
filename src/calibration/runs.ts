/**
 * Which lab runs the auto calibration counts. Shared with scripts/calibrate.mjs,
 * which passes exported rows; the worker passes the rows of LAB_ROWS_SQL.
 */
import { utcDay } from "../http.ts";

/** Runs older than this many days are not used (retention deletes them anyway). */
export const WINDOW_DAYS = 400;
/** Oldest lab protocol counted: protocol 1 runs are ignored. */
export const MIN_PROTOCOL = 2;
/** A baseline p95 frame time above this many refresh intervals means the device was busy before any effect. */
export const BUSY_INTERVALS = 1.5;
/** A baseline-end p95 more than this ratio of the baseline p95 means the device throttled during the run. */
export const THERMAL_RATIO = 1.25;
/** Refresh rates outside this range are measurement errors. */
export const MIN_REFRESH_HZ = 30;
export const MAX_REFRESH_HZ = 360;

/** A lab_runs row as D1 returns it or an export holds it (CSV gives strings). */
export interface LabRow {
  cal?: unknown;
  score?: unknown;
  refresh_hz?: unknown;
  protocol?: unknown;
  completed?: unknown;
  created_day?: unknown;
  steps?: unknown;
}

/** A run that passed every exclusion: its score, refresh rate and the p95 frame time of each step by name. */
export interface CountedRun {
  score: number;
  refreshHz: number;
  p95: ReadonlyMap<string, number>;
}

export interface Exclusions {
  /** Refresh rate outside MIN_REFRESH_HZ..MAX_REFRESH_HZ. */
  refresh: number;
  /** No `baseline` or no `baseline-end` step. */
  baseline: number;
  /** Baseline p95 above BUSY_INTERVALS refresh intervals. */
  busy: number;
  /** `baseline-end` p95 above THERMAL_RATIO times the baseline p95. */
  thermal: number;
}

export interface Selection {
  /** Most common calibration version among the completed protocol 2 runs of the window; null without any. */
  cal: string | null;
  runs: CountedRun[];
  excluded: number;
  exclusions: Exclusions;
}

const DAY_MS = 86400000;

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** p95 frame time of each step by name; a repeated name keeps the last one. */
function stepP95(steps: unknown): Map<string, number> {
  let list = steps;
  if (typeof steps === "string") {
    try {
      list = JSON.parse(steps);
    } catch {
      list = [];
    }
  }
  const p95 = new Map<string, number>();
  if (!Array.isArray(list)) return p95;
  for (const step of list as { name?: unknown; p95Ms?: unknown }[]) {
    const ms = num(step?.p95Ms);
    if (typeof step?.name === "string" && ms !== null) p95.set(step.name, ms);
  }
  return p95;
}

/**
 * Completed protocol 2+ runs of the last WINDOW_DAYS days, from the most common
 * calibration version among them (ties go to the first name in sort order);
 * other versions and protocol 1 runs are ignored, not excluded. Each of those
 * runs is then excluded for, in this order: a refresh rate outside 30..360 Hz,
 * a missing `baseline` or `baseline-end` step, a busy baseline, or thermal
 * throttling. The rest are counted.
 */
export function selectRuns(rows: readonly LabRow[], nowMs: number): Selection {
  const since = utcDay(nowMs - WINDOW_DAYS * DAY_MS);
  const eligible = rows.filter(
    (r) =>
      num(r.completed) === 1 &&
      (num(r.protocol) ?? 1) >= MIN_PROTOCOL &&
      num(r.score) !== null &&
      !(typeof r.created_day === "string" && r.created_day < since),
  );
  const counts = new Map<string, number>();
  for (const r of eligible) {
    const key = String(r.cal ?? "");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const cal = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? null;

  const exclusions: Exclusions = { refresh: 0, baseline: 0, busy: 0, thermal: 0 };
  const runs: CountedRun[] = [];
  for (const row of eligible) {
    if (String(row.cal ?? "") !== cal) continue;
    const refreshHz = num(row.refresh_hz);
    if (refreshHz === null || refreshHz < MIN_REFRESH_HZ || refreshHz > MAX_REFRESH_HZ) {
      exclusions.refresh++;
      continue;
    }
    const p95 = stepP95(row.steps);
    const baseline = p95.get("baseline");
    const end = p95.get("baseline-end");
    if (baseline === undefined || end === undefined) exclusions.baseline++;
    else if (baseline > BUSY_INTERVALS * (1000 / refreshHz)) exclusions.busy++;
    else if (end > THERMAL_RATIO * baseline) exclusions.thermal++;
    else runs.push({ score: num(row.score)!, refreshHz, p95 });
  }
  const excluded = exclusions.refresh + exclusions.baseline + exclusions.busy + exclusions.thermal;
  return { cal, runs, excluded, exclusions };
}
