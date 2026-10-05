import { configure } from "framebudget";
import { calibrationDefaults } from "./effects";
import { SHARE, sharing } from "./share";

// The same defaults the inline boot script got, so both make the same decision.
// They are defaults: the calibration fetched from /api/calibration refines them.
// main.ts imports this module first: ES modules run in import order, so the
// core is configured before any other module asks the budget anything.
// The page keeps a single requestAnimationFrame loop (loop.ts) and reports
// its frames to the governor from there, so framebudget's own sampler is off.
// Every page view shares anonymous measurements (see privacy.html) unless the
// visitor said no on the notice or the privacy page.
configure({ calibrationDefaults, governor: { auto: false }, share: sharing() ? SHARE : null });
