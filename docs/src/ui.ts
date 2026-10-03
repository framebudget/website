import { canAnimate, SNAP } from "./motion";

export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

/** All elements matching `selector`, typed. */
export function all<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

/**
 * Replaces a short text in place ("morph" effect): the old text lifts out,
 * the new one rises in. The element has a fixed width in CSS, so its
 * neighbors never move.
 */
export function swapText(el: HTMLElement, text: string): void {
  if (el.textContent === text) return;
  const motion = canAnimate("morph");
  if (!motion) {
    el.textContent = text;
    return;
  }
  void motion
    .animate(el, { opacity: [1, 0], transform: ["translateY(0)", "translateY(-40%)"] }, { duration: 0.09, ease: "easeIn" })
    .then(() => {
      el.textContent = text;
      return motion.animate(
        el,
        { opacity: [0, 1], transform: ["translateY(45%)", "translateY(0)"] },
        { type: motion.spring, ...SNAP },
      );
    });
}

/** A short spring pop on an element whose value just changed ("morph"). */
export function pop(el: HTMLElement): void {
  const motion = canAnimate("morph");
  if (!motion) return;
  void motion.animate(el, { transform: ["scale(1.12)", "scale(1)"] }, { type: motion.spring, stiffness: 600, damping: 18 });
}

/**
 * Wires an ARIA tablist: click and arrow keys select a tab. Roving tabindex
 * keeps one tab in the tab order; the segmented thumb follows with --i.
 */
export function tablist(list: HTMLElement, onSelect: (tab: HTMLButtonElement, index: number) => void): void {
  const tabs = all<HTMLButtonElement>('[role="tab"]', list);
  const select = (tab: HTMLButtonElement, focus: boolean): void => {
    if (focus) tab.focus();
    if (tab.getAttribute("aria-selected") === "true") return;
    const index = tabs.indexOf(tab);
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
    }
    list.style.setProperty("--i", String(index));
    onSelect(tab, index);
  };
  for (const tab of tabs) {
    tab.addEventListener("click", () => select(tab, false));
    tab.addEventListener("keydown", (event) => {
      const i = tabs.indexOf(tab);
      const target =
        event.key === "ArrowRight"
          ? tabs[(i + 1) % tabs.length]
          : event.key === "ArrowLeft"
            ? tabs[(i - 1 + tabs.length) % tabs.length]
            : event.key === "Home"
              ? tabs[0]
              : event.key === "End"
                ? tabs[tabs.length - 1]
                : undefined;
      if (!target) return;
      event.preventDefault();
      select(target, true);
    });
  }
}
