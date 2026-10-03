import { budget, type BudgetSnapshot, type ChangeReason, type KernelName } from "framebudget";
import { compareNote, htmlAttrs, LEARNED, listNames as joinNames, WARM_NOTE } from "./copy";
import { count } from "./counter";
import { BY_NAME, DEVICES, FRAME_MS, LADDER_MAX, SITE_EFFECTS, deviceName, frameMs } from "./effects";
import { heat, load, onLoad, setLoad, setLoadVisible } from "./load";
import { setTask, watchVisibility } from "./loop";
import { mountLog, mountMeter } from "./meter";
import { cue } from "./sound";
import { simulateSoon, watch } from "./state";
import { all, pop, setText, swapText } from "./ui";

const UNDO_MS = 5000;
const started = performance.now();

const label = (name: string): string => BY_NAME[name]?.label ?? name;

const listNames = (names: readonly string[]): string => joinNames(names.map(label));

/** What the decision column says about one effect. */
function decision(name: string, snap: BudgetSnapshot): string {
  const fx = BY_NAME[name]!;
  if (snap.effects.includes(name)) return (snap.score ?? 0) < fx.threshold ? "On, held by hysteresis" : "On";
  switch (snap.off[name]) {
    case "threshold":
      return `Off, needs ${Math.ceil(fx.threshold * (1 + snap.calibration.hysteresis))}`;
    case "motion":
      return "Off, reduced motion";
    case "data":
      return "Off, Save-Data";
    case "learned":
      return "Off, stuttered before";
    case "governor":
      return "Off, stepped down";
    default:
      return "Off";
  }
}

/* Device pickers (hero and simulator) --------------------------------------------- */

function mountPickers(): void {
  const pickers = all("[data-picker]");
  for (const picker of pickers) {
    for (const button of all<HTMLButtonElement>("button", picker)) {
      button.addEventListener("click", () => {
        const score = button.dataset.score ? Number(button.dataset.score) : null;
        if (score === budget.snapshot().simulated) return;
        // Direct, not coalesced: the decision lands in the very next frame.
        budget.simulate(score);
      });
    }
  }
  watch((snap) => {
    const index = DEVICES.findIndex((d) => d.score === snap.simulated);
    for (const picker of pickers) {
      picker.style.setProperty("--i", String(Math.max(0, index)));
      picker.querySelector<HTMLElement>(".segmented__thumb")!.style.opacity = index < 0 ? "0" : "";
      all<HTMLButtonElement>("button", picker).forEach((b, i) => b.setAttribute("aria-pressed", String(i === index)));
    }
  });
}

/** The real device's score, remembered while a simulated one is active. */
let realScore: number | null = null;
function measured(snap: BudgetSnapshot): number | null {
  if (snap.simulated === null && snap.rawScore !== null) realScore = snap.rawScore;
  // Opened while simulating: the benchmarks still ran on the real device.
  return realScore ?? (snap.warm ?? snap.cold)?.score ?? null;
}

/* Simulator ------------------------------------------------------------------------ */

