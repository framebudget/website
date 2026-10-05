import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import calibration from "../calibration.json";
import { handleFetch, runDaily, type Env } from "../src/handler";
import worker from "../src/index";
import { installCache, makeCtx, makeEnv, ORIGIN, SqliteD1 } from "./helpers";
import { fixtureRows, insertLabRows } from "./lab-rows";

const NOW = Date.UTC(2026, 9, 4, 3, 17);
const NOW_SEC = NOW / 1000;
const DAY = 86400;
const ROOT = fileURLToPath(new URL("..", import.meta.url));

function insertLog(db: SqliteD1, row: { created_at: number; patch: unknown; changes?: unknown[]; applied: number; cal?: string }) {
  db.db
    .prepare("INSERT INTO calibration_log (created_at, cal, runs, excluded, patch, changes, applied) VALUES (?, ?, 12, 0, ?, ?, ?)")
    .run(row.created_at, row.cal ?? "provisional-1", JSON.stringify(row.patch), JSON.stringify(row.changes ?? []), row.applied);
}

const cron = (env: Env, nowMs = NOW) =>
  worker.scheduled({ scheduledTime: nowMs, cron: "17 3 * * *", noRetry: () => undefined } as ScheduledController, env);

describe("daily auto calibration", () => {
  it("writes one log row per evaluation, applied or not", async () => {
    const { env, db } = makeEnv();
    insertLabRows(db.db, fixtureRows("2026-10-04"));
    await cron(env);
    await cron(env, NOW + DAY * 1000);
    const rows = db.logRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 1, created_at: NOW_SEC, cal: "provisional-1", runs: 24, excluded: 4, applied: 1 });
    expect(JSON.parse(String(rows[0]!.patch))).toEqual({
      effects: { counters: { threshold: 10 }, entrances: { threshold: 20.1 }, canvasLowRes: { threshold: 34 }, shimmer: { threshold: 42 }, parallax: { threshold: 72 }, blur: { threshold: 108 }, canvasHiRes: { threshold: 144 } },
    });
    const changes = JSON.parse(String(rows[0]!.changes));
    expect(changes).toHaveLength(8);
    expect(changes[0]).toEqual({ effect: "counters", from: 12, to: 10, proposed: 10, devices: 24, limitedBy: null });
    // The next day the effects still away from their proposal wait for the cadence; the patch in force stays.
    expect(rows[1]).toMatchObject({ created_at: NOW_SEC + DAY, applied: 0, patch: rows[0]!.patch });
    const waiting = JSON.parse(String(rows[1]!.changes)).filter((c: { limitedBy: string }) => c.limitedBy === "cadence");
    expect(waiting.map((c: { effect: string }) => c.effect)).toEqual(["parallax", "blur", "canvasHiRes"]);
  });

  it("logs an evaluation without lab runs too", async () => {
    const { env, db } = makeEnv();
    await cron(env);
    expect(db.logRows()).toEqual([{ id: 1, created_at: NOW_SEC, cal: null, runs: 0, excluded: 0, patch: '{"effects":{}}', changes: "[]", applied: 0 }]);
  });

  it("does nothing while the kill switch is off", async () => {
    const { env, db } = makeEnv();
    env.AUTO_CALIBRATION = "off";
    insertLabRows(db.db, fixtureRows("2026-10-04"));
    await cron(env);
    expect(db.logRows()).toEqual([]);
    expect(db.statements.some((s) => s.sql.includes("calibration_log") && !s.sql.startsWith("DELETE"))).toBe(false);
    expect(db.statements.some((s) => /^(SELECT|WITH)/.test(s.sql))).toBe(false);
  });

  it("never stops retention with an error", async () => {
    const db = new SqliteD1();
    const prepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      if (sql.startsWith("WITH eligible")) throw new Error("D1 down");
      return prepare(sql);
    };
    const { env } = makeEnv(db);
    db.db
      .prepare("INSERT INTO reports (created_day, cal, score, reduced_motion, tier, effects, stepped, fps, engine, os, mobile) VALUES (?, 'c', 1, 0, 'Lite', '[]', '[]', '{}', 'other', 'other', 0)")
      .run("2025-01-01");
    await expect(cron(env)).resolves.toBeUndefined();
    expect(db.rows()).toEqual([]);
    expect(db.logRows()).toEqual([]);
    await expect(runDaily(env, NOW)).resolves.toBeUndefined();
  });

  it("retention keeps 400 days of log rows and always the latest applied one", async () => {
    const { env, db } = makeEnv();
    const cutoff = Date.UTC(2025, 7, 30) / 1000;
    insertLog(db, { created_at: cutoff - 2 * DAY, patch: { effects: { blur: { threshold: 120 } } }, applied: 1 });
    insertLog(db, { created_at: cutoff - DAY, patch: { effects: { blur: { threshold: 110 } } }, applied: 1 });
    insertLog(db, { created_at: cutoff - 1, patch: { effects: { blur: { threshold: 110 } } }, applied: 0 });
    insertLog(db, { created_at: cutoff, patch: { effects: { blur: { threshold: 110 } } }, applied: 0 });
    env.AUTO_CALIBRATION = "off";
    await cron(env);
    expect(db.logRows().map((r) => [r.id, r.applied])).toEqual([
      [2, 1],
      [4, 0],
    ]);
  });
});

