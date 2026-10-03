import { APP_COLOR, APP_MS, FRAME_MS, SITE_EFFECTS, msAt } from "./effects";
import { count } from "./counter";
import { canAnimate } from "./motion";

/** Meter tracks span two frames, so the deadline sits in the middle. */
const TRACK_MS = FRAME_MS * 2;

/**
 * A frame meter: the page's work, then each effect, laid end to end. Every
 * segment exists from the start and only its transform changes, so a device
 * change slides segments in place ("morph" adds the transition in CSS).
 */
export function mountMeter(root: HTMLElement): (score: number, effects: readonly string[], heat?: number) => number {
  const track = root.querySelector<HTMLElement>("[data-track]")!;
  const ms = root.querySelector<HTMLElement>("[data-ms]")!;
  const verdict = root.querySelector<HTMLElement>("[data-verdict]")!;
  const parts = [{ name: "app", color: APP_COLOR, ms: APP_MS }, ...SITE_EFFECTS.map((e) => ({ name: e.name, color: e.color, ms: e.ms }))];
  const segs = parts.map((p) => {
    const seg = document.createElement("span");
    seg.className = "seg";
    seg.style.setProperty("--c", p.color);
    track.prepend(seg);
    return seg;
  });

  return (score, effects, heat = 1) => {
    let start = 0;
    parts.forEach((p, i) => {
      const on = p.name === "app" || effects.includes(p.name);
      const width = on ? msAt(p.ms, score) * heat : 0;
      const seg = segs[i]!;
      seg.style.setProperty("--x", (Math.min(start, TRACK_MS) / TRACK_MS).toFixed(4));
      seg.style.setProperty("--w", (Math.min(width, TRACK_MS) / TRACK_MS).toFixed(4));
      start += width;
    });
    count(ms, start, 1);
    const late = start > FRAME_MS;
    verdict.classList.toggle("is-late", late);
    verdict.textContent = late ? `${(start - FRAME_MS).toFixed(1)} ms late` : `${(FRAME_MS - start).toFixed(1)} ms to spare`;
    return start;
  };
}

/**
 * A log with fixed slots. Entries sit at translateY(k * slot); a new entry
 * takes slot 0 and the others move down by transform, so the list never
 * changes height and never pushes the page.
 */
export function mountLog(list: HTMLElement): (html: string) => void {
  const slots = Number(getComputedStyle(list).getPropertyValue("--slots")) || 6;
  return (html) => {
    const li = document.createElement("li");
    li.innerHTML = html;
    list.prepend(li);
    const items = Array.from(list.children) as HTMLElement[];
    items.forEach((item, k) => item.style.setProperty("--k", String(k)));
    for (const old of items.slice(slots)) old.remove();
    const motion = canAnimate("morph");
    if (motion) void motion.animate(li, { opacity: [0, 1], transform: ["translateY(-60%)", "translateY(0)"] }, { duration: 0.3, ease: [0.2, 0.8, 0.2, 1] });
  };
}