function mountSimulator(log: (html: string) => void): void {
  const root = document.getElementById("simulator");
  if (!root) return;
  const slider = root.querySelector<HTMLInputElement>("#score")!;
  const sliderValue = root.querySelector<HTMLElement>("[data-slider-value]")!;
  const out = {
    score: root.querySelector<HTMLElement>("[data-sim-score]")!,
    tier: root.querySelector<HTMLElement>("[data-sim-tier]")!,
    count: root.querySelector<HTMLElement>("[data-sim-count]")!,
    fps: root.querySelector<HTMLElement>("[data-sim-fps]")!,
    device: root.querySelector<HTMLElement>("[data-sim-device]")!,
  };
  const meter = mountMeter(root.querySelector<HTMLElement>('[data-meter="sim"]')!);
  const rows = all<HTMLTableRowElement>("tbody tr[data-fx]", root);
  const switches = {
    load: root.querySelector<HTMLButtonElement>('[data-switch="load"]')!,
    heat: root.querySelector<HTMLButtonElement>('[data-switch="heat"]')!,
  };

  slider.addEventListener("input", () => {
    setText(sliderValue, slider.value);
    simulateSoon(Number(slider.value));
  });

  // Switches flip their own state first, so the thumb moves in the frame after the click.
  switches.load.addEventListener("click", () => {
    const on = !load.on;
    setLoad(on, on && load.hot);
    const ms = Math.min(24, frameMs(budget.score ?? 100, budget.effects(), heat()));
    log(on ? `<b>Load test on</b>: burning ${ms.toFixed(1)} ms of every frame on this thread.` : "<b>Load test off</b>.");
  });
  switches.heat.addEventListener("click", () => {
    const hot = !load.hot;
    setLoad(load.on || hot, hot);
    log(hot ? "<b>Heat on</b>: every effect costs 3x, like a phone that throttles when it warms up." : "<b>Heat off</b>.");
  });
  onLoad(() => {
    switches.load.setAttribute("aria-checked", String(load.on));
    switches.heat.setAttribute("aria-checked", String(load.hot));
    render(budget.snapshot());
  });

  /* Frame rate, measured while the simulator is on screen. */
  const gaps: number[] = [];
  let sinceText = 0;
  const fpsTask = (_now: number, dt: number): void => {
    gaps.push(dt);
    if (gaps.length > 30) gaps.shift();
    sinceText += dt;
    if (sinceText < 400 || gaps.length < 10) return;
    sinceText = 0;
    const sorted = gaps.slice().sort((a, b) => a - b);
    setText(out.fps, String(Math.min(240, Math.round(1000 / sorted[sorted.length >> 1]!))));
  };
  watchVisibility(root, (visible) => {
    gaps.length = 0;
    setTask("simFps", visible ? fpsTask : null);
    setLoadVisible(visible);
  });

  /* Back to my device, then undo in the same place. */
  const reset = root.querySelector<HTMLElement>("[data-reset]")!;
  const resetMsg = root.querySelector<HTMLElement>("[data-reset-msg]")!;
  const timer = root.querySelector<HTMLElement>(".reset__timer")!;
  let undoScore: number | null = null;
  let undoTimer = 0;
  root.querySelector<HTMLButtonElement>("[data-reset-back]")!.addEventListener("click", () => {
    undoScore = budget.snapshot().simulated;
    budget.simulate(null);
    reset.dataset.state = "undo";
    setText(resetMsg, `Back on your device from ${deviceName(undoScore)}.`);
    window.clearTimeout(undoTimer);
    undoTimer = window.setTimeout(() => {
      undoScore = null;
      reset.dataset.state = budget.snapshot().simulated === null ? "real" : "back";
    }, UNDO_MS);
    // The timer drains on the compositor; without motion it simply is not shown.
    timer.getAnimations().forEach((a) => a.cancel());
    timer.animate([{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }], { duration: UNDO_MS, easing: "linear" });
    root.querySelector<HTMLButtonElement>("[data-reset-undo]")!.focus();
  });
  root.querySelector<HTMLButtonElement>("[data-reset-undo]")!.addEventListener("click", () => {
    window.clearTimeout(undoTimer);
    if (undoScore !== null) budget.simulate(undoScore);
    undoScore = null;
    reset.dataset.state = "back";
    root.querySelector<HTMLButtonElement>("[data-reset-back]")!.focus();
  });

  let previous: string[] | null = null;
  function render(snap: BudgetSnapshot): void {
    const score = snap.score ?? 100;
    if (document.activeElement !== slider) {
      slider.value = String(Math.round(Math.min(300, Math.max(5, snap.rawScore ?? score))));
      setText(sliderValue, slider.value);
    }
    count(out.score, Math.round(score));
    if (out.tier.dataset.tier !== snap.tier) {
      out.tier.dataset.tier = snap.tier;
      swapText(out.tier, snap.tier);
    }
    count(out.count, snap.effects.length);
    setText(out.device, snap.simulated === null ? "my device" : deviceName(snap.simulated));
    meter(score, snap.effects, heat());
    for (const row of rows) {
      const name = row.dataset.fx!;
      const on = snap.effects.includes(name);
      const pill = row.querySelector<HTMLElement>("[data-decision]")!;
      const text = decision(name, snap);
      row.classList.toggle("is-off", !on);
      pill.dataset.on = String(on);
      pill.dataset.reason = snap.off[name] ?? "";
      if (pill.textContent !== text) {
        pill.textContent = text;
        if (previous && previous.includes(name) !== on) pop(pill);
      }
    }
    previous = snap.effects;
    if (reset.dataset.state !== "undo") reset.dataset.state = snap.simulated === null ? "real" : "back";
  }
  watch((snap) => render(snap));
}

/* Change log: one entry per change, in the simulator and in "how it works". ------- */

function describe(snap: BudgetSnapshot, before: BudgetSnapshot, reason: ChangeReason): string | null {
  const offs = before.effects.filter((e) => !snap.effects.includes(e));
  const ons = snap.effects.filter((e) => !before.effects.includes(e));
  const changes = [offs.length ? `off: ${listNames(offs)}` : "", ons.length ? `on: ${listNames(ons)}` : ""].filter(Boolean).join("; ");
  const tail = changes ? ` ${changes.charAt(0).toUpperCase()}${changes.slice(1)}.` : " No effect changed.";
  switch (reason) {
    case "simulate":
      return snap.simulated === null
        ? `<b>Your device</b>, score ${Math.round(snap.score ?? 0)}.${tail}`
        : `<b>${deviceName(snap.simulated)}</b>, score ${Math.round(snap.simulated)}.${tail}`;
    case "governor":
      return `<b>Governor</b>: three windows under 45 fps.${tail}`;
    case "warm":
      return `<b>Warm benchmark</b>: score ${Math.round(snap.warm?.score ?? snap.score ?? 0)}.${tail}`;
    case "motion":
      return `<b>Reduced motion</b> changed.${tail}`;
    case "pressure":
      return `<b>CPU pressure</b>: ${snap.pressure ?? "nominal"}.${tail}`;
    case "force":
      return `<b>Tier forced</b> to ${snap.forced ?? "auto"}.${tail}`;
    default:
      return null;
  }
}

