import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleFetch, runRetention } from "../src/handler";
import { beacon, CHROME_ANDROID_UA, makeCtx, makeEnv } from "./helpers";

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const NOW_S = NOW / 1000;
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

function labRun(): Record<string, unknown> {
  return {
    turnstile: "XXXX.DUMMY.TOKEN.XXXX",
    lib: "0.2.1",
    cal: "provisional-1",
    device: {
      score: 61.2,
      cold: 48,
      warm: 66.4,
      kernels: { float: 7130, typed: 151000, alloc: 18200, path: 3010 },
      tickMs: 0.1,
      cores: 8,
      memoryGb: 4,
      refreshHz: 60,
      dpr: 2.6,
      viewportWidth: 400,
      reducedMotion: false,
      saveData: false,
    },
  };
}

function labStep(name = "baseline"): Record<string, unknown> {
  return { name, effects: ["baseline", "baseline-end", "all"].includes(name) ? [] : [name], frames: 300, durationMs: 5004, medianMs: 16.7, p95Ms: 18.1, maxMs: 33.4, over: 2 };
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  beacon({ path, body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

let siteverify: { url: string; body: string }[];
let turnstilePasses: boolean;

beforeEach(() => {
  siteverify = [];
  turnstilePasses = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      siteverify.push({ url: String(input), body: String(init?.body) });
      return Response.json({ success: turnstilePasses, "error-codes": turnstilePasses ? [] : ["invalid-input-response"] });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup() {
  const { env, db } = makeEnv();
  const ctx = makeCtx().ctx;
  const send = (request: Request, now = NOW) => handleFetch(request, env, ctx, now);
  const create = async (now = NOW) => {
    const response = await send(post("/api/lab/runs", labRun()), now);
    expect(response.status).toBe(201);
    return (await response.json()) as { run: string; key: string };
  };
  const step = (run: string, body: Record<string, unknown>, now = NOW) => send(post(`/api/lab/runs/${run}/steps`, body), now);
  return { env, db, send, create, step };
}

describe("POST /api/lab/runs", () => {
  it("verifies Turnstile, stores one row and returns the run, a write key and the limits", async () => {
    const { db, send } = setup();
    const response = await send(post("/api/lab/runs", labRun()));
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const created = (await response.json()) as Record<string, unknown>;
    expect(created).toEqual({ run: expect.stringMatching(/^[0-9a-f-]{36}$/), key: expect.stringMatching(/^[0-9a-f]{64}$/), maxSteps: 20, expiresIn: 900 });
    expect(db.labRows()).toEqual([
      {
        id: created.run,
        created_day: "2026-10-03",
        lib: "0.2.1",
        cal: "provisional-1",
        score: 61.2,
        cold: 48,
        warm: 66.4,
        tick_ms: 0.1,
        kernel_float: 7130,
        kernel_typed: 151000,
        kernel_alloc: 18200,
        kernel_path: 3010,
        cores: 8,
        memory_gb: 4,
        refresh_hz: 60,
        dpr: 2.6,
        viewport_width: 400,
        reduced_motion: 0,
        save_data: 0,
        engine: "blink",
        engine_version: 130,
        os: "android",
        mobile: 1,
        country: "BR",
        steps: "[]",
        step_count: 0,
        completed: 0,
        write_key_hash: sha256(created.key as string),
        open_until: NOW_S + 900,
      },
    ]);
    expect(siteverify).toHaveLength(1);
    expect(siteverify[0]!.url).toBe(SITEVERIFY);
    const form = new URLSearchParams(siteverify[0]!.body);
    expect([...form.keys()].sort()).toEqual(["response", "secret"]);
    expect(form.get("response")).toBe("XXXX.DUMMY.TOKEN.XXXX");
  });

  it("never stores or forwards the IP, user agent or city, nor the key itself", async () => {
    const { db, create } = setup();
    const { key } = await create();
    const stored = JSON.stringify([db.statements.map((s) => s.params), db.labRows()]);
    const forwarded = JSON.stringify(siteverify);
    for (const text of [stored, forwarded]) {
      expect(text).not.toContain("203.0.113.7");
      expect(text).not.toContain(CHROME_ANDROID_UA.slice(13, 40));
      expect(text).not.toContain("Florianopolis");
    }
    expect(stored).not.toContain(key);
  });

  it("stores device numbers at the documented precision and NULL for absent values", async () => {
    const run = labRun();
    run.device = {
      ...(run.device as object),
      score: 61.234,
      cold: null,
      warm: null,
      kernels: { float: 7134.9, typed: null, alloc: 18249, path: 3010 },
      tickMs: 0.123,
      cores: null,
      memoryGb: null,
      dpr: 2.625,
      viewportWidth: 412,
      reducedMotion: true,
      saveData: true,
    };
    const { db, send } = setup();
    expect((await send(post("/api/lab/runs", run))).status).toBe(201);
    expect(db.labRows()[0]).toMatchObject({
      score: 61.2,
      cold: null,
      warm: null,
      kernel_float: 7130,
      kernel_typed: null,
      kernel_alloc: 18200,
      tick_ms: 0.12,
      cores: null,
      memory_gb: null,
      dpr: 2.6,
      viewport_width: 400,
      reduced_motion: 1,
      save_data: 1,
    });
  });

  const device = (patch: Record<string, unknown>) => ({ ...labRun(), device: { ...(labRun().device as object), ...patch } });

  it.each<[string, unknown]>([
    ["invalid JSON", "{"],
    ["extra key", { ...labRun(), ip: "1.2.3.4" }],
    ["missing turnstile", { ...labRun(), turnstile: undefined }],
    ["empty turnstile", { ...labRun(), turnstile: "" }],
    ["bad lib", { ...labRun(), lib: "0.2.1; drop" }],
    ["missing device key", device({ saveData: undefined })],
    ["extra device key", device({ userAgent: "x" })],
    ["string score", device({ score: "61.2" })],
    ["negative score", device({ score: -1 })],
    ["missing kernel", device({ kernels: { float: 7130, typed: 151000, alloc: 18200 } })],
    ["zero kernel", device({ kernels: { float: 0, typed: 151000, alloc: 18200, path: 3010 } })],
    ["fractional cores", device({ cores: 2.5 })],
    ["fractional refresh", device({ refreshHz: 59.9 })],
    ["zero refresh", device({ refreshHz: 0 })],
    ["huge dpr", device({ dpr: 100 })],
    ["numeric boolean", device({ reducedMotion: 0 })],
  ])("rejects %s with 400, no Turnstile call and no row", async (_name, body) => {
    const { db, send } = setup();
    const response = await send(post("/api/lab/runs", body));
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("");
    expect(siteverify).toEqual([]);
    expect(db.labRows()).toEqual([]);
  });

  it.each<[string, () => Request, number]>([
    ["cross origin", () => post("/api/lab/runs", labRun(), { origin: "https://evil.example" }), 403],
    ["text/plain", () => post("/api/lab/runs", labRun(), { "content-type": "text/plain;charset=UTF-8" }), 415],
    ["body over 4096 bytes", () => post("/api/lab/runs", JSON.stringify(labRun()) + " ".repeat(4096)), 413],
    ["GET", () => beacon({ path: "/api/lab/runs", method: "GET" }), 405],
  ])("rejects %s", async (_name, make, code) => {
    const { db, send } = setup();
    expect((await send(make())).status).toBe(code);
    expect(siteverify).toEqual([]);
    expect(db.labRows()).toEqual([]);
  });

  it("answers 403 and stores nothing when Turnstile fails", async () => {
    turnstilePasses = false;
    const { db, send } = setup();
    const response = await send(post("/api/lab/runs", labRun()));
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("");
    expect(siteverify).toHaveLength(1);
    expect(db.labRows()).toEqual([]);
  });

  it("answers 403 when siteverify cannot be reached", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("network down");
    });
    const { db, send } = setup();
    expect((await send(post("/api/lab/runs", labRun()))).status).toBe(403);
    expect(db.labRows()).toEqual([]);
  });

  it("answers 429 once the day's cap is reached, counting only today's runs", async () => {
    const { env, db, send } = setup();
    env.LAB_DAILY_CAP = "2";
    const yesterday = NOW - 86400000;
    expect((await send(post("/api/lab/runs", labRun()), yesterday)).status).toBe(201);
    expect((await send(post("/api/lab/runs", labRun()))).status).toBe(201);
    expect((await send(post("/api/lab/runs", labRun()))).status).toBe(201);
    const full = await send(post("/api/lab/runs", labRun()));
    expect(full.status).toBe(429);
    expect(await full.text()).toBe("");
    expect(db.labRows().map((r) => r.created_day)).toEqual(["2026-10-02", "2026-10-03", "2026-10-03"]);
  });
});

describe("POST /api/lab/runs/<run>/steps", () => {
  it("appends each step to the run's row and counts it", async () => {
    const { db, create, step } = setup();
    const { run, key } = await create();
    const first = await step(run, { key, step: labStep("baseline"), done: false });
    expect(first.status).toBe(204);
    expect(await first.text()).toBe("");
    expect((await step(run, { key, step: labStep("canvasLowRes"), done: false })).status).toBe(204);
    const rows = db.labRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ step_count: 2, completed: 0, write_key_hash: sha256(key), open_until: NOW_S + 900 });
    expect(JSON.parse(rows[0]!.steps as string)).toEqual([labStep("baseline"), labStep("canvasLowRes")]);
  });

  it("closes the run on done: no key hash, no window, and later steps get 409", async () => {
    const { db, create, step } = setup();
    const { run, key } = await create();
    expect((await step(run, { key, step: labStep("baseline"), done: false })).status).toBe(204);
    expect((await step(run, { key, step: labStep("baseline-end"), done: true })).status).toBe(204);
    expect(db.labRows()[0]).toMatchObject({ step_count: 2, completed: 1, write_key_hash: null, open_until: null });
    expect((await step(run, { key, step: labStep("all"), done: false })).status).toBe(409);
    expect(db.labRows()[0]!.step_count).toBe(2);
  });

  it("refuses the 21st step with 409", async () => {
    const { db, create, step } = setup();
    const { run, key } = await create();
    for (let i = 0; i < 20; i++) expect((await step(run, { key, step: labStep("e" + i), done: false })).status).toBe(204);
    expect((await step(run, { key, step: labStep("baseline-end"), done: true })).status).toBe(409);
    expect(db.labRows()[0]).toMatchObject({ step_count: 20, completed: 0 });
    expect(JSON.parse(db.labRows()[0]!.steps as string)).toHaveLength(20);
  });

  it("refuses steps after the 900 s window with 409", async () => {
    const { db, create, step } = setup();
    const { run, key } = await create();
    expect((await step(run, { key, step: labStep(), done: false }, NOW + 900000)).status).toBe(204);
    expect((await step(run, { key, step: labStep(), done: false }, NOW + 901000)).status).toBe(409);
    expect(db.labRows()[0]!.step_count).toBe(1);
  });

  it("answers 403 for a wrong key and leaves the row alone", async () => {
    const { db, create, step } = setup();
    const { run } = await create();
    expect((await step(run, { key: "0".repeat(64), step: labStep(), done: true })).status).toBe(403);
    expect(db.labRows()[0]).toMatchObject({ step_count: 0, completed: 0, steps: "[]" });
  });

  it("answers 404 for an unknown or malformed run id", async () => {
    const { create, step } = setup();
    const { key } = await create();
    expect((await step(crypto.randomUUID(), { key, step: labStep(), done: false })).status).toBe(404);
    expect((await step("not-a-run", { key, step: labStep(), done: false })).status).toBe(404);
  });

  const stepCases: [string, (key: string) => unknown][] = [
    ["invalid JSON", () => "{"],
    ["short key", (key) => ({ key: key.slice(2), step: labStep(), done: false })],
    ["missing done", (key) => ({ key, step: labStep() })],
    ["extra step key", (key) => ({ key, step: { ...labStep(), url: "/" }, done: false })],
    ["bad name", (key) => ({ key, step: labStep("canvas-low"), done: false })],
    ["duplicate effects", (key) => ({ key, step: { ...labStep(), effects: ["a", "a"] }, done: false })],
    ["33 effects", (key) => ({ key, step: { ...labStep(), effects: Array.from({ length: 33 }, (_, i) => "e" + i) }, done: false })],
    ["too many frames", (key) => ({ key, step: { ...labStep(), frames: 10001 }, done: false })],
    ["over above frames", (key) => ({ key, step: { ...labStep(), over: 301 }, done: false })],
    ["ms too large", (key) => ({ key, step: { ...labStep(), maxMs: 10001 }, done: false })],
  ];

  it.each(stepCases)("rejects %s with 400", async (_name, body) => {
    const { db, create, step } = setup();
    const { run, key } = await create();
    expect((await step(run, body(key) as Record<string, unknown>)).status).toBe(400);
    expect(db.labRows()[0]!.step_count).toBe(0);
  });

  it("rejects a cross-origin step with 403 and a body over 2048 bytes with 413", async () => {
    const { db, create, send } = setup();
    const { run, key } = await create();
    const body = { key, step: labStep(), done: false };
    expect((await send(post(`/api/lab/runs/${run}/steps`, body, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await send(post(`/api/lab/runs/${run}/steps`, JSON.stringify(body) + " ".repeat(2048)))).status).toBe(413);
    expect(db.labRows()[0]!.step_count).toBe(0);
  });
});

describe("lab retention", () => {
  it("closes expired open runs and deletes runs older than 400 days", async () => {
    const { env, db, create, step } = setup();
    const old = await create(Date.UTC(2025, 7, 28, 12));
    const kept = await create(Date.UTC(2025, 7, 29, 12));
    const finished = await create(NOW - 3600000);
    await step(finished.run, { key: finished.key, step: labStep(), done: true }, NOW - 3600000);
    const expired = await create(NOW - 901000);
    const open = await create(NOW - 60000);
    await runRetention(env, NOW);
    const byId = Object.fromEntries(db.labRows().map((r) => [r.id, r]));
    expect(Object.keys(byId).sort()).toEqual([kept.run, finished.run, expired.run, open.run].sort());
    expect(byId[old.run]).toBeUndefined();
    expect(byId[kept.run]).toMatchObject({ write_key_hash: null, open_until: null, completed: 0 });
    expect(byId[finished.run]).toMatchObject({ write_key_hash: null, open_until: null, completed: 1 });
    expect(byId[expired.run]).toMatchObject({ write_key_hash: null, open_until: null, completed: 0 });
    expect(byId[open.run]).toMatchObject({ write_key_hash: sha256(open.key), open_until: NOW_S - 60 + 900 });
  });
});
