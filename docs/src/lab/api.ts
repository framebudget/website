import type { DeviceReport } from "./device";
import type { FrameStats, WorkStats } from "./measure";

/** The lab protocol this page speaks: 2 adds the main-thread work per frame to every step. */
export const PROTOCOL = 2;

/** Why a run stopped, as the page explains it. */
export type Failure = "turnstile" | "full" | "network" | "server" | "hidden";

export class LabError extends Error {
  constructor(
    readonly failure: Failure,
    readonly status = 0,
  ) {
    super(`lab: ${failure}${status ? ` (${status})` : ""}`);
  }
}

/** An open run: its id and write key live in this object only, never in storage. */
export interface Run {
  run: string;
  key: string;
}

export interface RunRequest {
  turnstile: string;
  lib: string;
  cal: string;
  protocol: typeof PROTOCOL;
  device: DeviceReport;
}

export interface StepReport extends FrameStats, WorkStats {
  name: string;
  effects: string[];
}

async function post(url: string, body: unknown): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new LabError("network");
  }
}

export async function createRun(request: RunRequest): Promise<Run> {
  const response = await post("/api/lab/runs", request);
  if (response.status === 403) throw new LabError("turnstile", 403);
  if (response.status === 429) throw new LabError("full", 429);
  if (response.status !== 201) throw new LabError("server", response.status);
  const body: unknown = await response.json().catch(() => null);
  if (typeof body !== "object" || body === null || !("run" in body) || !("key" in body)) throw new LabError("server", response.status);
  const { run, key } = body;
  if (typeof run !== "string" || typeof key !== "string") throw new LabError("server", response.status);
  return { run, key };
}

/** Appends one step to the run's row; `done` closes the run. */
export async function sendStep(run: Run, step: StepReport, done: boolean): Promise<void> {
  const response = await post(`/api/lab/runs/${encodeURIComponent(run.run)}/steps`, { key: run.key, step, done });
  if (response.status !== 204) throw new LabError("server", response.status);
}