describe("GET /api/calibration with the auto patch", () => {
  beforeEach(() => {
    installCache();
  });

  const get = async (env: Env) => {
    const { ctx, pending } = makeCtx();
    const response = await handleFetch(new Request(ORIGIN + "/api/calibration"), env, ctx, NOW);
    return { response, pending };
  };

  it("merges the latest applied patch into calibration.json", async () => {
    const { env, db } = makeEnv();
    insertLog(db, { created_at: NOW_SEC - 9 * DAY, patch: { effects: { blur: { threshold: 120 } } }, applied: 1 });
    insertLog(db, { created_at: NOW_SEC - 2 * DAY, patch: { effects: { blur: { threshold: 108 }, parallax: { threshold: 72 } } }, applied: 1 });
    insertLog(db, { created_at: NOW_SEC - DAY, patch: { effects: { blur: { threshold: 1 } } }, applied: 0 });
    const { response, pending } = await get(env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.json()).toEqual({ ...calibration, effects: { blur: { threshold: 108 }, parallax: { threshold: 72 } } });
    expect(pending).toHaveLength(1);
  });

  it("serves calibration.json alone without an applied patch", async () => {
    const { env, db } = makeEnv();
    insertLog(db, { created_at: NOW_SEC, patch: { effects: {} }, applied: 0 });
    expect(await (await get(env)).response.json()).toEqual(calibration);
  });

  it("serves calibration.json alone while the kill switch is off", async () => {
    const { env, db } = makeEnv();
    insertLog(db, { created_at: NOW_SEC, patch: { effects: { blur: { threshold: 108 } } }, applied: 1 });
    env.AUTO_CALIBRATION = "off";
    const { response } = await get(env);
    expect(await response.text()).toBe(JSON.stringify(calibration));
    expect(db.statements).toEqual([]);
  });

  it("serves calibration.json alone, uncached, when D1 fails", async () => {
    const db = new SqliteD1();
    db.prepare = () => {
      throw new Error("D1 down");
    };
    const { env } = makeEnv(db);
    const { response, pending } = await get(env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(calibration);
    expect(pending).toEqual([]);
  });
});

describe("scripts/calibrate.mjs parity", () => {
  const today = new Date().toISOString().slice(0, 10);

  /** The auto calibration rows of the script's output: effect, devices, proposed, from, to, limited by. */
  function runScript(args: string[]) {
    const result = spawnSync(process.execPath, ["scripts/calibrate.mjs", ...args], { cwd: ROOT, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    const section = result.stdout.slice(result.stdout.indexOf("Automatic calibration:"));
    const lines = section.split("\n");
    const header = lines.findIndex((l) => l.trim().startsWith("effect") && l.includes("limited by"));
    const changes = [];
    for (const line of lines.slice(header + 1)) {
      if (!line.startsWith("  ")) break;
      const [effect, devices, proposed, from, to, limitedBy] = line.trim().split(/\s+/);
      changes.push({ effect, devices: Number(devices), proposed: proposed === "-" ? null : Number(proposed), from: Number(from), to: Number(to), limitedBy: limitedBy === "-" ? null : limitedBy });
    }
    const patch = JSON.parse(section.match(/^Patch: (.*)$/m)![1]!);
    const applied = section.match(/^Applied: (yes|no)$/m)![1] === "yes";
    return { stdout: result.stdout, changes, patch, applied };
  }

  async function cronLog(db: SqliteD1) {
    const { env } = makeEnv(db);
    const now = Date.now();
    await runDaily(env, now);
    const row = db.logRows().at(-1)!;
    return { changes: JSON.parse(String(row.changes)), patch: JSON.parse(String(row.patch)), applied: row.applied === 1 };
  }

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "framebudget-parity-"));
    const rows = fixtureRows(today);
    const db = new SqliteD1();
    insertLabRows(db.db, rows);
    const lab = join(dir, "lab.json");
    writeFileSync(lab, JSON.stringify([{ results: db.labRows(), success: true }]));
    return { dir, db, lab };
  }

  it("prints the cron's proposals and patch for the same runs and patch in force", async () => {
    const { dir, db, lab } = setup();
    const patch = { effects: { blur: { threshold: 120 }, hover: { threshold: 9 } } };
    insertLog(db, { created_at: Math.floor(Date.now() / 1000) - 30 * DAY, patch, changes: [{ effect: "blur", from: 135, to: 120 }], applied: 1 });
    const current = join(dir, "patch.json");
    writeFileSync(current, JSON.stringify(patch));
    const script = runScript(["--lab", lab, "--current", current]);
    const fromCron = await cronLog(db);
    expect(script.changes).toEqual(fromCron.changes);
    expect(script.patch).toEqual(fromCron.patch);
    expect(script.applied).toBe(fromCron.applied);
    expect(script.changes.find((c) => c.effect === "blur")).toMatchObject({ from: 120, to: 96, limitedBy: "step" });
    expect(script.stdout).toContain("cadence not checked");
  });

  it("applies the cadence from a calibration_log export", async () => {
    const { dir, db, lab } = setup();
    const nowSec = Math.floor(Date.now() / 1000);
    insertLog(db, { created_at: nowSec - 30 * DAY, patch: { effects: { blur: { threshold: 120 } } }, changes: [{ effect: "blur", from: 135, to: 120 }], applied: 1 });
    insertLog(db, { created_at: nowSec - 2 * DAY, patch: { effects: { blur: { threshold: 120 }, parallax: { threshold: 80 } } }, changes: [{ effect: "parallax", from: 90, to: 80 }], applied: 1 });
    insertLog(db, { created_at: nowSec - DAY, patch: { effects: {} }, applied: 0 });
    const log = join(dir, "log.json");
    writeFileSync(log, JSON.stringify([{ results: db.logRows(), success: true }]));
    const script = runScript(["--lab", lab, "--current", log]);
    const fromCron = await cronLog(db);
    expect(script.changes).toEqual(fromCron.changes);
    expect(script.patch).toEqual(fromCron.patch);
    expect(script.changes.find((c) => c.effect === "parallax")).toMatchObject({ from: 80, to: 80, limitedBy: "cadence" });
    expect(script.stdout).toContain("cadence from the log");
  });
});
