// Anonymous measurements from this site's visitors, to calibrate framebudget's
// scores on real devices. The library sends one beacon per page view when the
// page hides, never under Global Privacy Control or Save-Data, and never while
// a device is simulated or a tier is forced. The visitor can say no here; the
// choice is remembered in localStorage and turns sharing off at once, through
// configure({ share: null }).
import { configure, type ShareOptions } from "framebudget";

const KEY = "framebudget-site-share";

export const SHARE: ShareOptions = { endpoint: "/api/report", sampleRate: 1, minIntervalDays: 7, calibrationUrl: "/api/calibration" };

type Choice = "on" | "off" | null;

function stored(): Choice {
  try {
    const value = localStorage.getItem(KEY);
    return value === "on" || value === "off" ? value : null;
  } catch {
    return null;
  }
}

/** Sharing is on unless the visitor said no. */
export const sharing = (): boolean => stored() !== "off";

/** The visitor has answered the notice, either way. */
export const answered = (): boolean => stored() !== null;

const listeners: Array<() => void> = [];

export function setSharing(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // Private mode: the choice lasts for this page only.
  }
  configure({ share: on ? SHARE : null });
  for (const fn of listeners) fn();
}

/** Calls back now and whenever the choice changes. */
export function onSharing(fn: () => void): void {
  listeners.push(fn);
  fn();
}

/**
 * The notice at the bottom of the page on the first visit: what is measured,
 * a link to the privacy page and a way to say no. It is fixed, so showing it
 * moves nothing, and it never takes focus.
 */
export function mountShareNote(): void {
  const note = document.querySelector<HTMLElement>("[data-share-note]");
  if (!note || answered()) return;
  note.querySelector<HTMLButtonElement>("[data-share-ok]")!.addEventListener("click", () => setSharing(true));
  note.querySelector<HTMLButtonElement>("[data-share-no]")!.addEventListener("click", () => setSharing(false));
  note.hidden = false;
  // The dock sits above the notice on narrow screens, where both span the width.
  document.documentElement.style.setProperty("--share-note-h", `${note.offsetHeight + 8}px`);
  requestAnimationFrame(() => note.classList.add("is-shown"));
  // Answered here or with the privacy page's control: the notice leaves.
  listeners.push(() => {
    if (!answered()) return;
    note.classList.remove("is-shown");
    note.inert = true;
    document.documentElement.style.removeProperty("--share-note-h");
  });
}

/** The control on the privacy page: the current choice and the switch. */
export function mountShareControl(): void {
  const button = document.querySelector<HTMLButtonElement>("[data-share-toggle]");
  const state = document.querySelector<HTMLElement>("[data-share-state]");
  if (!button || !state) return;
  button.addEventListener("click", () => setSharing(!sharing()));
  onSharing(() => {
    const on = sharing();
    button.setAttribute("aria-pressed", String(!on));
    button.textContent = on ? "Don't share" : "Share again";
    state.textContent = on
      ? "This browser shares anonymous measurements, unless Global Privacy Control or Save-Data is on."
      : "This browser does not share anything with framebudget.dev.";
  });
}
