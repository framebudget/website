/**
 * The opt-in lab (framebudget.dev/lab): one D1 row per run. POST /api/lab/runs
 * creates the row after Turnstile and the daily cap; POST /api/lab/runs/<run>/steps
 * appends one measured step to that row with a single conditional UPDATE.
 */
import { deriveClient } from "./client";
import type { Env } from "./handler";
import { readJson, sameOrigin, status, utcDay } from "./http";
import { validateLabRun, validateLabStep, type LabRunRequest } from "./lab-validate";
import { verifyTurnstile } from "./turnstile";
import { KERNELS } from "./validate";

export const RUN_BODY_BYTES = 4096;
export const STEP_BODY_BYTES = 2048;
export const MAX_STEPS = 20;
/** Seconds after creation during which a run accepts steps. */
export const RUN_OPEN_SECONDS = 900;
/** Used when LAB_DAILY_CAP is missing or not a whole number. */
export const DEFAULT_DAILY_CAP = 1000;

export const STEPS_PATH = /^\/api\/lab\/runs\/([^/]+)\/steps$/;
/** crypto.randomUUID output. */
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const RUN_COLUMNS = [
  "id", "created_day", "lib", "cal", "score", "cold", "warm", "tick_ms",
  "kernel_float", "kernel_typed", "kernel_alloc", "kernel_path",
  "cores", "memory_gb", "refresh_hz", "dpr", "viewport_width", "reduced_motion", "save_data",
  "engine", "engine_version", "os", "mobile", "country", "write_key_hash", "open_until", "protocol",
];

/** Inserts only while the day has fewer rows than the cap, in one statement, so concurrent creations cannot pass it. */
const INSERT_RUN_SQL = `INSERT INTO lab_runs (${RUN_COLUMNS.join(", ")})
SELECT ${RUN_COLUMNS.map(() => "?").join(", ")}
WHERE (SELECT COUNT(*) FROM lab_runs WHERE created_day = ?) < ?`;

/** Every condition for a write sits in the WHERE clause, so concurrent steps cannot pass MAX_STEPS or reopen a run. */
const APPEND_WHERE = `WHERE id = ? AND write_key_hash = ? AND completed = 0 AND step_count < ${MAX_STEPS} AND open_until >= ?`;
const APPEND_SET = "steps = json_insert(steps, '$[#]', json(?)), step_count = step_count + 1";
const APPEND_STEP_SQL = `UPDATE lab_runs SET ${APPEND_SET} ${APPEND_WHERE}`;
/** The last step also closes the run: no key, no window, no time of day left on the row. */
const APPEND_LAST_STEP_SQL = `UPDATE lab_runs SET ${APPEND_SET}, completed = 1, write_key_hash = NULL, open_until = NULL ${APPEND_WHERE}`;
const RUN_STATE_SQL = "SELECT write_key_hash, completed, step_count, open_until FROM lab_runs WHERE id = ?";

export const LAB_RETENTION_SQL = "DELETE FROM lab_runs WHERE created_day < ?";
export const CLOSE_EXPIRED_RUNS_SQL = "UPDATE lab_runs SET write_key_hash = NULL, open_until = NULL WHERE open_until < ?";

const hex = (bytes: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

function dailyCap(env: Env): number {
  const cap = Number(env.LAB_DAILY_CAP);
  return Number.isInteger(cap) && cap >= 0 ? cap : DEFAULT_DAILY_CAP;
}

/** Column values in RUN_COLUMNS order. */
function runRow(run: LabRunRequest, request: Request, id: string, keyHash: string, nowMs: number): (string | number | null)[] {
  const cf = request.cf as { country?: unknown } | undefined;
  const client = deriveClient(request.headers, cf?.country);
  const d = run.device;
  return [
    id,
    utcDay(nowMs),
    run.lib,
    run.cal,
    d.score,
    d.cold,
    d.warm,
    d.tickMs,
    ...KERNELS.map((k) => d.kernels[k]),
    d.cores,
    d.memoryGb,
    d.refreshHz,
    d.dpr,
    d.viewportWidth,
    d.reducedMotion ? 1 : 0,
    d.saveData ? 1 : 0,
    client.engine,
    client.engineVersion,
    client.os,
    client.mobile ? 1 : 0,
    client.country,
    keyHash,
    Math.floor(nowMs / 1000) + RUN_OPEN_SECONDS,
    run.protocol,
  ];
}

/** POST /api/lab/runs */
export async function handleLabRuns(request: Request, env: Env, url: URL, nowMs: number): Promise<Response> {
  if (request.method !== "POST") return status(405);
  if (!sameOrigin(request, url)) return status(403);
  const body = await readJson(request, RUN_BODY_BYTES, ["application/json"]);
  if (body instanceof Response) return body;
  const run = validateLabRun(body.json);
  if (!run) return status(400);
  if (!(await verifyTurnstile(env.TURNSTILE_SECRET_KEY, run.turnstile))) return status(403);
  const id = crypto.randomUUID();
  const key = hex(crypto.getRandomValues(new Uint8Array(32)));
  try {
    const row = runRow(run, request, id, await sha256Hex(key), nowMs);
    const result = await env.DB.prepare(INSERT_RUN_SQL).bind(...row, utcDay(nowMs), dailyCap(env)).run();
    if (result.meta.changes !== 1) return status(429);
  } catch {
    return status(503);
  }
  return new Response(JSON.stringify({ run: id, key, maxSteps: MAX_STEPS, expiresIn: RUN_OPEN_SECONDS }), {
    status: 201,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

/** POST /api/lab/runs/<run>/steps */
export async function handleLabSteps(request: Request, env: Env, url: URL, runId: string, nowMs: number): Promise<Response> {
  if (!RUN_ID.test(runId)) return status(404);
  if (request.method !== "POST") return status(405);
  if (!sameOrigin(request, url)) return status(403);
  const body = await readJson(request, STEP_BODY_BYTES, ["application/json"]);
  if (body instanceof Response) return body;
  const step = validateLabStep(body.json);
  if (!step) return status(400);
  const keyHash = await sha256Hex(step.key);
  const now = Math.floor(nowMs / 1000);
  try {
    const sql = step.done ? APPEND_LAST_STEP_SQL : APPEND_STEP_SQL;
    const result = await env.DB.prepare(sql).bind(JSON.stringify(step.step), runId, keyHash, now).run();
    if (result.meta.changes === 1) return status(204);
    // Nothing written: find out why, for the status only.
    const run = await env.DB.prepare(RUN_STATE_SQL).bind(runId).first<{ write_key_hash: string | null; completed: number; step_count: number; open_until: number | null }>();
    if (!run) return status(404);
    if (run.completed !== 0 || run.open_until === null || run.open_until < now || run.step_count >= MAX_STEPS) return status(409);
    return status(403);
  } catch {
    return status(503);
  }
}
