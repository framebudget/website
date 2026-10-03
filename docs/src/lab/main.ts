import "../main";
import { budget } from "framebudget";
import { version } from "framebudget/package.json";
import { reducedMotion } from "../loop";
import { loadMotion } from "../motion";
import { forceEffects } from "../state";
import { createRun, LabError } from "./api";
import { deviceReport, waitForWarm } from "./device";
import { contributed, markContributed } from "./flag";
import { measureRefresh } from "./measure";
import { runSteps, whenVisible } from "./run";
import { mountStage } from "./stage";
import { STEPS } from "./steps";
import { challenge } from "./turnstile";
import { mountView } from "./view";

/**
 * The lab page: on the visitor's explicit press, Turnstile, the warm
 * benchmark, the refresh rate, then one run of every step, each sent as soon
 * as it ends. The local flag is written only once the server accepted the
 * last step.
 */
function mountLab(): void {
  const root = document.querySelector<HTMLElement>("[data-lab]");
  if (!root) return;
  const view = mountView(root);
  const stage = mountStage(root.querySelector<HTMLElement>("[data-lab-stage]")!);
  const widget = root.querySelector<HTMLElement>("[data-lab-turnstile]")!;
  const button = root.querySelector<HTMLButtonElement>("[data-lab-start]")!;
  const cal = budget.snapshot().calibration.version;
  view.ready(contributed(cal));
  let busy = false;

  async function start(): Promise<void> {
    view.status("Checking this browser with Cloudflare Turnstile.");
    let token: string;
    try {
      token = await challenge(widget);
    } catch {
      throw new LabError("turnstile");
    }
    // The lab measures this device, not a simulated one.
    if (budget.snapshot().simulated !== null) budget.simulate(null);
    view.status("Waiting for framebudget's benchmark.");
    const snap = await waitForWarm();
    if (!reducedMotion()) await loadMotion().catch(() => null);
    view.running(true);
    forceEffects([]);
    stage.show();
    view.progress("Measuring the refresh rate");
    let refreshHz = await measureRefresh();
    while (refreshHz === null) {
      await whenVisible();
      refreshHz = await measureRefresh();
    }
    const run = await createRun({ turnstile: token, lib: version, cal, device: deviceReport(snap, refreshHz) });
    const reports = await runSteps(run, refreshHz, stage, (index, step) =>
      view.progress(`Step ${index + 1} of ${STEPS.length}: ${step.label}`),
    );
    forceEffects(null);
    stage.hide();
    view.running(false);
    view.done(reports, refreshHz);
    markContributed(cal);
  }

  button.addEventListener("click", () => {
    if (busy) return;
    busy = true;
    start()
      .catch((error: unknown) => {
        forceEffects(null);
        stage.hide();
        view.running(false);
        view.fail(error instanceof LabError ? error.failure : "network");
      })
      .finally(() => {
        busy = false;
      });
  });
}

mountLab();
