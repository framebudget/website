import { PROTOCOL } from "./api";

/**
 * One device runs the lab once per calibration version and lab protocol. The
 * flag holds both and the UTC day of the run, never the run's id, and is
 * written only after the server accepted the last step. A flag from an older
 * protocol (no `lab`) lets the device run the current one once.
 */
const KEY = "framebudget-lab";

export function contributed(cal: string): boolean {
  try {
    const flag: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return typeof flag === "object" && flag !== null && "cal" in flag && flag.cal === cal && "lab" in flag && flag.lab === PROTOCOL;
  } catch {
    return false;
  }
}

export function markContributed(cal: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ cal, lab: PROTOCOL, day: new Date().toISOString().slice(0, 10) }));
  } catch {
    // Private mode or storage off: the button comes back on the next visit.
  }
}
