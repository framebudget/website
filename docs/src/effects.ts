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

// Thresholds sit between the simulator's presets, past the 10% hysteresis band
// on both sides where the spacing allows, so dropping one preset turns off one
// or two effects. Only Budget 2019 (45) and Budget 2021 (55) are too close for
// that: textReveal and morph at 45 depend on the direction you came from.
export const SITE_EFFECTS: readonly SiteEffect[] = [
  { name: "hover", label: "Hover states", threshold: 10, cost: 1, ms: 0.2, color: "#b8c0d0", what: "Links, rows and controls answer the pointer." },
  { name: "counters", label: "Counting numbers", threshold: 12, cost: 1, ms: 0.25, color: "#8db4ff", motion: true, what: "Scores, frame times and counts roll to their new value on a spring." },
  { name: "sound", label: "Interface sounds", threshold: 20, cost: 1, ms: 0.3, color: "#1fa6ca", data: true, what: "Synthesized taps, toggles and outcomes, from cuelume. No audio files." },
  { name: "entrances", label: "Staggered reveals", threshold: 24, cost: 2, ms: 0.4, color: "#5fd6a2", motion: true, what: "Sections arrive in a short stagger as they scroll into view." },
  { name: "canvasLowRes", label: "Frame chart, 1x", threshold: 32, cost: 3, ms: 0.6, color: "#2fb67c", motion: true, what: "The hero's live frame chart, at one pixel per CSS pixel, stepping." },
  { name: "shimmer", label: "Deadline glow", threshold: 38, cost: 2, ms: 0.5, color: "#ff8fb6", motion: true, what: "The 16.7 ms line breathes and the install command catches a sheen." },
  { name: "textReveal", label: "Text reveals", threshold: 46, cost: 2, ms: 0.5, color: "#f7cd63", motion: true, what: "Headlines arrive by blur, by word, by line or by wipe." },
  { name: "morph", label: "Morphing controls", threshold: 49, cost: 2, ms: 0.4, color: "#c4b1ff", motion: true, what: "Selectors slide, buttons confirm in place, readouts swap their text." },
  { name: "pageTransition", label: "Page transitions", threshold: 62, cost: 3, ms: 0.8, color: "#9474f2", motion: true, what: "A cross-document view transition between this page and the API reference." },
  { name: "springs", label: "Spring presses", threshold: 66, cost: 3, ms: 0.7, color: "#e0a8ff", motion: true, what: "Buttons give under the press and spring back." },
  { name: "magnetic", label: "Magnetic buttons", threshold: 85, cost: 2, ms: 0.6, color: "#f5c35b", motion: true, what: "The main buttons lean toward the pointer." },
  { name: "parallax", label: "Parallax", threshold: 90, cost: 5, ms: 1.2, color: "#f2b21b", motion: true, what: "The hero's headline and grid drift at different speeds as you scroll." },
  { name: "spotlight", label: "Cursor spotlight", threshold: 112, cost: 4, ms: 1, color: "#ffd98a", motion: true, what: "A soft light follows the pointer across the panels." },
  { name: "blur", label: "Backdrop blur", threshold: 135, cost: 6, ms: 1.5, color: "#6482f5", what: "Frosted glass behind the header and the device dock." },
  { name: "canvasHiRes", label: "Frame chart, full res", threshold: 180, cost: 8, ms: 2.6, color: "#86e3b9", motion: true, data: true, what: "The frame chart at the screen's pixel ratio, scrolling smoothly." },
];

export const BY_NAME: Readonly<Record<string, SiteEffect>> = Object.fromEntries(SITE_EFFECTS.map((e) => [e.name, e]));

/** The page's own work per frame on the reference device, effects aside. */
export const APP_MS = 2;
export const APP_COLOR = "#7d86a6";

/** One frame at 60 Hz. */
export const FRAME_MS = 16.7;

/** Tier floors for this site's thresholds: Full is every effect, High stops after parallax, Medium after morph. */
export const TIER_FLOORS = { Full: 180, High: 90, Medium: 49, Lite: 20 } as const;

/** Shared by the inline boot script and `configure()`, so both make the same first decision. */
export const calibration: CalibrationPatch = {
  effects: Object.fromEntries(
    SITE_EFFECTS.map(({ name, threshold, cost, motion, data }) => [name, { threshold, cost, motion: !!motion, data: !!data }]),
  ),
  tiers: { ...TIER_FLOORS },
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
  /** Label for the narrow hero picker. */
  short: string;
  /** null is the real device. */
  score: number | null;
  note: string;
  /** Also offered in the hero's picker, which has room for five. */
  hero?: boolean;
}

export const DEVICES: readonly Device[] = [
  { id: "real", name: "My device", short: "Mine", score: null, note: "Measured here", hero: true },
  { id: "flagship", name: "Flagship 2025", short: "Flagship", score: 240, note: "This year's top phone", hero: true },
  { id: "upper", name: "Upper mid-range 2023", short: "2023", score: 150, note: "Two years old, fast cores" },
  { id: "reference", name: "Reference", short: "Ref", score: 100, note: "Where the scale is 100" },
  { id: "mid", name: "Mid-range 2020", short: "Mid", score: 75, note: "Five years old", hero: true },
  { id: "budget2021", name: "Budget 2021", short: "2021", score: 55, note: "Eight small cores" },
  { id: "budget", name: "Budget 2019", short: "2019", score: 45, note: "Four slow cores", hero: true },
  { id: "old", name: "Old budget 2017", short: "2017", score: 28, note: "Two GB of memory" },
  { id: "ancient", name: "Ancient", short: "Ancient", score: 15, note: "It still opens pages", hero: true },
];

/** The name of a simulated score, or a generic one for slider values. */
export function deviceName(simulated: number | null): string {
  if (simulated === null) return "My device";
  return DEVICES.find((d) => d.score === simulated)?.name ?? `Score ${Math.round(simulated)}`;
}

/** The thresholds ladder runs from 0 to this score; faster devices sit at its right edge. */
export const LADDER_MAX = 200;

/** Heat multiplies every effect's cost, like a phone throttling its CPU when it warms up. */
export const HEAT = 3;