function mountChangeLog(): (html: string) => void {
  const logs = all("[data-log]").map(mountLog);
  const log = (html: string): void => {
    const time = `<time>${((performance.now() - started) / 1000).toFixed(1)} s</time>`;
    for (const write of logs) write(time + html);
  };
  let before: BudgetSnapshot | null = null;
  watch((snap, reasons) => {
    if (!before) {
      log(`<b>Page loaded</b> on ${snap.simulated === null ? "your device" : deviceName(snap.simulated)}: ${snap.effects.length} of ${SITE_EFFECTS.length} effects on.`);
    } else {
      for (const reason of new Set(reasons)) {
        const line = describe(snap, before, reason);
        if (line) log(line);
        if (reason === "governor") cue("warning");
      }
    }
    before = snap;
  });
  return log;
}

/* The problem: every effect against framebudget's choice ------------------------------ */

function mountCompare(): void {
  const root = document.querySelector<HTMLElement>(".compare");
  if (!root) return;
  const all15 = SITE_EFFECTS.map((e) => e.name);
  const meterAll = mountMeter(root.querySelector<HTMLElement>('[data-meter="all"]')!);
  const meterFb = mountMeter(root.querySelector<HTMLElement>('[data-meter="fb"]')!);
  const device = root.querySelector<HTMLElement>("[data-compare-device]")!;
  const score = root.querySelector<HTMLElement>("[data-compare-score]")!;
  const note = root.querySelector<HTMLElement>('[data-live="compare-note"]')!;
  watch((snap) => {
    const s = snap.score ?? 100;
    setText(device, snap.simulated === null ? "this device" : deviceName(snap.simulated));
    count(score, Math.round(s));
    const allMs = meterAll(s, all15);
    const fbMs = meterFb(s, snap.effects);
    setText(note, compareNote(allMs, fbMs, snap.effects.length));
  });
}

/* How it works: live attributes, kernels, ladder, learning --------------------------- */

const KERNELS: KernelName[] = ["float", "typed", "alloc", "path"];

/** The live attributes on <html>, on both pages. */
function mountAttrs(): void {
  const blocks = all('[data-live="html-attrs"]');
  watch(() => {
    const html = document.documentElement;
    const text = htmlAttrs(html.getAttribute("data-framebudget") ?? "", html.getAttribute("data-framebudget-effects") ?? "");
    for (const block of blocks) setText(block, text);
  });
}

function mountHow(): void {
  const warmScore = document.querySelector<HTMLElement>("[data-warm-score]");
  if (!warmScore) return;
  const warmNote = document.querySelector<HTMLElement>('[data-live="warm-note"]')!;
  const ladderRows = all("[data-fx].ladder__row");
  const marker = document.querySelector<HTMLElement>("[data-ladder-marker]")!;
  const markerScore = document.querySelector<HTMLElement>("[data-ladder-score]")!;
  const ladderDevice = document.querySelector<HTMLElement>('[data-live="ladder-device"]')!;
  const learned = document.querySelector<HTMLElement>('[data-live="learned"]')!;
  const tierCols = all("[data-tier-col]");

  watch((snap) => {
    const warm = snap.warm;
    if (warm) {
      for (const k of KERNELS) {
        const rate = warm.rates[k] ?? 0;
        setText(document.querySelector(`[data-kernel-rate="${k}"]`)!, Math.round(rate).toLocaleString("en"));
        setText(document.querySelector(`[data-kernel-ratio="${k}"]`)!, `${Math.round((rate / snap.calibration.reference[k]) * 100)}`);
      }
      count(warmScore, Math.round(warm.score));
      setText(warmNote, snap.simulated === null ? WARM_NOTE.real : WARM_NOTE.simulated);
    }

    const score = snap.score ?? 100;
    for (const row of ladderRows) row.classList.toggle("is-on", snap.effects.includes(row.dataset.fx!));
    const s = Math.min(1, score / LADDER_MAX);
    marker.style.setProperty("--s", s.toFixed(4));
    marker.classList.toggle("is-far", s > 0.72);
    count(markerScore, Math.round(score));
    setText(ladderDevice, snap.simulated === null ? "this device" : deviceName(snap.simulated));

    setText(
      learned,
      snap.simulated !== null ? LEARNED.simulated : snap.learned.length ? LEARNED.some(listNames(snap.learned)) : LEARNED.none,
    );

    for (const col of tierCols) col.classList.toggle("is-current", col.dataset.tierCol === snap.tier);
  });
}

/** Fills the real device's score into the "My device" picker buttons. */
function mountRealScore(): void {
  const cells = all("[data-picker-real]");
  watch((snap) => {
    const real = measured(snap);
    for (const cell of cells) setText(cell, real === null ? "..." : String(Math.round(real)));
  });
}

export function mountHome(): void {
  mountPickers();
  mountRealScore();
  const log = mountChangeLog();
  mountSimulator(log);
  mountCompare();
  mountHow();
  mountAttrs();
}
