import { beforeEach, describe, expect, it } from "vitest";
import calibration from "../calibration.json";
import {
  DEFAULT_REPORT_DAILY_CAP,
  handleFetch,
  handleFetchSafely,
  MAX_BODY_BYTES,
  REPORT_LIMIT_KEY,
  retentionCutoff,
  runRetention,
  secondsToUtcMidnight,
  type Env,
} from "../src/handler";
import { CALIBRATION_LOG_RETENTION_SQL } from "../src/calibration/store.ts";
import worker from "../src/index";
import { beacon, CHROME_ANDROID_UA, installCache, makeCtx, makeEnv, ORIGIN, validReport } from "./helpers";

/** Any other site that turned sharing on. */
const OTHER_ORIGIN = "https://example.com";

/** `request` as sent from `origin` (null: no Origin header) with `Sec-Fetch-Site: site` (null: no fetch metadata). */
function from(request: Request, origin: string | null, site: string | null): Request {
  if (origin === null) request.headers.delete("origin");
  else request.headers.set("origin", origin);
  if (site === null) request.headers.delete("sec-fetch-site");
  else request.headers.set("sec-fetch-site", site);
  return request;
}

const NOW = Date.UTC(2026, 9, 3, 23, 59, 30);

async function send(request: Request) {
  const { env, db, assetRequests } = makeEnv();
  const { ctx } = makeCtx();
  const response = await handleFetch(request, env, ctx, NOW);
  return { response, rows: db.rows(), assetRequests };
}

/** A valid report body padded with JSON whitespace to exactly `bytes` bytes. */
function paddedBody(bytes: number): string {
  const json = JSON.stringify(validReport());
  return json + " ".repeat(bytes - json.length);
}

