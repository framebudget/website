/**
 * Which lab runs the auto calibration counts, decided in SQL: D1 parses the
 * steps JSON and applies the exclusions, so the Worker, which has 10 ms of CPU
 * per scheduled invocation on the free plan, only receives compact numeric rows.
 * scripts/calibrate.mjs runs the same statements over an export loaded into
 * node:sqlite.
 */
import { utcDay } from "../http.ts";

/** Runs older than this many days are not used (retention deletes them anyway). */
export const WINDOW_DAYS = 400;
/** The most recent counted runs used: plenty for a 5% tail, and it bounds the Worker's CPU and memory. */
export const MAX_RUNS = 1000;
/** Oldest lab protocol counted: protocol 1 runs are ignored. */
export const MIN_PROTOCOL = 2;
/** A baseline p95 frame time above this many refresh intervals means the device was busy before any effect. */
export const BUSY_INTERVALS = 1.5;
/** A baseline-end p95 more than this ratio of the baseline p95 means the device throttled during the run. */
export const THERMAL_RATIO = 1.25;
/** Refresh rates outside this range are measurement errors. */
export const MIN_REFRESH_HZ = 30;
export const MAX_REFRESH_HZ = 360;

const DAY_MS = 86400000;

/** p95 of the last step named `name` with a numeric p95Ms, NULL without one. */
const stepP95 = (name: string) => `(SELECT json_extract(s.value, '$.p95Ms') FROM json_each(e.steps) s
    WHERE json_extract(s.value, '$.name') = '${name}' AND json_type(s.value, '$.p95Ms') IN ('integer', 'real')
    ORDER BY s.key DESC LIMIT 1)`;

/**
 * Completed protocol 2+ runs of the window (bound: the first day kept), of the
 * most common calibration version among them (ties go to the first name in sort
 * order); other versions and protocol 1 runs are ignored. `excluded` names the
 * first exclusion that applies, in this order, NULL for a counted run.
 */
const CLASSIFIED = `WITH eligible AS (
  SELECT rowid AS run, id, cal, created_day, score, refresh_hz, steps FROM lab_runs
  WHERE completed = 1 AND protocol >= ${MIN_PROTOCOL} AND created_day >= ? AND typeof(score) IN ('integer', 'real')
),
chosen AS (SELECT cal FROM eligible GROUP BY cal ORDER BY COUNT(*) DESC, cal LIMIT 1),
measured AS (
  SELECT run, id, created_day, score, refresh_hz, steps, ${stepP95("baseline")} AS baseline, ${stepP95("baseline-end")} AS baseline_end
  FROM eligible e WHERE cal = (SELECT cal FROM chosen)
),
classified AS (
  SELECT run, id, created_day, score, refresh_hz, steps, CASE
    WHEN typeof(refresh_hz) NOT IN ('integer', 'real') OR refresh_hz < ${MIN_REFRESH_HZ} OR refresh_hz > ${MAX_REFRESH_HZ} THEN 'refresh'
    WHEN baseline IS NULL OR baseline_end IS NULL THEN 'baseline'
    WHEN baseline > ${BUSY_INTERVALS} * 1000.0 / refresh_hz THEN 'busy'
    WHEN baseline_end > ${THERMAL_RATIO} * baseline THEN 'thermal'
  END AS excluded
  FROM measured
)`;

/** Runs per outcome (`excluded` NULL: counted), with the version chosen. Bound: the first day kept. */
export const RUN_COUNTS_SQL = `${CLASSIFIED}
SELECT (SELECT cal FROM chosen) AS cal, excluded, COUNT(*) AS runs FROM classified GROUP BY excluded`;

/**
 * One row per step of the MAX_RUNS most recent counted runs whose name is in
 * the JSON array bound last (the registry's effects). Bound: the first day kept,
 * the run limit, the names.
 */
export const RUN_STEPS_SQL = `${CLASSIFIED},
counted AS (SELECT run, score, refresh_hz, steps FROM classified WHERE excluded IS NULL ORDER BY created_day DESC, id DESC LIMIT ?)
SELECT c.run, c.score, c.refresh_hz, json_extract(s.value, '$.name') AS name, json_extract(s.value, '$.p95Ms') AS p95
FROM counted c, json_each(c.steps) s
WHERE json_extract(s.value, '$.name') IN (SELECT value FROM json_each(?)) AND json_type(s.value, '$.p95Ms') IN ('integer', 'real')
ORDER BY c.run, s.key`;

/** One measured effect step of a counted run. */
export interface StepRow {
  /** Row id of the run, only to group its steps. */
  run: number;
  score: number;
  refresh_hz: number;
  name: string;
  p95: number;
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

export interface CalibrationInput {
  /** Most common calibration version among the completed protocol 2 runs of the window; null without any. */
  cal: string | null;
  /** Counted runs used: at most MAX_RUNS. */
  runs: number;
  /** Runs of that version excluded, within the whole window. */
  excluded: number;
  exclusions: Exclusions;
  /** Effect steps of the counted runs used, grouped by run, in step order. */
  steps: StepRow[];
}

/** The runs the evaluation uses, read with RUN_COUNTS_SQL and RUN_STEPS_SQL. `effects`: the registry's effect names. */
export async function readCalibrationInput(db: D1Database, nowMs: number, effects: readonly string[]): Promise<CalibrationInput> {
  const since = utcDay(nowMs - WINDOW_DAYS * DAY_MS);
  const { results: counts } = await db.prepare(RUN_COUNTS_SQL).bind(since).all<{ cal: string | null; excluded: keyof Exclusions | null; runs: number }>();
  const exclusions: Exclusions = { refresh: 0, baseline: 0, busy: 0, thermal: 0 };
  let counted = 0;
  for (const row of counts) {
    if (row.excluded === null) counted = row.runs;
    else exclusions[row.excluded] = row.runs;
  }
  const { results: steps } = counted
    ? await db.prepare(RUN_STEPS_SQL).bind(since, MAX_RUNS, JSON.stringify(effects)).all<StepRow>()
    : { results: [] };
  return {
    cal: counts[0]?.cal ?? null,
    runs: Math.min(counted, MAX_RUNS),
    excluded: exclusions.refresh + exclusions.baseline + exclusions.busy + exclusions.thermal,
    exclusions,
    steps,
  };
}
