/**
 * Strict validation of the lab's two request bodies (POST /api/lab/runs and
 * POST /api/lab/runs/<run>/steps). Anything outside the expected shape is
 * rejected whole, as for reports. Valid values come back normalized: device
 * numbers are rounded to the precision the page promises, so the stored row
 * never holds more detail than documented, and steps are rebuilt with a fixed
 * key order.
 */
import { CAL, hasKeys, isInt, isNum, isObject, isPositive, KERNELS, MAX_CORES, MAX_FPS, MAX_MEMORY_GB, MAX_RATE, MAX_SCORE, MAX_TICK_MS, type KernelName } from "./validate";

export interface LabDevice {
  score: number;
  cold: number | null;
  warm: number | null;
  kernels: Record<KernelName, number | null>;
  tickMs: number | null;
  cores: number | null;
  memoryGb: number | null;
  refreshHz: number;
  dpr: number;
  viewportWidth: number;
  reducedMotion: boolean;
  saveData: boolean;
}

export interface LabRunRequest {
  turnstile: string;
  lib: string;
  cal: string;
  device: LabDevice;
}

export interface LabStep {
  name: string;
  effects: string[];
  frames: number;
  durationMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  over: number;
}

export interface LabStepRequest {
  key: string;
  step: LabStep;
  done: boolean;
}

/** Turnstile tokens are at most 2048 characters. */
export const MAX_TURNSTILE_TOKEN = 2048;
export const MAX_DPR = 16;
export const MAX_VIEWPORT_WIDTH = 100000;
export const MAX_STEP_EFFECTS = 32;
export const MAX_STEP_FRAMES = 10000;
export const MAX_STEP_MS = 10000;

/** Library version: semver-like, printable, short. */
const LIB = /^[0-9A-Za-z.+-]{1,32}$/;
const EFFECT = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
/** Step names that are not effects. `baseline` and `all` also match EFFECT. */
const STEP_NAMES: readonly string[] = ["baseline", "baseline-end", "all"];
/** 32 random bytes, lowercase hex. */
const KEY = /^[0-9a-f]{64}$/;

const RUN_KEYS = ["turnstile", "lib", "cal", "device"];
const DEVICE_KEYS = ["score", "cold", "warm", "kernels", "tickMs", "cores", "memoryGb", "refreshHz", "dpr", "viewportWidth", "reducedMotion", "saveData"];
const STEP_REQUEST_KEYS = ["key", "step", "done"];
const STEP_KEYS = ["name", "effects", "frames", "durationMs", "medianMs", "p95Ms", "maxMs", "over"];

const oneDecimal = (v: number) => Math.round(v * 10) / 10;
const significant = (v: number, digits: number) => Number(v.toPrecision(digits));
const orNull = <T>(v: T | null, f: (v: T) => T) => (v === null ? null : f(v));

function isNullable(v: unknown, check: (v: unknown) => boolean): v is number | null {
  return v === null || check(v);
}

function isEffects(v: unknown): v is string[] {
  if (!Array.isArray(v) || v.length > MAX_STEP_EFFECTS) return false;
  return v.every((name, i) => typeof name === "string" && EFFECT.test(name) && v.indexOf(name) === i);
}

/** Returns the normalized run request when `input` (parsed JSON) is valid, else null. */
export function validateLabRun(input: unknown): LabRunRequest | null {
  if (!isObject(input) || !hasKeys(input, RUN_KEYS, RUN_KEYS)) return null;
  const { turnstile, lib, cal, device: d } = input;
  if (typeof turnstile !== "string" || turnstile.length === 0 || turnstile.length > MAX_TURNSTILE_TOKEN) return null;
  if (typeof lib !== "string" || !LIB.test(lib)) return null;
  if (typeof cal !== "string" || !CAL.test(cal)) return null;
  if (!isObject(d) || !hasKeys(d, DEVICE_KEYS, DEVICE_KEYS)) return null;
  const score = (v: unknown) => isNum(v, 0, MAX_SCORE);
  if (!score(d.score) || !isNullable(d.cold, score) || !isNullable(d.warm, score)) return null;
  const k = d.kernels;
  if (!isObject(k) || !hasKeys(k, KERNELS, KERNELS)) return null;
  if (!KERNELS.every((name) => isNullable(k[name], (v) => isPositive(v, MAX_RATE)))) return null;
  if (!isNullable(d.tickMs, (v) => isNum(v, 0, MAX_TICK_MS))) return null;
  if (!isNullable(d.cores, (v) => isInt(v, 1, MAX_CORES))) return null;
  if (!isNullable(d.memoryGb, (v) => isPositive(v, MAX_MEMORY_GB))) return null;
  if (!isInt(d.refreshHz, 1, MAX_FPS)) return null;
  if (!isPositive(d.dpr, MAX_DPR)) return null;
  if (!isNum(d.viewportWidth, 0, MAX_VIEWPORT_WIDTH)) return null;
  if (typeof d.reducedMotion !== "boolean" || typeof d.saveData !== "boolean") return null;
  return {
    turnstile,
    lib,
    cal,
    device: {
      score: oneDecimal(d.score),
      cold: orNull(d.cold, oneDecimal),
      warm: orNull(d.warm, oneDecimal),
      kernels: Object.fromEntries(KERNELS.map((name) => [name, orNull(k[name] as number | null, (v) => significant(v, 3))])) as LabDevice["kernels"],
      tickMs: orNull(d.tickMs, (v) => significant(v, 2)),
      cores: d.cores,
      memoryGb: d.memoryGb,
      refreshHz: d.refreshHz,
      dpr: oneDecimal(d.dpr),
      viewportWidth: Math.round(d.viewportWidth / 100) * 100,
      reducedMotion: d.reducedMotion,
      saveData: d.saveData,
    },
  };
}

/** Returns the step request, with the step's keys in a fixed order, when `input` (parsed JSON) is valid, else null. */
export function validateLabStep(input: unknown): LabStepRequest | null {
  if (!isObject(input) || !hasKeys(input, STEP_REQUEST_KEYS, STEP_REQUEST_KEYS)) return null;
  const { key, step: s, done } = input;
  if (typeof key !== "string" || !KEY.test(key) || typeof done !== "boolean") return null;
  if (!isObject(s) || !hasKeys(s, STEP_KEYS, STEP_KEYS)) return null;
  if (typeof s.name !== "string" || !(STEP_NAMES.includes(s.name) || EFFECT.test(s.name))) return null;
  if (!isEffects(s.effects)) return null;
  if (!isInt(s.frames, 0, MAX_STEP_FRAMES) || !isInt(s.over, 0, s.frames)) return null;
  const ms = (v: unknown) => isNum(v, 0, MAX_STEP_MS);
  if (!ms(s.durationMs) || !ms(s.medianMs) || !ms(s.p95Ms) || !ms(s.maxMs)) return null;
  return {
    key,
    done,
    step: { name: s.name, effects: s.effects, frames: s.frames, durationMs: s.durationMs, medianMs: s.medianMs, p95Ms: s.p95Ms, maxMs: s.maxMs, over: s.over },
  };
}
