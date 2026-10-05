/**
 * What the calibration_log says about the present: the auto patch in force and
 * when each effect last changed. Shared with scripts/calibrate.mjs, which reads
 * the same rows from an export.
 */
import { parseAutoPatch, type AutoPatch } from "./patch.ts";

/** A calibration_log row as D1 returns it or an export holds it. */
export interface LogRow {
  id?: unknown;
  created_at?: unknown;
  patch?: unknown;
  changes?: unknown;
  applied?: unknown;
}

export interface LogState {
  /** The full auto patch of the latest applied row; empty without one. */
  patch: AutoPatch;
  /** Epoch seconds of the latest applied change of each effect. */
  lastChanged: Record<string, number>;
}

/** One entry of `changes`: every effect evaluated, applied or not. */
export interface Change {
  effect: string;
  from: number;
  to: number;
  proposed: number | null;
  /** Counted runs that measured the effect. */
  devices: number;
  limitedBy: string | null;
}

export function stateFromLog(rows: readonly LogRow[]): LogState {
  const applied = rows
    .filter((r) => Number(r.applied) === 1)
    .sort((a, b) => Number(b.id ?? b.created_at) - Number(a.id ?? a.created_at));
  if (!applied.length) return { patch: { effects: {} }, lastChanged: {} };
  const lastChanged: Record<string, number> = {};
  for (const row of applied) {
    const createdAt = Number(row.created_at);
    let changes: unknown = row.changes;
    try {
      if (typeof changes === "string") changes = JSON.parse(changes);
    } catch {
      changes = [];
    }
    if (!Array.isArray(changes) || !Number.isFinite(createdAt)) continue;
    for (const c of changes as Partial<Change>[]) {
      if (typeof c?.effect === "string" && c.to !== c.from) lastChanged[c.effect] = Math.max(lastChanged[c.effect] ?? 0, createdAt);
    }
  }
  return { patch: parseAutoPatch(applied[0]!.patch), lastChanged };
}
