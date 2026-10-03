import { budget } from "framebudget";
import { allows } from "./force";
import { reducedMotion } from "./loop";
import type * as Lib from "./motion-lib";

type MotionLib = typeof Lib;

/** Effects that animate through motion. When none is allowed, motion is never downloaded. */
const USERS = ["counters", "entrances", "morph", "textReveal", "springs", "magnetic"];

let lib: MotionLib | null = null;
let loading: Promise<MotionLib> | null = null;

export function loadMotion(): Promise<MotionLib> {
  loading ??= import("./motion-lib").then((m) => (lib = m));
  return loading;
}

/** motion, if it is already here. Effects that need it this instant skip their animation otherwise. */
export const motionNow = (): MotionLib | null => lib;

/** Can this effect animate right now? Allowed, motion loaded, no reduced-motion preference. */
export function canAnimate(effect: string): MotionLib | null {
  if (!lib || reducedMotion() || !allows(effect)) return null;
  return lib;
}

/** Fetches motion once the browser is idle after load, when any effect that uses it is allowed. */
export function preloadMotion(): void {
  const go = (): void => {
    if (reducedMotion() || !USERS.some((e) => allows(e))) return;
    void loadMotion();
  };
  const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 300));
  if (document.readyState === "complete") idle(go);
  else window.addEventListener("load", () => idle(go), { once: true });
  budget.on("change", () => {
    if (!loading) go();
  });
}

/** A snappy spring for presses and morphs, as WAAPI options. */
export const SNAP = { stiffness: 520, damping: 30, mass: 0.8 };
export const SOFT = { stiffness: 220, damping: 26, mass: 1 };
