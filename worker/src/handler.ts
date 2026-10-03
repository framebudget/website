import calibration from "../calibration.json";
import { deriveClient } from "./client";
import { KERNELS, validateReport, type Report } from "./validate";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
}

export const MAX_BODY_BYTES = 4096;
export const RETENTION_DAYS = 400;
const CALIBRATION_MAX_AGE = 3600;
const DAY_MS = 86400000;

const CALIBRATION_BODY = JSON.stringify(calibration);

const INSERT_SQL = `INSERT INTO reports (
  created_day, cal, score, cold, warm, tick_ms,
  kernel_float, kernel_typed, kernel_alloc, kernel_path,
  cores, memory_gb, pressure, reduced_motion, tier, effects, stepped, fps, fps_main,
  engine, engine_version, os, mobile, country
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export const RETENTION_SQL = "DELETE FROM reports WHERE created_day < ?";

/** UTC `YYYY-MM-DD` of a timestamp. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Bare status, no body, no details. */
const status = (code: number) => new Response(null, { status: code });

/**
 * Same-origin check: the Origin header must equal the request origin. Some
 * browsers omit Origin on same-origin beacons; Sec-Fetch-Site then vouches.
 */
function sameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null) return origin === url.origin;
  return request.headers.get("sec-fetch-site") === "same-origin";
}

/** Reads at most `limit` bytes; returns null (and stops reading) past it. */
async function readLimited(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

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

async function handleReport(request: Request, env: Env, url: URL, nowMs: number): Promise<Response> {
  if (request.method !== "POST") return status(405);
  if (!sameOrigin(request, url)) return status(403);
  const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "text/plain" && type !== "application/json") return status(415);
  const length = request.headers.get("content-length");
  if (length !== null && !(Number(length) <= MAX_BODY_BYTES)) return status(413);
  if (!request.body) return status(400);
  const bytes = await readLimited(request.body, MAX_BODY_BYTES);
  if (!bytes) return status(413);
  let report: Report | null;
  try {
    report = validateReport(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)));
  } catch {
    return status(400);
  }
  if (!report) return status(400);
  try {
    await env.DB.prepare(INSERT_SQL).bind(...reportRow(report, request, nowMs)).run();
  } catch {
    return status(503);
  }
  return status(204);
}

async function handleCalibration(request: Request, url: URL, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "GET") return status(405);
  // One cache entry regardless of query string.
  const key = new Request(url.origin + "/api/calibration");
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) return hit;
  const response = new Response(CALIBRATION_BODY, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${CALIBRATION_MAX_AGE}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
  ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}

export async function handleFetch(request: Request, env: Env, ctx: ExecutionContext, nowMs: number): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/report") return handleReport(request, env, url, nowMs);
  if (url.pathname === "/api/calibration") return handleCalibration(request, url, ctx);
  if (url.pathname.startsWith("/api/")) return status(404);
  // No asset matched; let the asset layer answer (404).
  return env.ASSETS.fetch(request);
}

/** Rows whose created_day is before this day are deleted: anything older than RETENTION_DAYS days. */
export function retentionCutoff(nowMs: number): string {
  return utcDay(nowMs - RETENTION_DAYS * DAY_MS);
}

export async function runRetention(env: Env, nowMs: number): Promise<void> {
  await env.DB.prepare(RETENTION_SQL).bind(retentionCutoff(nowMs)).run();
}
