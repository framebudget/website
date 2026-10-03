import { allows } from "./force";
import { reducedMotion, schedule, setTask, watchVisibility } from "./loop";
import { canAnimate, loadMotion, motionNow, SNAP, SOFT } from "./motion";
import { cue } from "./sound";
import { onEffect } from "./state";
import { all, swapText } from "./ui";

/* parallax: hero layers drift with scroll at their data-parallax speed ----------- */

function mountParallax(): void {
  const hero = document.querySelector<HTMLElement>(".hero");
  const layers = all("[data-parallax]");
  if (!hero || !layers.length) return;
  let onScreen = false;
  let allowed = false;
  let lastY = -1;

  const task = (): void => {
    const y = window.scrollY;
    if (y === lastY) return;
    lastY = y;
    for (const el of layers) el.style.transform = `translate3d(0, ${(y * Number(el.dataset.parallax)).toFixed(1)}px, 0)`;
  };
  const apply = (): void => {
    const on = onScreen && allowed && !reducedMotion();
    setTask("parallax", on ? task : null);
    if (!on && lastY !== -1) {
      lastY = -1;
      for (const el of layers) el.style.transform = "";
    }
  };
  watchVisibility(hero, (visible) => {
    onScreen = visible;
    apply();
  });
  onEffect("parallax", (on) => {
    allowed = on;
    apply();
  });
}

/* spotlight: one soft light per panel follows the pointer, moved with transform -- */

function mountSpotlight(): void {
  if (!matchMedia("(hover: hover) and (pointer: fine)").matches) return;
  let allowed = false;
  let panel: HTMLElement | null = null;
  let light: HTMLElement | null = null;
  let x = 0;
  let y = 0;

  const lightOf = (el: HTMLElement): HTMLElement => {
    let l = el.querySelector<HTMLElement>(":scope > .spot__light");
    if (!l) {
      l = document.createElement("span");
      l.className = "spot__light";
      l.setAttribute("aria-hidden", "true");
      el.prepend(l);
    }
    return l;
  };
  const paint = (): void => {
    if (light) light.style.transform = `translate3d(${x - 230}px, ${y - 230}px, 0)`;
  };
  const leave = (): void => {
    if (light) light.style.opacity = "0";
    panel = null;
    light = null;
  };

  document.addEventListener(
    "pointermove",
    (event) => {
      if (!allowed || event.pointerType !== "mouse") return;
      const over = (event.target as Element | null)?.closest?.<HTMLElement>(".spot") ?? null;
      if (over !== panel) {
        leave();
        if (!over) return;
        panel = over;
        light = lightOf(over);
        light.style.opacity = "1";
      }
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      x = event.clientX - rect.left;
      y = event.clientY - rect.top;
      schedule(paint);
    },
    { passive: true },
  );
  document.addEventListener("pointerleave", leave);
  onEffect("spotlight", (on) => {
    allowed = on && !reducedMotion();
    if (!allowed) leave();
  });
}

/* magnetic: the main buttons lean toward the pointer, then spring home ----------- */

function mountMagnetic(): void {
  if (!matchMedia("(hover: hover) and (pointer: fine)").matches) return;
  let allowed = false;
  for (const el of all(".magnetic")) {
    let rect: DOMRect | null = null;
    let dx = 0;
    let dy = 0;
    const paint = (): void => {
      el.style.transform = `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0)`;
    };
    el.addEventListener("pointerenter", () => {
      rect = allowed ? el.getBoundingClientRect() : null;
    });
    el.addEventListener("pointermove", (event) => {
      if (!rect || !allowed) return;
      dx = Math.max(-10, Math.min(10, (event.clientX - (rect.left + rect.width / 2)) * 0.22));
      dy = Math.max(-8, Math.min(8, (event.clientY - (rect.top + rect.height / 2)) * 0.3));
      schedule(paint);
    });
    el.addEventListener("pointerleave", () => {
      rect = null;
      const from = el.style.transform;
      if (!from) return;
      const motion = canAnimate("magnetic");
      el.style.transform = "";
      if (motion) void motion.animate(el, { transform: [from, "translate3d(0px, 0px, 0)"] }, { type: motion.spring, ...SOFT, damping: 14 });
    });
  }
  onEffect("magnetic", (on) => {
    allowed = on && !reducedMotion();
    if (!allowed) for (const el of all(".magnetic")) el.style.transform = "";
  });
}

