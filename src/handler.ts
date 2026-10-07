import calibration from "../calibration.json";
import { autoCalibrationOn, runAutoCalibration } from "./calibration/cron.ts";
import { deepMerge } from "./calibration/patch.ts";
import { CALIBRATION_LOG_RETENTION_SQL, latestAutoPatch } from "./calibration/store.ts";
import { deriveClient } from "./client";
import { allowAnyOrigin, hasContentType, readJson, status, utcDay } from "./http";
import { CLOSE_EXPIRED_RUNS_SQL, handleLabRuns, handleLabSteps, LAB_RETENTION_SQL, STEPS_PATH } from "./lab";
import { KERNELS, validateReport, type Report } from "./validate";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** Turnstile secret for the lab (a secret on the deployed Worker, .dev.vars locally). */
  TURNSTILE_SECRET_KEY: string;
  /** Most lab runs created per UTC day (a var in wrangler.jsonc). */
  LAB_DAILY_CAP: string;
  /** Kill switch of the daily auto calibration (a var in wrangler.jsonc): "on" runs it and serves its patch. */
  AUTO_CALIBRATION: string;
  /** Burst limit of POST /api/report (a ratelimits binding in wrangler.jsonc), keyed by a constant. */
  REPORT_LIMIT: RateLimit;
  /** Most reports stored per UTC day (a var in wrangler.jsonc). */
  REPORT_DAILY_CAP: string;
}

