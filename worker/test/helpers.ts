import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { Env } from "../src/handler";

export const ORIGIN = "https://framebudget.dev";

/** A D1 stand-in backed by an in-memory SQLite with the real migration applied. Records every bound statement. */
export class SqliteD1 {
  readonly db = new DatabaseSync(":memory:");
  readonly statements: { sql: string; params: SQLInputValue[] }[] = [];

  constructor() {
    this.db.exec(readFileSync(new URL("../migrations/0001_reports.sql", import.meta.url), "utf8"));
  }

  prepare(sql: string) {
    return {
      bind: (...params: SQLInputValue[]) => ({
        run: async () => {
          this.statements.push({ sql, params });
          const result = this.db.prepare(sql).run(...params);
          return { success: true, meta: { changes: Number(result.changes) } };
        },
      }),
    };
  }

  rows(): Record<string, unknown>[] {
    return this.db.prepare("SELECT * FROM reports ORDER BY id").all() as Record<string, unknown>[];
  }
}

/** `assets` answers env.ASSETS.fetch; by default every asset is missing. */
export function makeEnv(db = new SqliteD1(), assets: (request: Request) => Promise<Response> = async () => new Response("not found", { status: 404 })) {
  const assetRequests: Request[] = [];
  const env = {
    // Only prepare/bind/run are used by the Worker; the SQLite stand-in covers exactly that.
    DB: db as unknown as D1Database,
    ASSETS: {
      fetch: async (request: Request) => {
        assetRequests.push(request);
        return assets(request);
      },
    } as unknown as Fetcher,
  } satisfies Env;
  return { env, db, assetRequests };
}

export function makeCtx() {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  return { ctx, pending };
}

/** In-memory `caches.default`, installed on globalThis (Node has no Cache API). */
export function installCache() {
  const store = new Map<string, Response>();
  const cache = {
    match: async (key: Request) => store.get(key.url)?.clone(),
    put: async (key: Request, response: Response) => void store.set(key.url, response),
  };
  (globalThis as unknown as { caches: { default: typeof cache } }).caches = { default: cache };
  return store;
}

/** A report shaped exactly like the library's buildReport output on a mid-range phone. */
export function validReport(): Record<string, unknown> {
  return {
    v: 1,
    cal: "provisional-1",
    score: 62,
    cold: 48,
    warm: 66,
    kernels: { float: 7130, typed: 151000, alloc: 18200, path: 3010 },
    tickMs: 0.1,
    hints: { cores: 8, memoryGb: 4, pressure: "nominal", reducedMotion: false },
    tier: "Medium",
    effects: ["canvasLowRes", "entrances", "hover"],
    stepped: [],
    fps: { main: 58, canvasLowRes: 55 },
  };
}

export interface PostOptions {
  body?: string;
  headers?: Record<string, string>;
  method?: string;
  path?: string;
  cf?: Record<string, unknown>;
}

export const CHROME_ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

/** A same-origin sendBeacon-like request (string body, text/plain). */
export function beacon(options: PostOptions = {}): Request {
  const request = new Request(ORIGIN + (options.path ?? "/api/report"), {
    method: options.method ?? "POST",
    headers: {
      "content-type": "text/plain;charset=UTF-8",
      origin: ORIGIN,
      "user-agent": CHROME_ANDROID_UA,
      "cf-connecting-ip": "203.0.113.7",
      ...options.headers,
    },
    body: options.method === "GET" ? undefined : (options.body ?? JSON.stringify(validReport())),
  });
  // Workers attach request.cf; Node's Request has none.
  Object.defineProperty(request, "cf", { value: options.cf ?? { country: "BR", city: "Florianopolis" } });
  return request;
}