/* springs: controls give under the press and spring back -------------------------- */

function mountPress(): void {
  const target = (event: Event): HTMLElement | null => (event.target as Element | null)?.closest?.<HTMLElement>(".press") ?? null;
  let pressed: HTMLElement | null = null;
  const release = (): void => {
    const el = pressed;
    pressed = null;
    if (!el) return;
    const motion = canAnimate("springs");
    if (motion) void motion.animate(el, { transform: ["scale(0.95)", "scale(1)"] }, { type: motion.spring, stiffness: 500, damping: 15 });
  };
  document.addEventListener("pointerdown", (event) => {
    const el = target(event);
    if (!el || (el as HTMLButtonElement).disabled) return;
    const motion = canAnimate("springs");
    if (!motion) return;
    pressed = el;
    void motion.animate(el, { transform: ["scale(1)", "scale(0.95)"] }, { duration: 0.1, ease: "easeOut" });
  });
  document.addEventListener("pointerup", release);
  document.addEventListener("pointercancel", release);
}

/* entrances: groups arrive in a short stagger as they scroll in ------------------- */

/**
 * Watches these elements and lets each group arrive as it scrolls in. The
 * page calls it once for its sections; the lab calls it for each fresh set.
 */
export function observeEntrances(items: readonly HTMLElement[]): void {
  const show = (batch: HTMLElement[]): void => {
    const motion = canAnimate("entrances");
    for (const el of batch) el.classList.add("is-in");
    if (!motion) {
      for (const el of batch) el.classList.add("is-css");
      return;
    }
    void motion.animate(
      batch,
      { opacity: [0, 1], transform: ["translateY(28px)", "translateY(0)"] },
      { type: motion.spring, ...SOFT, delay: motion.stagger(0.08) },
    );
  };
  const observer = new IntersectionObserver(
    (entries) => {
      const batch: HTMLElement[] = [];
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        batch.push(entry.target as HTMLElement);
        observer.unobserve(entry.target);
      }
      if (!batch.length) return;
      // Wait for motion when it is on its way, so the first sections get their stagger too.
      if (!motionNow() && allows("entrances") && !reducedMotion()) void loadMotion().then(() => show(batch), () => show(batch));
      else show(batch);
    },
    { rootMargin: "0px 0px -10% 0px" },
  );
  // Elements already on screen are marked shown before CSS hides anything, so nothing visible blinks.
  const fold = window.innerHeight;
  for (const el of items) {
    if (el.getBoundingClientRect().top < fold) el.classList.add("is-in");
    else observer.observe(el);
  }
}

function mountEntrances(): void {
  observeEntrances(all(".reveal"));
}

/* textReveal: headings arrive by blur, by word, by line or by wipe ----------------- */

function splitWords(heading: HTMLElement): HTMLElement[] {
  const words = (heading.textContent ?? "").trim().split(/\s+/);
  heading.textContent = "";
  return words.map((word, i) => {
    const outer = document.createElement("span");
    outer.className = "rw";
    const inner = document.createElement("span");
    inner.textContent = word;
    outer.append(inner);
    heading.append(outer);
    if (i < words.length - 1) heading.append(" ");
    return inner;
  });
}

