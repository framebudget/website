import { budget } from "framebudget";

/**
 * The page's only requestAnimationFrame loop. Effects add a named task while
 * they are allowed and on screen, and remove it otherwise; `schedule` runs a
 * one-shot job in the next frame, which is how DOM updates are batched. The
 * loop stops when nothing is left and while the tab is hidden.
 */
/** `dt` is the real time since the previous frame, in ms. */
export type Task = (now: number, dt: number) => void;

const tasks = new Map<string, Task>();
const jobs = new Set<() => void>();
let raf = 0;
let last = 0;
let ticking = false;
let lastStart = 0;
/** Another source (the load test) reports these frames instead of "main". */
let mainReports = true;

function tick(now: number): void {
  raf = 0;
  ticking = true;
  // dt is the real time since the last callback. rAF timestamps stay on the
  // vsync grid even when a callback runs late, so they would hide stutter.
  const start = performance.now();
  const gap = last ? start - lastStart : 0;
  const dt = gap ? Math.min(gap, 250) : 1000 / 60;
  // framebudget's own frame sampler is off (setup.ts): this loop is the only
  // requestAnimationFrame on the page, so it feeds the governor itself.
  if (gap && mainReports) budget.reportFrame(gap, "main");
  last = now;
  lastStart = start;
  try {
    // Jobs may schedule more jobs (a simulate call schedules a render): drain
    // them in this frame, with a bound so a job that reschedules itself waits.
    for (let round = 0; jobs.size && round < 4; round++) {
      const batch = Array.from(jobs);
      jobs.clear();
      for (const job of batch) job();
    }
    for (const task of tasks.values()) task(now, dt);
  } finally {
    // Exactly one callback per frame: anything started during this tick
    // waits for the request below instead of adding its own.
    ticking = false;
    if ((tasks.size || jobs.size) && !document.hidden) raf = requestAnimationFrame(tick);
    else last = 0;
  }
}

function kick(): void {
  if (!raf && !ticking && (tasks.size || jobs.size) && !document.hidden) raf = requestAnimationFrame(tick);
}

export function setTask(name: string, task: Task | null): void {
  if (task) tasks.set(name, task);
  else tasks.delete(name);
  kick();
}

export function setMainReports(on: boolean): void {
  mainReports = on;
}

/** Runs `job` once in the next frame. The same function scheduled twice runs once. */
export function schedule(job: () => void): void {
  jobs.add(job);
  kick();
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    last = 0;
  } else kick();
});

/** Calls back with true when the element enters the viewport and false when it leaves. */
export function watchVisibility(el: Element, onChange: (visible: boolean) => void, rootMargin = "0px"): void {
  new IntersectionObserver(
    (entries) => {
      for (const entry of entries) onChange(entry.isIntersecting);
    },
    { rootMargin },
  ).observe(el);
}

const reduceQuery = matchMedia("(prefers-reduced-motion: reduce)");
export const reducedMotion = (): boolean => reduceQuery.matches;
