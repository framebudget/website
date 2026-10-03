import type { BudgetSnapshot } from "framebudget";
import { CHART_NOTES } from "./copy";
import { APP_COLOR, APP_MS, FRAME_MS, SITE_EFFECTS, msAt } from "./effects";
import { allows, reportFrame } from "./force";
import { heat, load } from "./load";
import { reducedMotion, setTask, watchVisibility } from "./loop";
import { watch } from "./state";
import { setText } from "./ui";

/**
 * The hero chart: one bar per frame of this page, newest on the right, its
 * work stacked from the bottom (the page's own work, then each allowed
 * effect) against the 16.7 ms deadline. The outline behind each bar is the
 * same frame with every effect on. Bars are a model: the effects' frame times
 * on the reference device, scaled by the score, with some jitter.
 *
 * The chart is two framebudget effects. "canvasHiRes" draws at the screen's
 * pixel ratio and scrolls smoothly; "canvasLowRes" draws at 1x and steps.
 * With neither, or with reduced motion, it draws one still frame.
 */
/** The plot spans two frames, so the deadline sits halfway up. */
const MAX_MS = FRAME_MS * 2;

interface Piece {
  color: string;
  ms: number;
}

interface Bar {
  pieces: Piece[];
  total: number;
  ghost: number;
}

type Mode = "hi" | "low" | "still";


export function mountChart(): void {
  const figure = document.querySelector<HTMLElement>("[data-chart]");
  const canvas = figure?.querySelector<HTMLCanvasElement>("[data-chart-canvas]");
  const ctx = canvas?.getContext("2d");
  if (!figure || !canvas || !ctx) return;
  const out = {
    fps: figure.querySelector<HTMLElement>("[data-chart-fps]")!,
    late: figure.querySelector<HTMLElement>("[data-chart-late]")!,
    total: figure.querySelector<HTMLElement>("[data-chart-total]")!,
    note: figure.querySelector<HTMLElement>('[data-live="chart-note"]')!,
  };

  const bars: Bar[] = [];
  let mode: Mode | null = null;
  let onScreen = false;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let since = 0;
  let sinceText = 0;
  let seed = 7;
  let score = 100;
  let effects: string[] = [];
  const gaps: number[] = [];

  // Deterministic jitter, so the still picture is the same on every visit.
  const random = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };

  function sample(): Bar {
    const k = heat();
    const jitter = (): number => 0.84 + random() * 0.32;
    const appMs = msAt(APP_MS, score) * k * jitter() * (random() < 0.05 ? 1.7 : 1);
    const pieces: Piece[] = [{ color: APP_COLOR, ms: appMs }];
    let total = appMs;
    let ghost = appMs;
    for (const fx of SITE_EFFECTS) {
      const ms = msAt(fx.ms, score) * k * jitter();
      ghost += ms;
      if (!effects.includes(fx.name)) continue;
      pieces.push({ color: fx.color, ms });
      total += ms;
    }
    return { pieces, total, ghost };
  }

  const pitch = (): number => (mode === "hi" ? 7 : 9);
  const capacity = (): number => Math.ceil(width / pitch()) + 2;

  function fill(): void {
    bars.length = 0;
    const n = capacity();
    for (let i = 0; i < n; i++) bars.push(sample());
  }

  function size(): void {
    const rect = canvas!.getBoundingClientRect();
    dpr = mode === "hi" ? Math.min(window.devicePixelRatio || 1, 2) : 1;
    width = Math.max(1, Math.round(rect.width));
    height = Math.max(1, Math.round(rect.height));
    canvas!.width = Math.round(width * dpr);
    canvas!.height = Math.round(height * dpr);
  }

  function draw(frac: number): void {
    const c = ctx!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, width, height);
    const p = pitch();
    const barW = p - 3;
    const y = (ms: number): number => height - (Math.min(ms, MAX_MS) / MAX_MS) * height;
    const deadline = y(FRAME_MS);
    c.lineWidth = 1;
    c.strokeStyle = "rgba(154, 163, 188, 0.32)";
    for (let i = bars.length - 1, slot = 0; i >= 0; i--, slot++) {
      const x = width - (slot + 1) * p - frac * p + 2;
      if (x < -p) break;
      const bar = bars[i]!;
      // Every effect on: an outline, clipped at the top of the chart.
      const top = y(bar.ghost);
      c.strokeRect(Math.round(x) + 0.5, Math.round(top) + 0.5, barW - 1, height - Math.round(top));
      let base = height;
      for (const piece of bar.pieces) {
        const h = (piece.ms / MAX_MS) * height;
        c.fillStyle = piece.color;
        c.fillRect(x, base - h, barW, Math.max(1, h - 0.5));
        base -= h;
        if (base < 0) break;
      }
      if (bar.total > FRAME_MS) {
        c.fillStyle = "#ff5a92";
        c.fillRect(x, Math.max(0, base - 5), barW, 2);
      }
    }
    // Past the deadline: time the device does not have.
    c.fillStyle = "rgba(255, 90, 146, 0.045)";
    c.fillRect(0, 0, width, deadline);
  }

  function readouts(): void {
    let late = 0;
    const n = Math.min(bars.length, Math.ceil(width / pitch()));
    for (let i = bars.length - n; i < bars.length; i++) if (bars[i]!.total > FRAME_MS) late += 1;
    setText(out.late, String(late));
    setText(out.total, String(n));
    if (gaps.length >= 10) {
      const sorted = gaps.slice().sort((a, b) => a - b);
      setText(out.fps, String(Math.min(240, Math.round(1000 / sorted[sorted.length >> 1]!))));
    }
  }

  function task(_now: number, dt: number): void {
    gaps.push(dt);
    if (gaps.length > 30) gaps.shift();
    // The chart reports its own frames, so it steps itself down when it stutters.
    // The load test reports separately while it runs.
    if (!load.on) reportFrame(dt, mode === "hi" ? "canvasHiRes" : "canvasLowRes");
    const period = mode === "hi" ? 50 : 120;
    since += dt;
    let added = false;
    while (since >= period) {
      since -= period;
      bars.push(sample());
      added = true;
    }
    if (bars.length > capacity()) bars.splice(0, bars.length - capacity());
    if (mode === "hi") draw(since / period);
    else if (added) draw(0);
    sinceText += dt;
    if (sinceText > 400) {
      sinceText = 0;
      readouts();
    }
  }

  const pickMode = (): Mode =>
    reducedMotion() ? "still" : allows("canvasHiRes") ? "hi" : allows("canvasLowRes") ? "low" : "still";

  function apply(): void {
    const next = pickMode();
    if (next !== mode) {
      mode = next;
      figure!.dataset.mode = mode;
      setText(out.note, CHART_NOTES[mode]);
      size();
      if (!bars.length) fill();
    }
    if (mode === "still") {
      setTask("chart", null);
      seed = 7;
      fill();
      draw(0);
      readouts();
    } else {
      setTask("chart", onScreen ? task : null);
      if (!onScreen) draw(0);
    }
  }

  watch((snap: BudgetSnapshot) => {
    score = snap.score ?? 100;
    effects = snap.effects;
    // A live chart picks up the new device with its next bar; a still one redraws.
    if (mode === null || mode === "still" || pickMode() !== mode) apply();
  });
  watchVisibility(figure, (visible) => {
    onScreen = visible;
    if (mode) apply();
  });
  new ResizeObserver(() => {
    if (!mode) return;
    size();
    if (bars.length < capacity()) fill();
    draw(0);
  }).observe(canvas);
  matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", apply);
}
