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

/** The last step named `name` with a numeric p95Ms (its JSON text), NULL without one. */
const lastStep = (name: string) => `(SELECT s.value FROM json_each(e.steps) s
    WHERE json_extract(s.value, '$.name') = '${name}' AND json_type(s.value, '$.p95Ms') IN ('integer', 'real')
    ORDER BY s.key DESC LIMIT 1)`;

/** The step JSON `step` holds a positive frame count and a numeric late frame count: a late-frame sample. */
const sampled = (step: string) =>
  `(json_type(${step}, '$.frames') IN ('integer', 'real') AND json_extract(${step}, '$.frames') > 0 AND json_type(${step}, '$.over') IN ('integer', 'real'))`;
/** `field` (`frames` or `over`) of the step JSON `step` when it is a late-frame sample, else 0. */
const sampledField = (step: string, field: string) => `CASE WHEN ${sampled(step)} THEN json_extract(${step}, '$.${field}') ELSE 0 END`;

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
  SELECT run, id, created_day, score, refresh_hz, steps, ${lastStep("baseline")} AS b, ${lastStep("baseline-end")} AS be
  FROM eligible e WHERE cal = (SELECT cal FROM chosen)
),
pooled AS (
  SELECT run, id, created_day, score, refresh_hz, steps,
    json_extract(b, '$.p95Ms') AS baseline, json_extract(be, '$.p95Ms') AS baseline_end,
    ${sampledField("b", "over")} + ${sampledField("be", "over")} AS base_over,
    ${sampledField("b", "frames")} + ${sampledField("be", "frames")} AS base_frames
  FROM measured
),
classified AS (
  SELECT run, id, created_day, score, refresh_hz, steps, base_over, base_frames, CASE
    WHEN typeof(refresh_hz) NOT IN ('integer', 'real') OR refresh_hz < ${MIN_REFRESH_HZ} OR refresh_hz > ${MAX_REFRESH_HZ} THEN 'refresh'
    WHEN baseline IS NULL OR baseline_end IS NULL OR base_frames = 0 THEN 'baseline'
    WHEN baseline > ${BUSY_INTERVALS} * 1000.0 / refresh_hz THEN 'busy'
    WHEN baseline_end > ${THERMAL_RATIO} * baseline THEN 'thermal'
  END AS excluded
  FROM pooled
)`;

/** Runs per outcome (`excluded` NULL: counted), with the version chosen. Bound: the first day kept. */
export const RUN_COUNTS_SQL = `${CLASSIFIED}
SELECT (SELECT cal FROM chosen) AS cal, excluded, COUNT(*) AS runs FROM classified GROUP BY excluded`;

/**
 * One row per effect step of the MAX_RUNS most recent counted runs whose name is
 * in the JSON array bound last (the registry's effects), with its late frames and
 * frames and the run's pooled baseline ones; steps without a positive frame count
 * are not samples. Bound: the first day kept, the run limit, the names.
 */
export const RUN_STEPS_SQL = `${CLASSIFIED},
counted AS (SELECT run, score, steps, base_over, base_frames FROM classified WHERE excluded IS NULL ORDER BY created_day DESC, id DESC LIMIT ?)
SELECT c.run, c.score, json_extract(s.value, '$.name') AS name, json_extract(s.value, '$.over') AS over,
  json_extract(s.value, '$.frames') AS frames, c.base_over, c.base_frames
FROM counted c, json_each(c.steps) s
WHERE json_extract(s.value, '$.name') IN (SELECT value FROM json_each(?)) AND ${sampled("s.value")}
ORDER BY c.run, s.key`;

/** One measured effect step of a counted run. */
export interface StepRow {
  /** Row id of the run, only to group its steps. */
  run: number;
  score: number;
  name: string;
  /** Frames over 1.5 refresh intervals in the step. */
  over: number;
  /** Frames of the step, positive. */
  frames: number;
  /** Late frames of the run's `baseline` and `baseline-end` steps together. */
  base_over: number;
  /** Frames of those two steps together, positive. */
  base_frames: number;
}

export interface Exclusions {
  /** Refresh rate outside MIN_REFRESH_HZ..MAX_REFRESH_HZ. */
  refresh: number;
  /** No `baseline` or no `baseline-end` step, or no frame in them to compare late frames with. */
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
