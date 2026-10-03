import { budget, type BenchResult, type BudgetSnapshot, type KernelName } from "framebudget";
import { reducedMotion } from "../loop";

/** The device half of a run, rounded as the lab contract says. */
export interface DeviceReport {
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

const KERNELS: readonly KernelName[] = ["float", "typed", "alloc", "path"];

export const round1 = (value: number): number => Math.round(value * 10) / 10;

function significant(value: number, digits: number): number {
  if (value === 0 || !Number.isFinite(value)) return value;
  const scale = 10 ** (digits - Math.ceil(Math.log10(Math.abs(value))));
  return Math.round(value * scale) / scale;
}

const score = (bench: BenchResult | null): number | null => (bench ? round1(bench.score) : null);

/**
 * Waits for framebudget's warm benchmark, which runs in a few tasks after the
 * load event. Gives up after `limitMs` and answers with what there is: the
 * cold score still describes the device.
 */
export function waitForWarm(limitMs = 15000): Promise<BudgetSnapshot> {
  const started = performance.now();
  return new Promise((resolve) => {
    const check = (): void => {
      const snap = budget.snapshot();
      if (snap.warm || performance.now() - started > limitMs) resolve(snap);
      else window.setTimeout(check, 200);
    };
    check();
  });
}

export function deviceReport(snap: BudgetSnapshot, refreshHz: number): DeviceReport {
  const bench = snap.warm ?? snap.cold;
  const rate = (k: KernelName): number | null => {
    const value = bench?.rates[k];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? significant(value, 3) : null;
  };
  const cores = snap.hints?.cores;
  const memoryGb = snap.hints?.memoryGb;
  return {
    score: round1(snap.score ?? 0),
    cold: score(snap.cold),
    warm: score(snap.warm),
    kernels: Object.fromEntries(KERNELS.map((k) => [k, rate(k)])) as Record<KernelName, number | null>,
    tickMs: bench && Number.isFinite(bench.tickMs) ? significant(bench.tickMs, 2) : null,
    cores: typeof cores === "number" ? Math.round(cores) : null,
    memoryGb: typeof memoryGb === "number" ? memoryGb : null,
    refreshHz,
    dpr: Math.max(0.1, round1(window.devicePixelRatio || 1)),
    viewportWidth: Math.round(window.innerWidth / 100) * 100,
    reducedMotion: reducedMotion(),
    saveData: snap.hints?.saveData ?? false,
  };
}
