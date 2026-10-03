import { beforeEach, describe, expect, it } from "vitest";
import calibration from "../calibration.json";
import { handleFetch, MAX_BODY_BYTES, retentionCutoff, runRetention } from "../src/handler";
import worker from "../src/index";
import { beacon, CHROME_ANDROID_UA, installCache, makeCtx, makeEnv, ORIGIN, validReport } from "./helpers";

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

  it("never stores the user agent, IP or city", async () => {
    const { env, db } = makeEnv();
    await handleFetch(beacon(), env, makeCtx().ctx, NOW);
    const stored = JSON.stringify(db.statements.map((s) => s.params));
    expect(stored).not.toContain("203.0.113.7");
    expect(stored).not.toContain("Mozilla");
    expect(stored).not.toContain(CHROME_ANDROID_UA.slice(13, 40));
    expect(stored).not.toContain("Florianopolis");
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

  it("accepts application/json and a same-origin beacon without Origin", async () => {
    const json = await send(beacon({ headers: { "content-type": "application/json" } }));
    expect(json.response.status).toBe(204);
    const request = beacon({ headers: { "sec-fetch-site": "same-origin" } });
    request.headers.delete("origin");
    expect((await send(request)).response.status).toBe(204);
  });

  it("accepts a body of exactly the limit", async () => {
    expect((await send(beacon({ body: paddedBody(MAX_BODY_BYTES) }))).response.status).toBe(204);
  });

  it.each<[string, () => Request, number]>([
    ["cross origin", () => beacon({ headers: { origin: "https://evil.example" } }), 403],
    ["other subdomain", () => beacon({ headers: { origin: "https://www.framebudget.dev" } }), 403],
    ["http origin", () => beacon({ headers: { origin: "http://framebudget.dev" } }), 403],
    ["null origin", () => beacon({ headers: { origin: "null" } }), 403],
    [
      "no origin, cross-site fetch",
      () => {
        const r = beacon({ headers: { "sec-fetch-site": "cross-site" } });
        r.headers.delete("origin");
        return r;
      },
      403,
    ],
    [
      "no origin, no fetch metadata",
      () => {
        const r = beacon();
        r.headers.delete("origin");
        return r;
      },
      403,
    ],
    ["GET", () => beacon({ method: "GET" }), 405],
    ["PUT", () => beacon({ method: "PUT" }), 405],
    ["form content type", () => beacon({ headers: { "content-type": "application/x-www-form-urlencoded" } }), 415],
    ["missing content type", () => new Request(ORIGIN + "/api/report", { method: "POST", headers: { origin: ORIGIN } }), 415],
    ["declared length over limit", () => beacon({ headers: { "content-length": String(MAX_BODY_BYTES + 1) } }), 413],
    ["actual body over limit", () => beacon({ body: paddedBody(MAX_BODY_BYTES + 1) }), 413],
    ["understated length", () => beacon({ body: paddedBody(10000), headers: { "content-length": "100" } }), 413],
    ["invalid JSON", () => beacon({ body: "{" }), 400],
    ["extra key", () => beacon({ body: JSON.stringify({ ...validReport(), url: "/x" }) }), 400],
    ["wrong type", () => beacon({ body: JSON.stringify({ ...validReport(), score: "62" }) }), 400],
    ["out of range", () => beacon({ body: JSON.stringify({ ...validReport(), score: 1e9 }) }), 400],
    ["empty body", () => beacon({ body: "" }), 400],
    ["trailing slash", () => beacon({ path: "/api/report/" }), 404],
  ])("rejects %s with a bare status and no row", async (_name, make, code) => {
    const { response, rows } = await send(make());
    expect(response.status).toBe(code);
    expect(await response.text()).toBe("");
    expect(rows).toEqual([]);
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

  it("uses the UTC day of the run", async () => {
    // 00:30 UTC: the cutoff is 400 days before this UTC day, not the previous local day.
    expect(retentionCutoff(Date.UTC(2026, 9, 3, 0, 30))).toBe("2025-08-29");
    const { env, db } = makeEnv();
    await runRetention(env, NOW);
    expect(db.statements).toEqual([{ sql: "DELETE FROM reports WHERE created_day < ?", params: ["2025-08-29"] }]);
  });
});
