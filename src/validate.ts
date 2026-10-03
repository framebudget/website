/**
 * Strict validation of the library's TelemetryReport (v1). Anything outside
 * the expected shape is rejected whole: unknown keys at any level, wrong
 * types, out-of-range numbers, malformed names.
 */

export type KernelName = "float" | "typed" | "alloc" | "path";
export type Tier = "Full" | "High" | "Medium" | "Lite";
export type PressureState = "nominal" | "fair" | "serious" | "critical";

export interface Report {
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

export const KERNELS: readonly KernelName[] = ["float", "typed", "alloc", "path"];
const TIERS: readonly string[] = ["Full", "High", "Medium", "Lite"];
const PRESSURES: readonly string[] = ["nominal", "fair", "serious", "critical"];
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
/** Printable ASCII, 1 to 64 characters. */
const CAL = /^[\x20-\x7e]{1,64}$/;

const REPORT_REQUIRED = ["v", "cal", "score", "cold", "warm", "kernels", "tickMs", "hints", "tier", "effects", "stepped", "fps"];
const HINTS_KEYS = ["cores", "memoryGb", "pressure", "reducedMotion"];

type Obj = Record<string, unknown>;

function isObject(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Every key is allowed and every required key is present. */
function hasKeys(o: Obj, allowed: readonly string[], required: readonly string[]): boolean {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) return false;
  for (const k of required) if (!Object.prototype.hasOwnProperty.call(o, k)) return false;
  return true;
}

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

function isNum(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
}

function isPositive(v: unknown, max: number): v is number {
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

function isFps(v: unknown): v is Record<string, number> {
  if (!isObject(v)) return false;
  const keys = Object.keys(v);
  if (keys.length > MAX_FPS_KEYS) return false;
  return keys.every((k) => NAME.test(k) && isInt(v[k], 0, MAX_FPS));
}

/** Returns the report when `input` (parsed JSON) is a valid v1 report, else null. */
export function validateReport(input: unknown): Report | null {
  if (!isObject(input) || !hasKeys(input, REPORT_REQUIRED, REPORT_REQUIRED)) return null;
  const r = input;
  if (r.v !== 1) return null;
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
  return r as unknown as Report;
}