export const MAX_BODY_BYTES = 4096;
export const RETENTION_DAYS = 400;
const CALIBRATION_MAX_AGE = 3600;
const DAY_MS = 86400000;
/** Used when REPORT_DAILY_CAP is missing or not a whole number. */
export const DEFAULT_REPORT_DAILY_CAP = 6000;
/** The one key of the burst limit: never anything about the sender (no IP, see the privacy page). */
export const REPORT_LIMIT_KEY = "report";
const REPORT_TYPES = ["text/plain", "application/json"];
/** Preflight answer of POST /api/report, cached by the browser for a day. */
const REPORT_PREFLIGHT = {
  "Access-Control-Allow-Methods": "POST",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const CALIBRATION_BODY = JSON.stringify(calibration);

/** True while the UTC day (first ?) has stored fewer reports than the cap (second ?). */
const UNDER_DAILY_CAP = "COALESCE((SELECT n FROM report_days WHERE day = ?), 0) < ?";

/** Inserts the report only while the day is under the cap. */
const INSERT_SQL = `INSERT INTO reports (
  created_day, cal, score, cold, warm, tick_ms,
  kernel_float, kernel_typed, kernel_alloc, kernel_path,
  cores, memory_gb, pressure, reduced_motion, tier, effects, stepped, fps, fps_main,
  engine, engine_version, os, mobile, country
) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
WHERE ${UNDER_DAILY_CAP}`;

/**
 * Counts the report under the same condition. Batched after INSERT_SQL, which
 * does not touch report_days, so both see the same count and write together or
 * not at all.
 */
const COUNT_SQL = `INSERT INTO report_days (day, n) SELECT ?, 1
WHERE ${UNDER_DAILY_CAP}
ON CONFLICT (day) DO UPDATE SET n = n + 1`;

export const RETENTION_SQL = "DELETE FROM reports WHERE created_day < ?";
export const REPORT_DAYS_RETENTION_SQL = "DELETE FROM report_days WHERE day < ?";

/** Column values in INSERT_SQL order. */
export function reportRow(report: Report, request: Request, nowMs: number): (string | number | null)[] {
  const cf = request.cf as { country?: unknown } | undefined;
  const client = deriveClient(request.headers, cf?.country);
  const h = report.hints;
  return [
    utcDay(nowMs),
    report.cal,
    report.score,
    report.cold,
    report.warm,
    report.tickMs,
    ...KERNELS.map((k) => report.kernels[k] ?? null),
    h.cores ?? null,
    h.memoryGb ?? null,
    h.pressure ?? null,
    h.reducedMotion ? 1 : 0,
    report.tier,
    JSON.stringify(report.effects),
    JSON.stringify(report.stepped),
    JSON.stringify(report.fps),
    report.fps.main ?? null,
    client.engine,
    client.engineVersion,
    client.os,
    client.mobile ? 1 : 0,
    client.country,
  ];
}

/**
 * Public: the library sends reports here from every site that turned sharing
 * on, so there is no origin check. A sendBeacon string is a CORS simple request
 * (text/plain, no preflight); OPTIONS answers the preflight of a fetch that
 * sends application/json. Method, content type, size and schema stay strict.
 * Every answer, errors included, may be read by any origin. Volume is bounded
 * by a burst limit (REPORT_LIMIT) and a daily budget (REPORT_DAILY_CAP); past
 * either the answer is 429 with Retry-After and nothing is stored.
 */
async function handleReport(request: Request, env: Env, nowMs: number): Promise<Response> {
  if (request.method === "OPTIONS") return allowAnyOrigin(new Response(null, { status: 204, headers: REPORT_PREFLIGHT }));
  return allowAnyOrigin(await storeReport(request, env, nowMs));
}

function reportDailyCap(env: Env): number {
  const cap = Number(env.REPORT_DAILY_CAP);
  return Number.isInteger(cap) && cap >= 0 ? cap : DEFAULT_REPORT_DAILY_CAP;
}

/** Whole seconds from `nowMs` to the next UTC midnight, when the daily budget resets. */
export function secondsToUtcMidnight(nowMs: number): number {
  return Math.ceil(((Math.floor(nowMs / DAY_MS) + 1) * DAY_MS - nowMs) / 1000);
}

async function storeReport(request: Request, env: Env, nowMs: number): Promise<Response> {
  if (request.method !== "POST") return status(405);
  if (!hasContentType(request, REPORT_TYPES)) return status(415);
  // Retry-After is the period of the binding in wrangler.jsonc.
  if (!(await env.REPORT_LIMIT.limit({ key: REPORT_LIMIT_KEY })).success) {
    return new Response(null, { status: 429, headers: { "Retry-After": "60" } });
  }
  const body = await readJson(request, MAX_BODY_BYTES, REPORT_TYPES);
  if (body instanceof Response) return body;
  const report = validateReport(body.json);
  if (!report) return status(400);
  const day = utcDay(nowMs);
  const cap = reportDailyCap(env);
  try {
    // One batch is one transaction: the report and its count are written together, or neither is.
    const [inserted] = await env.DB.batch([
      env.DB.prepare(INSERT_SQL).bind(...reportRow(report, request, nowMs), day, cap),
      env.DB.prepare(COUNT_SQL).bind(day, day, cap),
    ]);
    if (inserted!.meta.changes !== 1) {
      return new Response(null, { status: 429, headers: { "Retry-After": String(secondsToUtcMidnight(nowMs)) } });
    }
  } catch {
    return status(503);
  }
  return status(204);
}

/**
 * Public: the library fetches it without credentials from every site that
 * turned sharing on, so any origin may read it. The header is part of the
 * cached response, the same for every origin, so the cache needs no Vary.
 */
async function handleCalibration(request: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "GET") return status(405);
  // One cache entry regardless of query string.
  const key = new Request(url.origin + "/api/calibration");
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit;
  // calibration.json, with the latest applied auto patch merged in while the kill switch is on.
  // A D1 failure serves calibration.json alone, uncached, so the next request tries again.
  let body = CALIBRATION_BODY;
  let cacheable = true;
  if (autoCalibrationOn(env)) {
    try {
      const patch = await latestAutoPatch(env.DB);
      if (patch) body = JSON.stringify(deepMerge(calibration, patch));
    } catch {
      cacheable = false;
    }
  }
  const response = new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${CALIBRATION_MAX_AGE}`,
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
    },
  });
  if (cacheable) ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}

export async function handleFetch(request: Request, env: Env, ctx: ExecutionContext, nowMs: number): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/report") return handleReport(request, env, nowMs);
  if (url.pathname === "/api/calibration") return handleCalibration(request, env, url, ctx);
  if (url.pathname === "/api/lab/runs") return handleLabRuns(request, env, url, nowMs);
  const steps = STEPS_PATH.exec(url.pathname);
  if (steps) return handleLabSteps(request, env, url, steps[1]!, nowMs);
  if (url.pathname.startsWith("/api/")) return status(404);
  // Only reachable when the Worker is called directly: run_worker_first sends it /api/* alone, and the
  // asset layer answers every other unmatched path with 404.html (not_found_handling: "404-page").
  return env.ASSETS.fetch(request);
}

/**
 * The fetch entry: handleFetch with a safety net. An uncaught error answers a
 * page load with the site's 500 page (docs/500.html) and anything else, the
 * API included, with a bare 500. The page is fetched as /500, the path
 * html_handling serves it under; /500.html would redirect there.
 */
export async function handleFetchSafely(request: Request, env: Env, ctx: ExecutionContext, nowMs: number): Promise<Response> {
  try {
    return await handleFetch(request, env, ctx, nowMs);
  } catch {
    // A browser page load gets the page; API calls and subresources get a bare status.
    const pageLoad = (request.headers.get("accept") ?? "").includes("text/html") && !new URL(request.url).pathname.startsWith("/api/");
    if (!pageLoad) return status(500);
    try {
      const page = await env.ASSETS.fetch(new Request(new URL("/500", request.url)));
      if (!page.ok) return status(500);
      const headers = new Headers(page.headers);
      headers.delete("etag");
      headers.set("cache-control", "no-store");
      return new Response(page.body, { status: 500, headers });
    } catch {
      return status(500);
    }
  }
}

/** Rows whose created_day is before this day are deleted: anything older than RETENTION_DAYS days. */
export function retentionCutoff(nowMs: number): string {
  return utcDay(nowMs - RETENTION_DAYS * DAY_MS);
}

/** Deletes reports, their daily counts, lab runs and calibration log rows past retention, and closes lab runs whose window expired. */
export async function runRetention(env: Env, nowMs: number): Promise<void> {
  const cutoff = retentionCutoff(nowMs);
  await env.DB.prepare(RETENTION_SQL).bind(cutoff).run();
  await env.DB.prepare(REPORT_DAYS_RETENTION_SQL).bind(cutoff).run();
  await env.DB.prepare(LAB_RETENTION_SQL).bind(cutoff).run();
  await env.DB.prepare(CLOSE_EXPIRED_RUNS_SQL).bind(Math.floor(nowMs / 1000)).run();
  await env.DB.prepare(CALIBRATION_LOG_RETENTION_SQL).bind(Date.parse(cutoff + "T00:00:00Z") / 1000).run();
}

/**
 * The daily cron: retention, then the auto calibration, isolated: its errors are
 * swallowed (nothing is logged), so they never fail the job or stop retention.
 * A day without a calibration_log row is the sign of a failed evaluation.
 */
export async function runDaily(env: Env, nowMs: number): Promise<void> {
  await runRetention(env, nowMs);
  try {
    await runAutoCalibration(env, nowMs);
  } catch {
    // Isolated: the next day's run tries again.
  }
}
