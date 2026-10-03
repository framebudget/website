import type { CalibrationPatch, EffectDefinition } from "framebudget";

/**
 * Every effect on this site, registered with framebudget. `threshold`, `cost`
 * and the flags go to the library. `ms` is the frame time the effect spends on
 * the reference device (score 100); the frame chart, the meters and the load
 * test use it to model this page's frames on any score.
 */
export interface SiteEffect extends EffectDefinition {
  name: string;
  label: string;
  ms: number;
  color: string;
  what: string;
}

export const SITE_EFFECTS: readonly SiteEffect[] = [
  { name: "hover", label: "Hover states", threshold: 20, cost: 1, ms: 0.2, color: "#b8c0d0", what: "Links, rows and controls answer the pointer." },
  { name: "counters", label: "Counting numbers", threshold: 25, cost: 1, ms: 0.25, color: "#8db4ff", motion: true, what: "Scores, frame times and counts roll to their new value on a spring." },
  { name: "canvasLowRes", label: "Frame chart, 1x", threshold: 30, cost: 3, ms: 0.6, color: "#2fb67c", motion: true, what: "The hero's live frame chart, at one pixel per CSS pixel, stepping." },
  { name: "entrances", label: "Staggered reveals", threshold: 35, cost: 2, ms: 0.4, color: "#5fd6a2", motion: true, what: "Sections arrive in a short stagger as they scroll into view." },
  { name: "morph", label: "Morphing controls", threshold: 40, cost: 2, ms: 0.4, color: "#c4b1ff", motion: true, what: "Selectors slide, buttons confirm in place, readouts swap their text." },
  { name: "shimmer", label: "Deadline glow", threshold: 45, cost: 2, ms: 0.5, color: "#ff8fb6", motion: true, what: "The 16.7 ms line breathes and the install command catches a sheen." },
  { name: "sound", label: "Interface sounds", threshold: 50, cost: 1, ms: 0.3, color: "#1fa6ca", data: true, what: "Synthesized taps, toggles and outcomes, from cuelume. No audio files." },
  { name: "textReveal", label: "Text reveals", threshold: 52, cost: 2, ms: 0.5, color: "#f7cd63", motion: true, what: "Headlines arrive by blur, by word, by line or by wipe." },
  { name: "pageTransition", label: "Page transitions", threshold: 55, cost: 3, ms: 0.8, color: "#9474f2", motion: true, what: "A cross-document view transition between this page and the API reference." },
  { name: "springs", label: "Spring presses", threshold: 60, cost: 3, ms: 0.7, color: "#e0a8ff", motion: true, what: "Buttons give under the press and spring back." },
  { name: "magnetic", label: "Magnetic buttons", threshold: 65, cost: 2, ms: 0.6, color: "#f5c35b", motion: true, what: "The main buttons lean toward the pointer." },
  { name: "parallax", label: "Parallax", threshold: 70, cost: 5, ms: 1.2, color: "#f2b21b", motion: true, what: "The hero's headline and grid drift at different speeds as you scroll." },
  { name: "spotlight", label: "Cursor spotlight", threshold: 80, cost: 4, ms: 1, color: "#ffd98a", motion: true, what: "A soft light follows the pointer across the panels." },
  { name: "blur", label: "Backdrop blur", threshold: 90, cost: 6, ms: 1.5, color: "#6482f5", what: "Frosted glass behind the header and the device dock." },
  { name: "canvasHiRes", label: "Frame chart, full res", threshold: 120, cost: 8, ms: 2.6, color: "#86e3b9", motion: true, data: true, what: "The frame chart at the screen's pixel ratio, scrolling smoothly." },
];

export const BY_NAME: Readonly<Record<string, SiteEffect>> = Object.fromEntries(SITE_EFFECTS.map((e) => [e.name, e]));

/** The page's own work per frame on the reference device, effects aside. */
export const APP_MS = 2;
export const APP_COLOR = "#7d86a6";

/** One frame at 60 Hz. */
export const FRAME_MS = 16.7;

/** Shared by the inline boot script and `configure()`, so both make the same first decision. */
export const calibration: CalibrationPatch = {
  effects: Object.fromEntries(
    SITE_EFFECTS.map(({ name, threshold, cost, motion, data }) => [name, { threshold, cost, motion: !!motion, data: !!data }]),
  ),
};

/** Frame time of `ms` (measured at score 100) on a device with this score. */
export const msAt = (ms: number, score: number): number => (ms * 100) / Math.max(score, 1);

/** Modeled work of one frame: the page, then each effect in `effects`. */
export function frameMs(score: number, effects: readonly string[], heat = 1): number {
  let total = APP_MS;
  for (const fx of SITE_EFFECTS) if (effects.includes(fx.name)) total += fx.ms;
  return msAt(total, score) * heat;
}

export interface Device {
  id: string;
  name: string;
  /** null is the real device. */
  score: number | null;
  note: string;
}

export const DEVICES: readonly Device[] = [
  { id: "real", name: "My device", score: null, note: "Measured here" },
  { id: "flagship", name: "Flagship", score: 240, note: "This year's top phone" },
  { id: "mid", name: "Mid-range", score: 80, note: "Two years old" },
  { id: "budget", name: "Budget 2019", score: 35, note: "Four slow cores" },
  { id: "ancient", name: "Ancient", score: 15, note: "It still opens pages" },
];

/** The name of a simulated score, or a generic one for slider values. */
export function deviceName(simulated: number | null): string {
  if (simulated === null) return "My device";
  return DEVICES.find((d) => d.score === simulated)?.name ?? `Score ${Math.round(simulated)}`;
}

/** The thresholds ladder runs from 0 to this score; faster devices sit at its right edge. */
export const LADDER_MAX = 160;

/** Heat multiplies every effect's cost, like a phone throttling its CPU when it warms up. */
export const HEAT = 3;
