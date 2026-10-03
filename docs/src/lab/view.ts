import { BY_NAME } from "../effects";
import type { Failure, StepReport } from "./api";
import { NOT_MEASURED, STEPS } from "./steps";

/** What the consent panel says after a failure. */
const FAILURES: Readonly<Record<Failure, string>> = {
  turnstile: "Cloudflare Turnstile could not confirm this browser, so nothing was sent. You can try again.",
  full: "The lab is full for today. Please come back tomorrow.",
  network: "A network error stopped the test. Check the connection and try again.",
  server: "The server did not accept the results, so the test stopped. You can try again.",
  hidden: "The tab was hidden twice during the same step, so the test stopped. Keep the tab visible and try again.",
};

export const CONTRIBUTED = "This device already contributed to this calibration. Thank you.";
export const THANKS = "Done, and thank you. The results below are on their way to the calibration.";

export interface View {
  /** Before the button: ready, or this device already ran the lab. */
  ready(contributed: boolean): void;
  /** A short message under the button, while it works. */
  status(text: string): void;
  /** Switches the page to the stage, or back to the text. */
  running(on: boolean): void;
  progress(text: string): void;
  fail(failure: Failure): void;
  done(reports: readonly StepReport[], refreshHz: number): void;
}

const ms = (value: number): string => `${value.toFixed(1)} ms`;

function row(cells: readonly string[], head: string): HTMLTableRowElement {
  const tr = document.createElement("tr");
  const th = document.createElement("th");
  th.scope = "row";
  th.textContent = head;
  tr.append(th);
  for (const text of cells) {
    const td = document.createElement("td");
    td.textContent = text;
    // A row with one cell spans the three result columns.
    if (cells.length === 1) td.colSpan = 3;
    tr.append(td);
  }
  return tr;
}

export function mountView(root: HTMLElement): View {
  const q = (selector: string): HTMLElement => root.querySelector<HTMLElement>(selector)!;
  const intro = q("[data-lab-intro]");
  const button = root.querySelector<HTMLButtonElement>("[data-lab-start]")!;
  const state = q("[data-lab-state]");
  const progress = q("[data-lab-progress]");
  const results = q("[data-lab-results]");
  const rows = q("[data-lab-rows]");
  const refresh = q("[data-lab-refresh]");

  return {
    ready(contributed) {
      button.hidden = contributed;
      button.disabled = false;
      state.textContent = contributed ? CONTRIBUTED : "";
    },
    status(text) {
      button.disabled = true;
      state.textContent = text;
    },
    running(on) {
      intro.hidden = on;
      // The step progress takes over from the pre-run status, and vice versa.
      state.textContent = "";
      progress.textContent = on ? "Getting ready" : "";
      if (!on) return;
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    },
    progress(text) {
      progress.textContent = text;
    },
    fail(failure) {
      progress.textContent = "";
      button.hidden = failure === "full";
      button.disabled = false;
      state.textContent = FAILURES[failure];
    },
    done(reports, refreshHz) {
      button.hidden = true;
      state.textContent = THANKS;
      refresh.textContent = `${refreshHz} Hz`;
      rows.replaceChildren(
        ...reports.map((r) => row([ms(r.medianMs), ms(r.p95Ms), `${r.over} of ${r.frames}`], STEPS.find((s) => s.name === r.name)?.label ?? r.name)),
        ...Object.entries(NOT_MEASURED).map(([name, why]) => row([`Not measured. ${why}`], BY_NAME[name]?.label ?? name)),
      );
      results.hidden = false;
      results.scrollIntoView({ block: "start" });
    },
  };
}
