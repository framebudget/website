// The part of motion this site uses, in its own chunk. `animate` is the mini
// build: every animation runs on the Web Animations API (the compositor for
// transform and opacity), so motion never starts a requestAnimationFrame loop
// of its own. `spring` is the physics generator, also used by the counters in
// the page's shared loop.
export { animate } from "motion/mini";
export { spring, stagger } from "motion";
