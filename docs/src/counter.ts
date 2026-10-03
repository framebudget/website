import { setTask } from "./loop";
import { canAnimate } from "./motion";

/**
 * Numbers that roll to their new value ("counters" effect). Each number runs
 * motion's spring generator inside the page's shared loop, so a dozen
 * readouts changing at once still cost one requestAnimationFrame callback.
 * Readouts have a fixed width and tabular figures in CSS, so a rolling
 * number never moves its neighbors.
 */
interface Roll {
  el: HTMLElement;
  value: number;
  target: number;
  decimals: number;
  next: ((t: number) => { value: number; done: boolean }) | null;
  t: number;
}

const rolls = new Map<HTMLElement, Roll>();
const active = new Set<Roll>();

function write(roll: Roll, value: number): void {
  roll.value = value;
  const text = value.toFixed(roll.decimals);
  if (roll.el.textContent !== text) roll.el.textContent = text;
}

function step(_now: number, dt: number): void {
  for (const roll of active) {
    roll.t += dt;
    const state = roll.next!(roll.t);
    write(roll, state.done ? roll.target : state.value);
    if (state.done) {
      roll.next = null;
      active.delete(roll);
    }
  }
  if (!active.size) setTask("counters", null);
}

/** Sets a readout to `target`, rolling there when counters are allowed. Returns true when it rolls. */
export function count(el: HTMLElement, target: number, decimals = 0): boolean {
  let roll = rolls.get(el);
  if (!roll) {
    roll = { el, value: Number(el.textContent) || 0, target, decimals, next: null, t: 0 };
    rolls.set(el, roll);
  }
  roll.decimals = decimals;
  if (roll.target === target && (roll.next || roll.value === target)) {
    if (!roll.next) write(roll, target);
    return false;
  }
  roll.target = target;
  const motion = canAnimate("counters");
  if (!motion || !Number.isFinite(roll.value) || roll.value === target) {
    roll.next = null;
    active.delete(roll);
    write(roll, target);
    return false;
  }
  const gen = motion.spring({ keyframes: [roll.value, target], stiffness: 170, damping: 24, mass: 1, restDelta: 10 ** -decimals / 2 });
  roll.next = (t) => gen.next(t);
  roll.t = 0;
  active.add(roll);
  setTask("counters", step);
  return true;
}
