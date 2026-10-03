import { BY_NAME, SITE_EFFECTS } from "../effects";

/**
 * Effects the lab cannot drive without the visitor: they answer the pointer,
 * a press, a control or a navigation. They are listed as not measured.
 */
export const NOT_MEASURED: Readonly<Record<string, string>> = {
  hover: "Answers your pointer.",
  sound: "Plays when you use a control, and draws no frames.",
  morph: "Runs when you use a control.",
  pageTransition: "Runs between two pages.",
  springs: "Runs when you press a button.",
  magnetic: "Follows your pointer.",
  spotlight: "Follows your pointer.",
};

/** Every other effect, in registry order: the stage, the scroll and the counters drive them. */
export const MEASURED: readonly string[] = SITE_EFFECTS.map((e) => e.name).filter((name) => !(name in NOT_MEASURED));

export interface Step {
  name: string;
  label: string;
  /** The exact effect set forced during the step. */
  effects: readonly string[];
}

/** Baseline, each measured effect alone, all of them together, and the baseline again to catch heat. */
export const STEPS: readonly Step[] = [
  { name: "baseline", label: "No effects", effects: [] },
  ...MEASURED.map((name) => ({ name, label: BY_NAME[name]?.label ?? name, effects: [name] })),
  { name: "all", label: "All measured effects", effects: MEASURED },
  { name: "baseline-end", label: "No effects, again", effects: [] },
];
