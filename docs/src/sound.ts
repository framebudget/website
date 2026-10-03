// Interface sounds (cuelume): synthesized with Web Audio, no files. Elements opt
// in with data-cuelume-* attributes (bind() delegates on the document); code
// plays outcomes with cue(). Sound is the framebudget effect "sound": cuelume
// is fetched when the browser is idle and only while the effect is allowed,
// and it falls silent the moment the effect turns off. The visitor's own
// choice is remembered in localStorage.
import type * as Cuelume from "cuelume";
import type { PlayOptions, SoundName } from "cuelume";
import { onEffect } from "./state";

const KEY = "framebudget-site-sound";
let lib: typeof Cuelume | null = null;
let starting = false;
let allowed = false;
const listeners: Array<() => void> = [];

/** The visitor's choice. On by default. */
export function soundChoice(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

/** Sound is audible: the visitor wants it and framebudget allows it. */
export const soundOn = (): boolean => allowed && soundChoice();
export const soundAllowed = (): boolean => allowed;

function start(): void {
  if (starting) return;
  starting = true;
  const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 300));
  idle(() => {
    // Kept dynamic on purpose: this is what keeps cuelume out of the first download.
    void import("cuelume").then((m) => {
      lib = m;
      m.setVolume(0.45);
      m.setEnabled(soundOn());
      m.bind();
    });
  });
}

export function setSoundChoice(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // Private mode: the choice lasts for this page only.
  }
  lib?.setEnabled(soundOn());
  for (const fn of listeners) fn();
}

/** Calls back when the choice or the effect changes. */
export function onSound(fn: () => void): void {
  listeners.push(fn);
  fn();
}

export function cue(name: SoundName, options?: PlayOptions): void {
  if (soundOn()) lib?.play(name, options);
}

export function mountSound(): void {
  onEffect("sound", (on) => {
    allowed = on;
    if (on) start();
    lib?.setEnabled(soundOn());
    for (const fn of listeners) fn();
  });
}
