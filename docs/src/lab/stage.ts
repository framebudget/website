import { count } from "../counter";
import { observeEntrances, observeTextReveals } from "../fx";
import { all } from "../ui";

/**
 * The stage the effects run on during a lab run: a tall track of sections
 * that scrolls under the header (backdrop blur, entrances, text reveals) and a
 * panel that stays at the bottom of the screen with the hero's parallax
 * layers, the frame chart, the install line and four counters. Every step
 * gets the same fresh track, the same scroll and the same counter changes;
 * only the forced effect set differs, so steps compare with the baseline.
 */
export interface Stage {
  show(): void;
  hide(): void;
  /** Scrolls to the top and builds a fresh track for a step with this effect set. */
  prepare(effects: readonly string[]): void;
  /** One frame of the step: the scroll position and the counters at `elapsedMs`. */
  drive(elapsedMs: number, durationMs: number): void;
  /** Empties the track and scrolls back to the top, so nothing runs between steps. */
  clear(): void;
}

const HEADINGS = [
  "Every effect spends the same frame",
  "Scores come from real devices",
  "Thresholds sit between the presets",
  "A slow phone stays smooth",
  "A fast phone keeps everything",
  "The governor watches late frames",
  "Effects step down one at a time",
  "Nothing here identifies you",
  "One row per run, then it closes",
  "Thank you for helping",
];
const KINDS = ["blur", "words", "lines", "wipe"] as const;
const COPY =
  "At 60 Hz a frame lasts 16.7 ms. The page draws, each effect takes its slice, and whatever does not fit makes the frame late. This section is here to be scrolled past.";

/** The counters change value this often, in every step. With counters off they jump instead of rolling. */
const COUNT_MS = 600;
const VALUES = [12, 87, 45, 163, 7, 98, 230, 61, 140, 33, 76, 199, 25, 118, 54, 172];
/** Share of a step spent scrolling down; the rest scrolls back up. */
const DOWN = 0.7;

const ease = (t: number): number => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, t)));

const scrollTop = (top: number): void => window.scrollTo({ top, left: 0, behavior: "instant" });

export function mountStage(root: HTMLElement): Stage {
  const track = root.querySelector<HTMLElement>("[data-lab-track]")!;
  const readouts = all("[data-lab-count]", root);
  let range = 0;
  let tick = 0;

  const setCounters = (n: number): void => {
    readouts.forEach((el, i) => count(el, VALUES[(n + i * 5) % VALUES.length]!));
  };

  return {
    show() {
      root.hidden = false;
    },
    hide() {
      root.hidden = true;
      track.replaceChildren();
    },
    prepare(effects) {
      scrollTop(0);
      const blocks: HTMLElement[] = [];
      const headings: HTMLElement[] = [];
      HEADINGS.forEach((text, i) => {
        const block = document.createElement("section");
        block.className = "lab-block";
        const heading = document.createElement("h2");
        heading.className = "lab-block__title";
        heading.textContent = text;
        if (effects.includes("textReveal")) heading.dataset.reveal = KINDS[i % KINDS.length]!;
        const body = document.createElement("p");
        body.textContent = COPY;
        block.append(heading, body);
        if (effects.includes("entrances")) block.classList.add("reveal");
        blocks.push(block);
        headings.push(heading);
      });
      track.replaceChildren(...blocks);
      // The site's own observers, on fresh elements: they reveal as the scroll brings them in.
      if (effects.includes("entrances")) observeEntrances(blocks);
      if (effects.includes("textReveal")) observeTextReveals(headings);
      range = Math.max(0, root.getBoundingClientRect().bottom + window.scrollY - window.innerHeight);
      tick = 0;
      setCounters(tick);
    },
    drive(elapsedMs, durationMs) {
      const t = elapsedMs / durationMs;
      const position = t < DOWN ? ease(t / DOWN) : 1 - ease((t - DOWN) / (1 - DOWN));
      scrollTop(Math.round(position * range));
      const next = Math.floor(elapsedMs / COUNT_MS);
      if (next !== tick) {
        tick = next;
        setCounters(tick);
      }
    },
    clear() {
      track.replaceChildren();
      scrollTop(0);
    },
  };
}
