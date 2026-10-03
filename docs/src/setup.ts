import { configure } from "framebudget";
import { calibration } from "./effects";

// The same patch the inline boot script got, so both make the same decision.
// main.ts imports this module first: ES modules run in import order, so the
// core is configured before any other module asks the budget anything.
// The page keeps a single requestAnimationFrame loop (loop.ts) and reports
// its frames to the governor from there, so framebudget's own sampler is off.
configure({ calibration, governor: { auto: false } });
