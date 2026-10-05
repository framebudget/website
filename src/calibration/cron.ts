/** The daily auto calibration: evaluate the lab runs, write one calibration_log row. */
import registry from "../../shared/site-effects.json";
import type { Env } from "../handler";
import { evaluate, type Evaluation } from "./evaluate.ts";
import { readCalibrationInput } from "./runs.ts";
import { readLogState, writeLog } from "./store.ts";

/** Kill switch: the wrangler var AUTO_CALIBRATION. Anything but "on" turns the evaluation and the served patch off. */
export function autoCalibrationOn(env: Env): boolean {
  return env.AUTO_CALIBRATION === "on";
}

/** One evaluation and its log row, applied or not; nothing at all while the kill switch is off. */
export async function runAutoCalibration(env: Env, nowMs: number): Promise<Evaluation | null> {
  if (!autoCalibrationOn(env)) return null;
  const input = await readCalibrationInput(env.DB, nowMs, Object.keys(registry.effects));
  const evaluation = evaluate(input, registry, await readLogState(env.DB), nowMs);
  await writeLog(env.DB, evaluation, nowMs);
  return evaluation;
}
