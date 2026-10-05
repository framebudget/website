/** Synthetic lab_runs rows for the auto calibration tests (plain TypeScript, also runnable by Node's type stripping). */
import type { DatabaseSync } from "node:sqlite";

export interface RunSpec {
  score: number;
  hz?: number;
  protocol?: number;
  cal?: string;
  completed?: number;
  day?: string;
  /** p95 of the `baseline` step; null leaves the step out. Default 17.5 ms. */
  baseline?: number | null;
  /** p95 of the `baseline-end` step; null leaves the step out. Default 17.5 ms. */
  end?: number | null;
  /** p95 of each effect step, by name. */
  effects?: Record<string, number>;
}

export type LabRowValues = Record<string, string | number | null>;

function step(name: string, effects: string[], p95Ms: number) {
  return { name, effects, frames: 300, durationMs: 5004, medianMs: Math.min(p95Ms, 16.7), p95Ms, maxMs: p95Ms * 2, over: 0, workMeanMs: 4, workMedianMs: 3.8, workP95Ms: 6, workFrames: 298 };
}

/** A full lab_runs row, every NOT NULL column filled. */
export function labRow(spec: RunSpec, index: number): LabRowValues {
  const steps = [];
  if (spec.baseline !== null) steps.push(step("baseline", [], spec.baseline ?? 17.5));
  for (const [name, p95] of Object.entries(spec.effects ?? {})) steps.push(step(name, [name], p95));
  if (spec.end !== null) steps.push(step("baseline-end", [], spec.end ?? 17.5));
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    created_day: spec.day ?? "2026-10-04",
    lib: "0.2.1",
    cal: spec.cal ?? "provisional-1",
    score: spec.score,
    refresh_hz: spec.hz ?? 60,
    dpr: 2,
    viewport_width: 400,
    reduced_motion: 0,
    save_data: 0,
    engine: "blink",
    engine_version: 131,
    os: "android",
    mobile: 1,
    country: "BR",
    steps: JSON.stringify(steps),
    step_count: steps.length,
    completed: spec.completed ?? 1,
    protocol: spec.protocol ?? 2,
  };
}

export function insertLabRows(db: DatabaseSync, rows: readonly LabRowValues[]): void {
  for (const row of rows) {
    const columns = Object.keys(row);
    db.prepare(`INSERT INTO lab_runs (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...Object.values(row));
  }
}

/** Device scores of the fixture: 24 devices from 10 to 240. */
export const FIXTURE_SCORES = [10, 14, 18, 22, 26, 30, 34, 38, 42, 46, 50, 55, 60, 70, 80, 90, 100, 115, 130, 150, 170, 190, 210, 240];

/** Effects of the fixture and the score under which a device misses the target with each one on (p95 22 ms at 60 Hz). */
export const FIXTURE_FAILS_BELOW: Record<string, number> = {
  counters: 0,
  entrances: 0,
  canvasLowRes: 34,
  shimmer: 42,
  textReveal: 46,
  parallax: 46,
  blur: 70,
  canvasHiRes: 60,
};

/**
 * A lab like the real one on `day`: 24 counted protocol 2 devices, each failing the
 * effects of FIXTURE_FAILS_BELOW under its score, plus one run for every exclusion
 * and every ignored kind (busy, thermal, no baseline-end, 20 Hz, protocol 1,
 * another version, not completed).
 */
export function fixtureRows(day: string): LabRowValues[] {
  const effects = (score: number) => Object.fromEntries(Object.entries(FIXTURE_FAILS_BELOW).map(([name, below]) => [name, score < below ? 22 : 17.5]));
  const specs: RunSpec[] = FIXTURE_SCORES.map((score) => ({ score, day, effects: effects(score) }));
  specs.push(
    { score: 120, day, baseline: 26, effects: effects(0) },
    { score: 125, day, end: 23, effects: effects(0) },
    { score: 130, day, end: null, effects: effects(0) },
    { score: 135, day, hz: 20, effects: effects(0) },
    { score: 140, day, protocol: 1, effects: effects(1000) },
    { score: 145, day, cal: "provisional-0", effects: effects(1000) },
    { score: 150, day, completed: 0, effects: effects(1000) },
  );
  return specs.map(labRow);
}
