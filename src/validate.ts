/**
 * Strict validation of the library's TelemetryReport, v1 (older library
 * versions) or v2 (adds `used`, `explored` and `late`). Key sets are exact per
 * version. Anything outside the expected shape is rejected whole: unknown keys
 * at any level, wrong types, out-of-range numbers, malformed names.
 */

export type KernelName = "float" | "typed" | "alloc" | "path" | "raster";
export type Tier = "Full" | "High" | "Medium" | "Lite";
export type PressureState = "nominal" | "fair" | "serious" | "critical";

export interface ReportV1 {
  v: 1;
  cal: string;
  score: number;
  cold: number | null;
  warm: number | null;
  kernels: Partial<Record<KernelName, number>>;
  tickMs: number | null;
  hints: { cores?: number; memoryGb?: number; pressure?: PressureState; reducedMotion: boolean };
  tier: Tier;
  effects: string[];
  stepped: string[];
  fps: Record<string, number>;
}

export interface ReportV2 extends Omit<ReportV1, "v"> {
  v: 2;
  /** Effects the page used, sorted. */
  used: string[];
  /** The effect this page view turned on below its threshold, or null. */
  explored: string | null;
  /** Per source, fraction of late frames over recent windows, 0..1. */
  late: Record<string, number>;
}

export type Report = ReportV1 | ReportV2;

/** Scores are 100 for the reference device; this leaves room for devices 100 times faster. */
export const MAX_SCORE = 10000;
/** Work units per ms; the fastest default reference is about 2e5. */
export const MAX_RATE = 1e9;
export const MAX_TICK_MS = 1000;
export const MAX_CORES = 1024;
export const MAX_MEMORY_GB = 1024;
export const MAX_NAMES = 64;
export const MAX_FPS_KEYS = 40;
export const MAX_FPS = 1000;

export const KERNELS: readonly KernelName[] = ["float", "typed", "alloc", "path", "raster"];
/**
 * Kernels every library version measures. `raster` (warm run only, newer
 * libraries) is optional wherever a full kernel set is required.
 */
export const BASE_KERNELS: readonly KernelName[] = ["float", "typed", "alloc", "path"];
const TIERS: readonly string[] = ["Full", "High", "Medium", "Lite"];
const PRESSURES: readonly string[] = ["nominal", "fair", "serious", "critical"];
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
/** Printable ASCII, 1 to 64 characters. */
export const CAL = /^[\x20-\x7e]{1,64}$/;

const REPORT_V1_KEYS = ["v", "cal", "score", "cold", "warm", "kernels", "tickMs", "hints", "tier", "effects", "stepped", "fps"];
const REPORT_V2_KEYS = [...REPORT_V1_KEYS, "used", "explored", "late"];
const HINTS_KEYS = ["cores", "memoryGb", "pressure", "reducedMotion"];

type Obj = Record<string, unknown>;

export function isObject(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Every key is allowed and every required key is present. */
export function hasKeys(o: Obj, allowed: readonly string[], required: readonly string[]): boolean {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) return false;
  for (const k of required) if (!Object.prototype.hasOwnProperty.call(o, k)) return false;
  return true;
}

export function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

export function isNum(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
}

export function isPositive(v: unknown, max: number): v is number {
  return isNum(v, 0, max) && v > 0;
}

function isNames(v: unknown): v is string[] {
  if (!Array.isArray(v) || v.length > MAX_NAMES) return false;
  const seen = new Set<string>();
  for (const name of v) {
    if (typeof name !== "string" || !NAME.test(name) || seen.has(name)) return false;
    seen.add(name);
  }
  return true;
}

function isKernels(v: unknown): v is Partial<Record<KernelName, number>> {
  if (!isObject(v) || !hasKeys(v, KERNELS, [])) return false;
  return Object.values(v).every((rate) => isPositive(rate, MAX_RATE));
}

function isHints(v: unknown): v is Report["hints"] {
  if (!isObject(v) || !hasKeys(v, HINTS_KEYS, ["reducedMotion"])) return false;
  if (typeof v.reducedMotion !== "boolean") return false;
  if (v.cores !== undefined && !isInt(v.cores, 1, MAX_CORES)) return false;
  if (v.memoryGb !== undefined && !isPositive(v.memoryGb, MAX_MEMORY_GB)) return false;
  if (v.pressure !== undefined && !(typeof v.pressure === "string" && PRESSURES.includes(v.pressure))) return false;
  return true;
}

/** An object of at most MAX_FPS_KEYS source names, each value accepted by `isValue`. */
function isPerSource(v: unknown, isValue: (value: unknown) => boolean): v is Record<string, number> {
  if (!isObject(v)) return false;
  const keys = Object.keys(v);
  if (keys.length > MAX_FPS_KEYS) return false;
  return keys.every((k) => NAME.test(k) && isValue(v[k]));
}

const isFps = (v: unknown) => isPerSource(v, (fps) => isInt(fps, 0, MAX_FPS));
const isLate = (v: unknown) => isPerSource(v, (fraction) => isNum(fraction, 0, 1));

/** Returns the report when `input` (parsed JSON) is a valid v1 or v2 report, else null. */
export function validateReport(input: unknown): Report | null {
  if (!isObject(input)) return null;
  const r = input;
  if (r.v !== 1 && r.v !== 2) return null;
  const keys = r.v === 1 ? REPORT_V1_KEYS : REPORT_V2_KEYS;
  if (!hasKeys(r, keys, keys)) return null;
  if (typeof r.cal !== "string" || !CAL.test(r.cal)) return null;
  if (!isInt(r.score, 0, MAX_SCORE)) return null;
  if (r.cold !== null && !isInt(r.cold, 0, MAX_SCORE)) return null;
  if (r.warm !== null && !isInt(r.warm, 0, MAX_SCORE)) return null;
  if (!isKernels(r.kernels)) return null;
  if (r.tickMs !== null && !isNum(r.tickMs, 0, MAX_TICK_MS)) return null;
  if (!isHints(r.hints)) return null;
  if (typeof r.tier !== "string" || !TIERS.includes(r.tier)) return null;
  if (!isNames(r.effects) || !isNames(r.stepped)) return null;
  if (!isFps(r.fps)) return null;
  if (r.v === 2) {
    if (!isNames(r.used)) return null;
    if (r.explored !== null && !(typeof r.explored === "string" && NAME.test(r.explored))) return null;
    if (!isLate(r.late)) return null;
  }
  return r as unknown as Report;
}
