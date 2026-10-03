import { DEVICES, FRAME_MS, SITE_EFFECTS } from "./effects";

/**
 * Texts that change while the page runs. Each live text sits in a
 * `.reserve` box (render.ts) that also holds its longest variants, hidden,
 * so the box has its final height from the first paint and a new text never
 * moves anything below it.
 */
export const CHART_NOTES = {
  hi: "Each bar is one frame: the page's own work, then every effect framebudget allowed. The outline is the same frame with every effect on.",
  low: "Drawn at 1x and stepped, because the full-resolution chart is off on this device. The outline is the same frame with every effect on.",
  still: "The live chart is off on this device, so this is a still picture of its frames. The outline is the same frame with every effect on.",
} as const;

export function compareNote(allMs: number, fbMs: number, kept: number): string {
  if (allMs <= FRAME_MS) {
    return "This device runs every effect inside the frame, so framebudget keeps them all. Pick a slower device in the hero or the simulator to see the difference.";
  }
  const intervals = Math.ceil(allMs / FRAME_MS);
  return `With every effect on, each frame needs ${intervals} vsync intervals, so this device would paint at about ${Math.round(60 / intervals)} fps. framebudget keeps ${kept} of ${SITE_EFFECTS.length} effects ${fbMs <= FRAME_MS ? "and every frame on time" : "and the frame as short as it can"}.`;
}

export const LEARNED = {
  simulated: "While a device is simulated nothing is learned, so the real device's history stays clean.",
  none: "Nothing yet: no effect has stuttered on this device.",
  some: (names: string): string => `Kept off here because they stuttered before: ${names}.`,
};

export const WARM_NOTE = {
  real: "100 is the reference phone",
  simulated: "Measured on the real device. The simulator only replaces the score.",
};

export const htmlAttrs = (tier: string, effects: string): string =>
  `<html data-framebudget="${tier}"\n      data-framebudget-effects="${effects}">`;

/** Labels of a list of effects, short enough for one line of a log. */
export function listNames(labels: readonly string[]): string {
  if (labels.length <= 3) return labels.join(", ");
  return `${labels.slice(0, 2).join(", ")} and ${labels.length - 2} more`;
}

/** The longest variants of each live text, for the hidden reserve layers. */
export const RESERVES: Record<string, readonly string[]> = {
  "chart-note": Object.values(CHART_NOTES),
  "compare-note": [compareNote(FRAME_MS * 10, FRAME_MS * 2, 15), compareNote(1, 1, 15)],
  learned: [LEARNED.simulated, LEARNED.none, LEARNED.some(listNames(["Frame chart, full res", "Backdrop blur", "x", "y"]))],
  "warm-note": Object.values(WARM_NOTE),
  "html-attrs": [htmlAttrs("Medium", SITE_EFFECTS.map((e) => e.name).join(" "))],
  "ladder-device": ["this device", ...DEVICES.map((d) => d.name), "Score 300"],
};
