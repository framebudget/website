import { budget } from "framebudget";
import { count } from "./counter";
import { deviceName } from "./effects";
import { watchVisibility } from "./loop";
import { onSound, setSoundChoice, soundAllowed, soundChoice } from "./sound";
import { watch } from "./state";
import { all, setText, swapText } from "./ui";

/**
 * The dock: on every page, while a device is simulated, a bar at the bottom
 * says which one and offers the way back. It steps aside while a device
 * picker is on screen, since the picker already shows both.
 */
export function mountDock(): void {
  const dock = document.querySelector<HTMLElement>("[data-dock]");
  if (!dock) return;
  const tier = dock.querySelector<HTMLElement>("[data-dock-tier]")!;
  const device = dock.querySelector<HTMLElement>("[data-dock-device]")!;
  const score = dock.querySelector<HTMLElement>("[data-dock-score]")!;
  let simulating = false;
  const pickersInView = new Set<Element>();

  const apply = (): void => {
    const shown = simulating && pickersInView.size === 0;
    dock.classList.toggle("is-shown", shown);
    dock.inert = !shown;
  };

  dock.querySelector<HTMLButtonElement>("[data-dock-back]")!.addEventListener("click", () => budget.simulate(null));
  for (const picker of all("[data-picker]")) {
    watchVisibility(picker, (visible) => {
      if (visible) pickersInView.add(picker);
      else pickersInView.delete(picker);
      apply();
    });
  }
  watch((snap) => {
    simulating = snap.simulated !== null;
    if (simulating) {
      setText(device, deviceName(snap.simulated));
      count(score, Math.round(snap.score ?? 0));
    }
    if (tier.dataset.tier !== snap.tier) {
      tier.dataset.tier = snap.tier;
      swapText(tier, snap.tier);
    }
    apply();
  });
}

/** The sound toggle in the header: the visitor's choice, and whether framebudget allows sound at all. */
export function mountSoundToggle(): void {
  const button = document.querySelector<HTMLButtonElement>("[data-sound-toggle]");
  const state = document.querySelector<HTMLElement>("[data-sound-state]");
  if (!button || !state) return;
  button.addEventListener("click", () => setSoundChoice(!soundChoice()));
  onSound(() => {
    const choice = soundChoice();
    button.setAttribute("aria-pressed", String(choice));
    button.toggleAttribute("data-unavailable", !soundAllowed());
    const why = budget.snapshot().off.sound;
    setText(
      state,
      !soundAllowed()
        ? `Unavailable: framebudget turned sound off on this device${why === "data" ? " because Save-Data is on" : ""}.`
        : choice
          ? "Sound is on."
          : "Sound is off.",
    );
    button.title = !soundAllowed() ? "Sound is off on this device" : choice ? "Turn sounds off" : "Turn sounds on";
  });
}