describe("POST /api/report", () => {
  it("stores one row of coarse fields and answers 204 with no body", async () => {
    const { response, rows } = await send(beacon());
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(rows).toEqual([
      {
        id: 1,
        created_day: "2026-10-03",
        cal: "provisional-1",
        score: 62,
        cold: 48,
        warm: 66,
        tick_ms: 0.1,
        kernel_float: 7130,
        kernel_typed: 151000,
        kernel_alloc: 18200,
        kernel_path: 3010,
        cores: 8,
        memory_gb: 4,
        pressure: "nominal",
        reduced_motion: 0,
        tier: "Medium",
        effects: '["canvasLowRes","entrances","hover"]',
        stepped: "[]",
        fps: '{"main":58,"canvasLowRes":55}',
        fps_main: 58,
        engine: "blink",
        engine_version: 130,
        os: "android",
        mobile: 1,
        country: "BR",
      },
    ]);
  });

  it("never stores the user agent, IP, city or the sending site", async () => {
    const { env, db } = makeEnv();
    await handleFetch(from(beacon(), OTHER_ORIGIN, "cross-site"), env, makeCtx().ctx, NOW);
    expect(db.rows()).toHaveLength(1);
    const stored = JSON.stringify(db.statements.map((s) => s.params));
    expect(stored).not.toContain("203.0.113.7");
    expect(stored).not.toContain("Mozilla");
    expect(stored).not.toContain(CHROME_ANDROID_UA.slice(13, 40));
    expect(stored).not.toContain("Florianopolis");
    expect(stored).not.toContain("example");
  });

  it("stores NULL for absent optional values", async () => {
    const r = validReport();
    Object.assign(r, { cold: null, warm: null, tickMs: null, kernels: {}, hints: { reducedMotion: true }, fps: {} });
    const { response, rows } = await send(beacon({ body: JSON.stringify(r), cf: {} }));
    expect(response.status).toBe(204);
    expect(rows[0]).toMatchObject({
      warm: null,
      kernel_float: null,
      cores: null,
      memory_gb: null,
      pressure: null,
      reduced_motion: 1,
      fps_main: null,
      country: null,
    });
  });

  it("accepts application/json", async () => {
    const json = await send(beacon({ headers: { "content-type": "application/json" } }));
    expect(json.response.status).toBe(204);
  });

  it.each<[string, string | null, string | null]>([
    ["the site itself", ORIGIN, "same-origin"],
    ["the site itself without Origin", null, "same-origin"],
    ["another site", OTHER_ORIGIN, "cross-site"],
    ["a subdomain", "https://www.framebudget.dev", "same-site"],
    ["an http origin", "http://localhost:5173", "cross-site"],
    ["an opaque origin", "null", "cross-site"],
    ["no Origin, cross-site", null, "cross-site"],
    ["no Origin, no fetch metadata", null, null],
  ])("stores a report from %s, readable by any origin", async (_name, origin, site) => {
    const { response, rows } = await send(from(beacon(), origin, site));
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(rows).toHaveLength(1);
  });

  it("accepts a body of exactly the limit from another site", async () => {
    expect((await send(from(beacon({ body: paddedBody(MAX_BODY_BYTES) }), OTHER_ORIGIN, "cross-site"))).response.status).toBe(204);
  });

  it("answers the CORS preflight of a cross-origin fetch without storing anything", async () => {
    const preflight = new Request(ORIGIN + "/api/report", {
      method: "OPTIONS",
      headers: { origin: OTHER_ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
    const { response, rows } = await send(preflight);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(Object.fromEntries(response.headers)).toEqual({
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST",
      "access-control-allow-headers": "Content-Type",
      "access-control-max-age": "86400",
    });
    expect(rows).toEqual([]);
  });

  describe.each([
    ["same origin", ORIGIN, "same-origin"],
    ["cross origin", OTHER_ORIGIN, "cross-site"],
  ])("%s", (_origin, origin, site) => {
    it.each<[string, () => Request, number]>([
      ["GET", () => beacon({ method: "GET" }), 405],
      ["PUT", () => beacon({ method: "PUT" }), 405],
      ["form content type", () => beacon({ headers: { "content-type": "application/x-www-form-urlencoded" } }), 415],
      ["missing content type", () => new Request(ORIGIN + "/api/report", { method: "POST" }), 415],
      ["declared length over limit", () => beacon({ headers: { "content-length": String(MAX_BODY_BYTES + 1) } }), 413],
      ["actual body over limit", () => beacon({ body: paddedBody(MAX_BODY_BYTES + 1) }), 413],
      ["understated length", () => beacon({ body: paddedBody(10000), headers: { "content-length": "100" } }), 413],
      ["invalid JSON", () => beacon({ body: "{" }), 400],
      ["extra key", () => beacon({ body: JSON.stringify({ ...validReport(), url: "/x" }) }), 400],
      ["wrong type", () => beacon({ body: JSON.stringify({ ...validReport(), score: "62" }) }), 400],
      ["out of range", () => beacon({ body: JSON.stringify({ ...validReport(), score: 1e9 }) }), 400],
      ["empty body", () => beacon({ body: "" }), 400],
    ])("rejects %s with a bare status and no row", async (_name, make, code) => {
      const { response, rows } = await send(from(make(), origin, site));
      expect(response.status).toBe(code);
      expect(await response.text()).toBe("");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(rows).toEqual([]);
    });
  });

  it("answers a path with a trailing slash with a bare 404", async () => {
    const { response, rows } = await send(beacon({ path: "/api/report/" }));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(rows).toEqual([]);
  });
});

describe("POST /api/report rate limits", () => {
  /** Sends `request` with `env` at `nowMs` (NOW by default). */
  const post = (env: Env, request = beacon(), nowMs = NOW) => handleFetch(request, env, makeCtx().ctx, nowMs);

  it("keys the burst limit by a constant, whoever sends", async () => {
    const { env, limiter } = makeEnv();
    await post(env, from(beacon({ headers: { "cf-connecting-ip": "198.51.100.1" } }), OTHER_ORIGIN, "cross-site"));
    await post(env, beacon({ headers: { "cf-connecting-ip": "198.51.100.2" } }));
    expect(limiter.keys).toEqual([REPORT_LIMIT_KEY, REPORT_LIMIT_KEY]);
    expect(REPORT_LIMIT_KEY).toBe("report");
  });

  it("answers 429 past the burst limit, readable by any origin, with Retry-After 60 and nothing read or written", async () => {
    const { env, db, limiter } = makeEnv();
    limiter.success = false;
    const response = await post(env, from(beacon(), OTHER_ORIGIN, "cross-site"));
    expect(response.status).toBe(429);
    expect(await response.text()).toBe("");
    expect(Object.fromEntries(response.headers)).toEqual({ "access-control-allow-origin": "*", "retry-after": "60" });
    expect(db.statements).toEqual([]);
    expect(db.rows()).toEqual([]);
  });

  it("checks method and content type before the burst limit, and the body after it", async () => {
    const { env, limiter } = makeEnv();
    limiter.success = false;
    expect((await post(env, beacon({ method: "GET" }))).status).toBe(405);
    expect((await post(env, beacon({ headers: { "content-type": "application/x-www-form-urlencoded" } }))).status).toBe(415);
    expect(limiter.keys).toEqual([]);
    expect((await post(env, beacon({ body: "{" }))).status).toBe(429);
    expect((await post(env, beacon({ body: paddedBody(MAX_BODY_BYTES + 1) }))).status).toBe(429);
    limiter.success = true;
    expect((await post(env, beacon({ body: "{" }))).status).toBe(400);
    expect((await post(env, beacon({ body: paddedBody(MAX_BODY_BYTES + 1) }))).status).toBe(413);
  });

  it("leaves the preflight, the calibration and the lab out of the burst limit", async () => {
    installCache();
    const { env, limiter } = makeEnv();
    limiter.success = false;
    const preflight = new Request(ORIGIN + "/api/report", { method: "OPTIONS", headers: { origin: OTHER_ORIGIN } });
    expect((await post(env, preflight)).status).toBe(204);
    expect((await post(env, new Request(ORIGIN + "/api/calibration"))).status).toBe(200);
    expect((await post(env, new Request(ORIGIN + "/api/lab/runs", { method: "POST", headers: { origin: OTHER_ORIGIN } }))).status).toBe(403);
    expect(limiter.keys).toEqual([]);
  });

  it("stores exactly REPORT_DAILY_CAP reports a day, then answers 429 until UTC midnight and writes nothing", async () => {
    const { env, db } = makeEnv();
    env.REPORT_DAILY_CAP = "3";
    for (let i = 0; i < 3; i++) expect((await post(env)).status).toBe(204);
    expect(db.rows()).toHaveLength(3);
    expect(db.reportDays()).toEqual([{ day: "2026-10-03", n: 3 }]);
    const changes = db.totalChanges();
    const response = await post(env, from(beacon(), OTHER_ORIGIN, "cross-site"));
    expect(response.status).toBe(429);
    expect(await response.text()).toBe("");
    // NOW is 23:59:30 UTC.
    expect(Object.fromEntries(response.headers)).toEqual({ "access-control-allow-origin": "*", "retry-after": "30" });
    expect(db.totalChanges()).toBe(changes);
    expect(db.rows()).toHaveLength(3);
    expect(db.reportDays()).toEqual([{ day: "2026-10-03", n: 3 }]);
  });

  it("never passes the cap under concurrent requests", async () => {
    const { env, db } = makeEnv();
    env.REPORT_DAILY_CAP = "5";
    const statuses = await Promise.all(Array.from({ length: 12 }, () => post(env).then((r) => r.status)));
    expect(statuses.filter((s) => s === 204)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(7);
    expect(db.rows()).toHaveLength(5);
    expect(db.reportDays()).toEqual([{ day: "2026-10-03", n: 5 }]);
  });

  it("starts every UTC day at 0", async () => {
    const { env, db } = makeEnv();
    env.REPORT_DAILY_CAP = "2";
    for (let i = 0; i < 3; i++) await post(env);
    expect((await post(env)).status).toBe(429);
    // 30 seconds later it is 2026-10-04 UTC.
    expect((await post(env, beacon(), NOW + 30000)).status).toBe(204);
    expect(db.reportDays()).toEqual([
      { day: "2026-10-03", n: 2 },
      { day: "2026-10-04", n: 1 },
    ]);
    expect(db.rows().map((r) => r.created_day)).toEqual(["2026-10-03", "2026-10-03", "2026-10-04"]);
  });

  it("closes reports with a cap of 0 and falls back to the default cap when the var is not a whole number", async () => {
    const closed = makeEnv();
    closed.env.REPORT_DAILY_CAP = "0";
    expect((await post(closed.env)).status).toBe(429);
    expect(closed.db.rows()).toEqual([]);
    for (const value of ["lots", "1.5", "-1"]) {
      const { env, db } = makeEnv();
      env.REPORT_DAILY_CAP = value;
      db.db.prepare("INSERT INTO report_days (day, n) VALUES ('2026-10-03', ?)").run(DEFAULT_REPORT_DAILY_CAP - 1);
      expect((await post(env)).status).toBe(204);
      expect((await post(env)).status).toBe(429);
    }
  });

  it("answers 503 and stores nothing when D1 fails", async () => {
    const { env, db } = makeEnv();
    env.DB.batch = async () => {
      throw new Error("D1 down");
    };
    const response = await post(env);
    expect(response.status).toBe(503);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(db.rows()).toEqual([]);
  });

  it.each([
    [Date.UTC(2026, 9, 3), 86400],
    [Date.UTC(2026, 9, 3, 12), 43200],
    [Date.UTC(2026, 9, 3, 23, 59, 59, 500), 1],
  ])("tells a client at %d to retry in %d seconds", (nowMs, seconds) => {
    expect(secondsToUtcMidnight(nowMs)).toBe(seconds);
  });
});

describe("GET /api/calibration", () => {
  let store: Map<string, Response>;
  beforeEach(() => {
    store = installCache();
  });

  it("returns the checked-in patch, cacheable for an hour, and fills the edge cache", async () => {
    const { env } = makeEnv();
    const { ctx, pending } = makeCtx();
    const response = await handleFetch(new Request(ORIGIN + "/api/calibration?x=1"), env, ctx, NOW);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual(calibration);
    await Promise.all(pending);
    expect([...store.keys()]).toEqual([ORIGIN + "/api/calibration"]);
  });

  it("lets any origin read it, without credentials, from the edge cache too", async () => {
    const { env } = makeEnv();
    const { ctx, pending } = makeCtx();
    const request = () => new Request(ORIGIN + "/api/calibration", { headers: { origin: OTHER_ORIGIN, "sec-fetch-site": "cross-site" } });
    const response = await handleFetch(request(), env, ctx, NOW);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    expect(response.headers.get("vary")).toBeNull();
    await Promise.all(pending);
    const cached = await handleFetch(request(), env, makeCtx().ctx, NOW);
    expect(cached.headers.get("access-control-allow-origin")).toBe("*");
    expect(await cached.json()).toEqual(calibration);
  });

  it("serves later requests from the cache", async () => {
    store.set(ORIGIN + "/api/calibration", new Response('{"cached":true}'));
    const { env } = makeEnv();
    const response = await handleFetch(new Request(ORIGIN + "/api/calibration"), env, makeCtx().ctx, NOW);
    expect(await response.json()).toEqual({ cached: true });
  });

  it("rejects other methods", async () => {
    const { env } = makeEnv();
    const response = await handleFetch(new Request(ORIGIN + "/api/calibration", { method: "POST" }), env, makeCtx().ctx, NOW);
    expect(response.status).toBe(405);
  });
});

describe("routing", () => {
  it("answers unknown /api/ paths with a bare 404", async () => {
    const { response, assetRequests } = await send(new Request(ORIGIN + "/api/reports"));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(assetRequests).toEqual([]);
  });

  it("hands other paths to the asset layer", async () => {
    const { response, assetRequests } = await send(new Request(ORIGIN + "/missing"));
    expect(response.status).toBe(404);
    expect(assetRequests.map((r) => r.url)).toEqual([ORIGIN + "/missing"]);
  });

  it("keeps the lab same-origin: no CORS headers and no preflight answer", async () => {
    for (const path of ["/api/lab/runs", "/api/lab/runs/0b6f3a52-6c1d-4e8a-9f2b-1c3d5e7f9a0b/steps"]) {
      const post = await send(from(beacon({ path, headers: { "content-type": "application/json" } }), OTHER_ORIGIN, "cross-site"));
      expect(post.response.status).toBe(403);
      expect(post.response.headers.get("access-control-allow-origin")).toBeNull();
      const preflight = await send(new Request(ORIGIN + path, { method: "OPTIONS", headers: { origin: OTHER_ORIGIN } }));
      expect(preflight.response.status).toBe(405);
      expect(preflight.response.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
});

describe("uncaught errors", () => {
  const PAGE = "text/html,application/xhtml+xml,*/*;q=0.8";
  const ERROR_PAGE = "<!doctype html><title>Something went wrong</title>";

  /** An asset layer whose /500 is the error page and where any other path fails. */
  const failingAssets = async (request: Request) => {
    if (new URL(request.url).pathname !== "/500") throw new Error("asset layer down");
    return new Response(ERROR_PAGE, { headers: { "content-type": "text/html; charset=utf-8", etag: '"abc"', "cache-control": "public, max-age=0, must-revalidate" } });
  };

  it("answer a page load with the 500 page, never cached", async () => {
    const { env, assetRequests } = makeEnv(undefined, failingAssets);
    const response = await handleFetchSafely(new Request(ORIGIN + "/boom", { headers: { accept: PAGE } }), env, makeCtx().ctx, NOW);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe(ERROR_PAGE);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("etag")).toBeNull();
    expect(assetRequests.map((r) => [r.method, r.url])).toEqual([
      ["GET", ORIGIN + "/boom"],
      ["GET", ORIGIN + "/500"],
    ]);
  });

  it("answer an API call with a bare 500, even when it accepts HTML", async () => {
    const caches = {
      default: {
        match: async () => {
          throw new Error("cache down");
        },
      },
    };
    Object.assign(globalThis, { caches });
    const { env, assetRequests } = makeEnv(undefined, failingAssets);
    const response = await handleFetchSafely(new Request(ORIGIN + "/api/calibration", { headers: { accept: PAGE } }), env, makeCtx().ctx, NOW);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("");
    expect(assetRequests).toEqual([]);
  });

  it("answer a request that does not accept HTML with a bare 500", async () => {
    const { env, assetRequests } = makeEnv(undefined, failingAssets);
    const response = await handleFetchSafely(new Request(ORIGIN + "/boom.js", { headers: { accept: "*/*" } }), env, makeCtx().ctx, NOW);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("");
    expect(assetRequests.map((r) => r.url)).toEqual([ORIGIN + "/boom.js"]);
  });

  it("answer with a bare 500 when the 500 page cannot be served either", async () => {
    const { env } = makeEnv(undefined, async () => {
      throw new Error("asset layer down");
    });
    const response = await handleFetchSafely(new Request(ORIGIN + "/boom", { headers: { accept: PAGE } }), env, makeCtx().ctx, NOW);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("");
  });
});

describe("retention", () => {
  it("deletes days older than 400 days and keeps the boundary day", async () => {
    const { env, db } = makeEnv();
    const insert = db.db.prepare(
      "INSERT INTO reports (created_day, cal, score, reduced_motion, tier, effects, stepped, fps, engine, os, mobile) VALUES (?, 'c', 1, 0, 'Lite', '[]', '[]', '{}', 'other', 'other', 0)",
    );
    for (const day of ["2025-08-27", "2025-08-28", "2025-08-29", "2025-08-30", "2026-10-03"]) insert.run(day);
    expect(retentionCutoff(NOW)).toBe("2025-08-29");
    await worker.scheduled({ scheduledTime: NOW, cron: "17 3 * * *", noRetry: () => undefined }, env);
    expect(db.rows().map((r) => r.created_day)).toEqual(["2025-08-29", "2025-08-30", "2026-10-03"]);
  });

  it("deletes the daily report counts past retention", async () => {
    const { env, db } = makeEnv();
    const insert = db.db.prepare("INSERT INTO report_days (day, n) VALUES (?, 1)");
    for (const day of ["2025-08-28", "2025-08-29", "2026-10-03"]) insert.run(day);
    await runRetention(env, NOW);
    expect(db.reportDays().map((r) => r.day)).toEqual(["2025-08-29", "2026-10-03"]);
  });

  it("uses the UTC day of the run", async () => {
    // 00:30 UTC: the cutoff is 400 days before this UTC day, not the previous local day.
    expect(retentionCutoff(Date.UTC(2026, 9, 3, 0, 30))).toBe("2025-08-29");
    const { env, db } = makeEnv();
    await runRetention(env, NOW);
    expect(db.statements).toEqual([
      { sql: "DELETE FROM reports WHERE created_day < ?", params: ["2025-08-29"] },
      { sql: "DELETE FROM report_days WHERE day < ?", params: ["2025-08-29"] },
      { sql: "DELETE FROM lab_runs WHERE created_day < ?", params: ["2025-08-29"] },
      { sql: "UPDATE lab_runs SET write_key_hash = NULL, open_until = NULL WHERE open_until < ?", params: [Math.floor(NOW / 1000)] },
      { sql: CALIBRATION_LOG_RETENTION_SQL, params: [Date.UTC(2025, 7, 29) / 1000] },
    ]);
  });
});