function revealHeading(heading: HTMLElement, words: HTMLElement[]): void {
  heading.classList.add("is-revealed");
  const motion = canAnimate("textReveal");
  if (!motion) return;
  const kind = heading.dataset.reveal;
  if (kind === "wipe") {
    const cover = heading.querySelector<HTMLElement>(".wipe");
    if (cover) void motion.animate(cover, { transform: ["scaleX(1)", "scaleX(0)"] }, { duration: 0.75, ease: [0.65, 0, 0.35, 1] });
  } else if (kind === "lines") {
    // Words on the same line rise together; each line follows the one above.
    const tops = words.map((w) => w.offsetTop);
    const lines = Array.from(new Set(tops));
    void motion.animate(
      words,
      { opacity: [0, 1], transform: ["translateY(105%)", "translateY(0)"] },
      { type: motion.spring, ...SOFT, delay: (i: number) => lines.indexOf(tops[i]!) * 0.11 },
    );
  } else if (kind === "blur") {
    void motion.animate(
      words,
      { opacity: [0, 1], filter: ["blur(12px)", "blur(0px)"], transform: ["translateY(0.2em)", "translateY(0)"] },
      { duration: 0.8, ease: [0.2, 0.8, 0.2, 1], delay: motion.stagger(0.06) },
    );
  } else {
    void motion.animate(
      words,
      { opacity: [0, 1], transform: ["translateY(0.5em)", "translateY(0)"] },
      { type: motion.spring, ...SNAP, delay: motion.stagger(0.05) },
    );
  }
}

/**
 * Splits these headings into words and reveals each one as it scrolls in.
 * The page calls it once for its headings; the lab calls it for each fresh set.
 */
export function observeTextReveals(headings: readonly HTMLElement[]): void {
  const fold = window.innerHeight;
  for (const heading of headings) {
    const words = splitWords(heading);
    if (heading.dataset.reveal === "wipe") {
      const cover = document.createElement("span");
      cover.className = "wipe";
      cover.setAttribute("aria-hidden", "true");
      heading.append(cover);
    }
    if (heading.getBoundingClientRect().top < fold) {
      heading.classList.add("is-revealed");
      continue;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        if (!motionNow() && allows("textReveal") && !reducedMotion()) {
          void loadMotion().then(() => revealHeading(heading, words), () => revealHeading(heading, words));
        } else revealHeading(heading, words);
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    observer.observe(heading);
  }
}

function mountTextReveals(): void {
  observeTextReveals(all("[data-reveal]:not(.hero__title):not(.page-title)"));
}

/* shimmer: CSS animations run only while their element is on screen ---------------- */

function mountOnScreen(): void {
  for (const el of all(".chart, .install")) {
    watchVisibility(el, (visible) => el.classList.toggle("is-onscreen", visible));
  }
}

/* copy: the button confirms in place --------------------------------------------- */

function mountCopy(): void {
  for (const button of all<HTMLButtonElement>("[data-copy]")) {
    const label = button.querySelector<HTMLElement>(".copy__label") ?? button;
    let timer = 0;
    button.addEventListener("click", () => {
      const done = (text: string): void => {
        swapText(label, text);
        window.clearTimeout(timer);
        timer = window.setTimeout(() => swapText(label, "Copy"), 1800);
      };
      navigator.clipboard.writeText(button.dataset.copy ?? "").then(
        () => {
          done("Copied");
          cue("success", { emphasis: "subtle" });
        },
        () => {
          // No clipboard access: select the command so Ctrl+C works.
          const source = button.parentElement?.querySelector("code");
          if (source) window.getSelection()?.selectAllChildren(source);
          done("Selected");
        },
      );
    });
  }
}

/* FAQ: open and close sounds (from the toggle event, so keyboard and script opens play too) ---------------------------------------------------- */

function mountFaq(): void {
  for (const details of all<HTMLDetailsElement>(".faq details")) {
    details.addEventListener("toggle", () => cue(details.open ? "open" : "close", { emphasis: "subtle" }));
  }
}

export function mountEffects(): void {
  mountParallax();
  mountSpotlight();
  mountMagnetic();
  mountPress();
  mountEntrances();
  mountTextReveals();
  mountOnScreen();
  mountCopy();
  mountFaq();
  document.documentElement.classList.add("fx-ready");
}
