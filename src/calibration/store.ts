/** D1 side of the auto calibration: lab rows in, calibration_log rows in and out (migrations/0004_calibration_log.sql). */
import { parseAutoPatch, type AutoPatch } from "./patch.ts";
import type { Evaluation } from "./evaluate.ts";
import { stateFromLog, type LogState } from "./log.ts";
import { MIN_PROTOCOL, WINDOW_DAYS, type LabRow } from "./runs.ts";
import { utcDay } from "../http.ts";

const DAY_MS = 86400000;

/** Candidate runs; selectRuns applies the same conditions again and the exclusions. */
export const LAB_ROWS_SQL = `SELECT cal, score, refresh_hz, protocol, completed, created_day, steps FROM lab_runs
WHERE completed = 1 AND protocol >= ${MIN_PROTOCOL} AND created_day >= ? ORDER BY created_day, id`;
const APPLIED_ROWS_SQL = "SELECT id, created_at, patch, changes, applied FROM calibration_log WHERE applied = 1 ORDER BY id DESC";
const LATEST_PATCH_SQL = "SELECT patch FROM calibration_log WHERE applied = 1 ORDER BY id DESC LIMIT 1";
const INSERT_LOG_SQL = "INSERT INTO calibration_log (created_at, cal, runs, excluded, patch, changes, applied) VALUES (?, ?, ?, ?, ?, ?, ?)";
/** Retention, except the latest applied row: it holds the patch in force, however old. */
export const CALIBRATION_LOG_RETENTION_SQL = `DELETE FROM calibration_log WHERE created_at < ?
AND id <> COALESCE((SELECT MAX(id) FROM calibration_log WHERE applied = 1), 0)`;

export async function readLabRows(db: D1Database, nowMs: number): Promise<LabRow[]> {
  const { results } = await db.prepare(LAB_ROWS_SQL).bind(utcDay(nowMs - WINDOW_DAYS * DAY_MS)).all<LabRow>();
  return results;
}

export async function readLogState(db: D1Database): Promise<LogState> {
  const { results } = await db.prepare(APPLIED_ROWS_SQL).bind().all<Record<string, unknown>>();
  return stateFromLog(results);
}

/** The patch of the latest applied row, null when there is none or it holds no threshold. */
export async function latestAutoPatch(db: D1Database): Promise<AutoPatch | null> {
  const row = await db.prepare(LATEST_PATCH_SQL).bind().first<{ patch: string }>();
  const patch = row ? parseAutoPatch(row.patch) : null;
  return patch && Object.keys(patch.effects).length ? patch : null;
}

export async function writeLog(db: D1Database, evaluation: Evaluation, nowMs: number): Promise<void> {
  await db
    .prepare(INSERT_LOG_SQL)
    .bind(
      Math.floor(nowMs / 1000),
      evaluation.cal,
      evaluation.runs,
      evaluation.excluded,
      JSON.stringify(evaluation.patch),
      JSON.stringify(evaluation.changes),
      evaluation.applied ? 1 : 0,
    )
    .run();
}
