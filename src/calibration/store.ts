/** D1 side of the auto calibration log (migrations/0004_calibration_log.sql); the lab runs are read by runs.ts. */
import { parseAutoPatch, type AutoPatch } from "./patch.ts";
import type { Evaluation } from "./evaluate.ts";
import { stateFromLog, type LogState } from "./log.ts";

const APPLIED_ROWS_SQL = "SELECT id, created_at, patch, changes, applied FROM calibration_log WHERE applied = 1 ORDER BY id DESC";
const LATEST_PATCH_SQL = "SELECT patch FROM calibration_log WHERE applied = 1 ORDER BY id DESC LIMIT 1";
const INSERT_LOG_SQL = "INSERT INTO calibration_log (created_at, cal, runs, excluded, patch, changes, applied) VALUES (?, ?, ?, ?, ?, ?, ?)";
/** Retention, except the latest applied row: it holds the patch in force, however old. */
export const CALIBRATION_LOG_RETENTION_SQL = `DELETE FROM calibration_log WHERE created_at < ?
AND id <> COALESCE((SELECT MAX(id) FROM calibration_log WHERE applied = 1), 0)`;

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
