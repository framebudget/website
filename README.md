# framebudget.dev

The website of [framebudget](https://github.com/framebudget/core), the browser library that decides, per device, which visual effects a site can afford.

| Path | What it is |
| --- | --- |
| repository root | The Cloudflare Worker (see [The Worker](#the-worker)): `src/`, `test/`, `migrations/`, `scripts/calibrate.mjs`, `wrangler.jsonc`, `calibration.json`. It serves `docs/dist` through its static assets layer, receives the library's anonymous reports from every site that turned sharing on (`POST /api/report`, open to any origin, stored in D1), serves the calibration patch (`GET /api/calibration`, readable by any origin), stores the opt-in lab runs (`POST /api/lab/runs`, `POST /api/lab/runs/<run>/steps`, same-origin only, stored in D1) and calibrates the site's effect thresholds from them every day (see [Automatic calibration](#automatic-calibration)). |
| `shared/site-effects.json` | The site's effect numbers (threshold, cost, ms, motion and data flags per effect) and tier floors: the baseline the automatic calibration starts from and never drifts far from. The site reads them from this file (`docs/src/effects.ts` adds labels, colors and copy) and ships them as framebudget's `calibrationDefaults`, so the automatic thresholds served by `/api/calibration` refine them. |
| [`docs/`](docs/README.md) | The site: landing page, API reference, privacy page, the opt-in lab (`/lab`), error pages and the files for AI agents (`llms.txt`, `llm.txt`, `llms-full.txt`). A static Vite build with its own `package.json`, and a live demo of the library. |

Related repositories: the library is [github.com/framebudget/core](https://github.com/framebudget/core) (the npm packages `framebudget`, `@framebudget/core` and `@framebudget/react`), and the brand (fonts, logos, tokens, the release card template) is [github.com/framebudget/assets](https://github.com/framebudget/assets).

## The library as a dependency

The site and the Worker's tests use the published library, never its source. Until the library is on npmjs, `docs/package.json` (dependency) and the root `package.json` (devDependency) install it from the release assets of core [v0.4.0](https://github.com/framebudget/core/releases/tag/v0.4.0): `"framebudget": "https://github.com/framebudget/core/releases/download/v0.4.0/framebudget-0.4.0.tgz"`, with npm `overrides` pointing its dependencies `@framebudget/core` and `@framebudget/react` at their own assets of the same release (`framebudget-core-0.4.0.tgz`, `framebudget-react-0.4.0.tgz`), so one copy of each is installed and nothing comes from a registry. Release assets are immutable and public, so no registry or token is involved, and both lockfiles pin each tarball's integrity. Check the tarballs against the core release attestation with:

```sh
gh release download v0.4.0 --repo framebudget/core --pattern 'framebudget-*0.4.0.tgz'
gh release verify-asset v0.4.0 framebudget-0.4.0.tgz --repo framebudget/core
gh release verify-asset v0.4.0 framebudget-core-0.4.0.tgz --repo framebudget/core
gh release verify-asset v0.4.0 framebudget-react-0.4.0.tgz --repo framebudget/core
```

The package's `README.md` becomes `llms-full.txt`, and the Worker's calibration script reads `defaultCalibration` from it. To move to a new library release, change the three URLs (the dependency and both `overrides`) in both `package.json` files, run `npm install` at the root and in `docs/`, and commit both lockfiles.

## Local development

Node 22. No npm login or token is needed.

Site (`docs/`, details in [`docs/README.md`](docs/README.md)):

```sh
npm ci --prefix docs
npm run site:dev                # Vite dev server with hot reload (npm run dev --prefix docs)
npm run site:build              # type-check, then the static site in docs/dist (npm run build --prefix docs)
npm run serve --prefix docs     # serve docs/dist like production
```

Worker (the repository root), serving the built `docs/dist`:

```sh
npm ci
npm run site:build                                      # docs/dist, served by the assets binding
cp .dev.vars.example .dev.vars                         # Turnstile test secret for the lab endpoints
npx wrangler d1 migrations apply framebudget --local   # or: npm run migrate:local
npx wrangler dev --local                               # or: npm run dev
```

`.dev.vars` (ignored by git) holds `TURNSTILE_SECRET_KEY` for `wrangler dev`. The example file has Cloudflare's always-passing test secret `1x0000000000000000000000000000000AA`; the `/lab` page uses the matching always-passing test sitekey `1x00000000000000000000AA` when served from `localhost` or `127.0.0.1`, so the whole lab flow runs locally without a real challenge. The Worker calls the real siteverify with the test secret, so local runs need network access; if `wrangler dev` logs `TLS peer's certificate is not trusted` for that call, start it with `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt` (the system CA bundle). Production uses the sitekey `0x4AAAAAAFNAudgNvxLdXbLQ` (domains `framebudget.dev` and `www.framebudget.dev`) and the secret set on the deployed Worker.

Then, with the port wrangler prints (8787 by default):

```sh
curl -i -X POST http://localhost:8787/api/report \
  -H 'Origin: http://localhost:8787' -H 'Content-Type: text/plain;charset=UTF-8' \
  --data-binary '{"v":1,"cal":"provisional-1","score":62,"cold":48,"warm":66,"kernels":{"float":7130,"typed":151000,"alloc":18200,"path":3010},"tickMs":0.1,"hints":{"cores":8,"memoryGb":4,"reducedMotion":false},"tier":"Medium","effects":["canvasLowRes","entrances","hover"],"stepped":[],"fps":{"main":58,"canvasLowRes":55}}'
npx wrangler d1 execute framebudget --local --command "SELECT * FROM reports"
curl -i http://localhost:8787/api/calibration
curl -i -X POST http://localhost:8787/api/lab/runs \
  -H 'Origin: http://localhost:8787' -H 'Content-Type: application/json' \
  --data-binary '{"turnstile":"XXXX.DUMMY.TOKEN.XXXX","lib":"0.2.1","cal":"provisional-1","device":{"score":61.2,"cold":48,"warm":66.4,"kernels":{"float":7130,"typed":151000,"alloc":18200,"path":3010},"tickMs":0.1,"cores":8,"memoryGb":4,"refreshHz":60,"dpr":2.6,"viewportWidth":400,"reducedMotion":false,"saveData":false}}'
# then, with the run and key from the 201 answer:
curl -i -X POST http://localhost:8787/api/lab/runs/<run>/steps \
  -H 'Origin: http://localhost:8787' -H 'Content-Type: application/json' \
  --data-binary '{"key":"<key>","step":{"name":"baseline","effects":[],"frames":300,"durationMs":5004,"medianMs":16.7,"p95Ms":18.1,"maxMs":33.4,"over":2},"done":true}'
npx wrangler d1 execute framebudget --local --command "SELECT * FROM lab_runs"
```

Run the daily job (retention, then the automatic calibration) locally with `npx wrangler dev --local --test-scheduled` and `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=17+3+*+*+*"` (`/__scheduled` never reaches the Worker here: the asset layer answers every path outside `/api/*`), then read its row with `npx wrangler d1 execute framebudget --local --command "SELECT * FROM calibration_log"`. Local D1 state lives in `.wrangler/` (ignored by git).

Tests and types:

```sh
npm test               # Vitest, test/ only; handler, lab and calibration tests run against in-memory SQLite with the real
                       # migrations (Turnstile's siteverify stubbed), assets.test.ts runs wrangler.jsonc's routing in
                       # wrangler's local runtime, validate.test.ts checks the report the installed framebudget package
                       # sends
npm run typecheck      # src/ with the Workers types, then test/
```

## The Worker

One Cloudflare Worker (free plan) for framebudget.dev:

- Serves the landing site (`docs/dist`, the Vite build) through the static assets layer. Static files are served without running the Worker, so they cost nothing and do not count against Worker requests. `html_handling` is `auto-trailing-slash`: `/` serves `index.html`, `/api` and `/privacy` serve `api.html` and `privacy.html`, which is how the site links them. `/privacy.html` redirects to `/privacy`. `not_found_handling` is `404-page`: a path with no matching file gets `404.html` (`docs/404.html`) with status 404, from the asset layer.
- `POST /api/report`: receives the anonymous report the library sends with `navigator.sendBeacon`, from this site and from every other site that turned sharing on (framebudget 0.5.0 and later always send there), and stores one row in D1, within a burst limit and a daily budget (see [Rate limits](#rate-limits)).
- `GET /api/calibration`: returns the calibration patch the library fetches at most once a day, from any site: `calibration.json` with the latest automatic thresholds merged in.
- `POST /api/lab/runs` and `POST /api/lab/runs/<run>/steps`: the opt-in lab (`/lab`). A visitor who consents and passes Turnstile gets one row; each measured step updates that row.
- A daily cron deletes reports, their daily counts, lab runs and calibration log rows older than 400 days, closes expired lab runs, then calibrates the effect thresholds from the lab runs (see [Automatic calibration](#automatic-calibration)).

The data exists to calibrate the score scale (reference rates) and the effect thresholds on real devices.

### Routing and errors

`run_worker_first: ["/api/*"]` is the only way into the Worker: every other path, matched or not, is answered by the asset layer, so a missing page never costs a Worker request. `/api` itself is the API reference page; `/api/` and below are the Worker's.

The fetch entry (`handleFetchSafely` in `src/handler.ts`) catches any error the handler throws. A page load (an `Accept` header with `text/html`, outside `/api/`) gets the site's `500.html` with status 500 and `Cache-Control: no-store`, fetched from the assets binding as `/500` (`/500.html` would redirect there); anything else, the API included, gets a bare 500, as the API's other errors do. With today's routing only `/api/*` reaches the Worker, so the page is a safety net for routes added later. The error is not logged, like everything else here.

### Endpoints

#### `POST /api/report`

Public: any origin may post. Since framebudget 0.5.0, `share` always sends to `https://framebudget.dev/api/report` (plus the site's own `alsoSendTo`, if any), from whatever site runs the library, so there is no origin check here. Everything else is as strict for other sites as for this one. Accepted only when all of these hold, checked in this order, otherwise a bare status with no body (a 429 also carries `Retry-After`):

| Check | Failure |
| --- | --- |
| Path is exactly `/api/report` | 404 |
| Method is `POST` (`OPTIONS` gets the CORS preflight answer below) | 405 |
| `Content-Type` is `text/plain` (what `sendBeacon` sends for a string) or `application/json` | 415 |
| Under the burst limit (`REPORT_LIMIT`, 300 calls a minute), checked before the body is read | 429, `Retry-After: 60` |
| `Content-Length` (when present) and the bytes actually read are at most 4096; reading stops past the limit, so a missing or understated `Content-Length` does not help | 413 |
| Body is UTF-8 JSON and a valid v1 report (`src/validate.ts`) | 400 |
| Fewer than `REPORT_DAILY_CAP` reports stored today (UTC) | 429, `Retry-After`: the seconds to the next UTC midnight |
| Insert succeeds | 503 |

Success is `204 No Content`. Validation is strict: exact keys at every level, `v === 1`, integer scores 0..10000, kernel rates finite and positive, effect and fps names matching `^[A-Za-z][A-Za-z0-9_-]{0,31}$`, at most 64 effects with no duplicates, at most 40 fps sources with whole values 0..1000, known tier and pressure values. Any other `/api/*` path answers a bare 404.

CORS: every answer of `/api/report`, errors included, carries `Access-Control-Allow-Origin: *` and never `Access-Control-Allow-Credentials`. A `sendBeacon` with a string body is a CORS simple request (`text/plain`, no preflight; the browser does not read the answer). A `fetch` with `application/json` from another site sends a preflight first: `OPTIONS /api/report` answers `204` with `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: POST`, `Access-Control-Allow-Headers: Content-Type` and `Access-Control-Max-Age: 86400`, and stores nothing.

#### Rate limits

`POST /api/report` is open to every origin, and reports share one D1 database with the lab, so a flood that used up the free plan's 100,000 rows written a day would also make the lab answer 503 until midnight UTC. Two layers bound it; the preflight, `GET /api/calibration` and the lab are outside both.

1. Burst limit: the Workers Rate Limiting binding `REPORT_LIMIT` (`ratelimits` in `wrangler.jsonc`, `"simple": { "limit": 300, "period": 60 }`), called after the method and content type checks and before the body is read. Past it: 429 with `Retry-After: 60`, nothing read from or written to D1. Cloudflare counts it per location and approximately (it is eventually consistent, and a probe on this account let through more calls than its limit), so it smooths bursts but is not a hard bound.
2. Daily budget, the hard bound: `REPORT_DAILY_CAP` (a var in `wrangler.jsonc`, `"6000"`) reports stored per UTC day, counted in `report_days`. The insert and the count are one `db.batch`, which D1 runs as one transaction, and both statements write only while the day's count is below the cap (`INSERT ... SELECT ... WHERE COALESCE((SELECT n FROM report_days WHERE day = ?), 0) < ?`). So exactly `REPORT_DAILY_CAP` reports are stored a day, concurrent requests included, and once the cap is reached a rejected report writes 0 rows (it reads 3). Past it: 429 with `Retry-After` set to the seconds to the next UTC midnight, when the count starts again at 0.

The burst limit's key is the constant `"report"`: all senders share one bucket. Keying it by IP, or by anything else about the sender, would break the privacy page's promise that no IP is used, and Cloudflare's own Rate Limiting docs advise against IP keys (many users share one IP). The cost is that a flood also delays honest reports, which the daily budget does anyway.

Visitors never notice either limit: the library sends with `sendBeacon`, which ignores the answer, so a 429 is silent. That report is lost, and the browser does not send another before `minIntervalDays` (it records the report as sent once the beacon is queued).

To change them, edit `wrangler.jsonc` and deploy: `simple.limit` (calls) and `simple.period` (10 or 60 seconds) of `REPORT_LIMIT`, and `REPORT_DAILY_CAP` (`"0"` stops storing reports; a value that is not a whole number falls back to 6000). If `period` changes, change the `Retry-After: 60` in `src/handler.ts` with it. Raise the cap only with the write budget in [Free plan notes](#free-plan-notes) in view. Neither layer saves Worker requests: a flood still counts against the 100,000 Worker requests a day.

#### `GET /api/calibration`

Returns `calibration.json` deep-merged with the patch of the latest applied row of `calibration_log` (the automatic thresholds win; see [Automatic calibration](#automatic-calibration)), with `Cache-Control: public, max-age=3600` and `Access-Control-Allow-Origin: *` (any site may read it; the library fetches it without credentials), and stores it in the edge cache (`caches.default`) for an hour. The CORS header is the same for every origin, so it is part of the cached answer and the cache needs no `Vary`. Without an applied row, while the kill switch `AUTO_CALIBRATION` is not `on`, or when D1 fails (that answer is not cached), it returns `calibration.json` alone. Other methods get 405.

`calibration.json` is a JSON file in the repository, bundled into the Worker at build time, instead of a row in D1 or a KV value: hand-made calibration changes go through pull request review, ship with a deploy, and need no extra storage, admin endpoint or secret. It starts as `{}`: the library defaults stay in force. The automatic thresholds are the only part that lives in D1, behind the guardrails of [Automatic calibration](#automatic-calibration). The library applies the remote patch over its defaults and the site's `calibrationDefaults`, and under the site's `calibration` patches (core v0.4.0). The site passes its whole registry and tier floors (`shared/site-effects.json`) as `calibrationDefaults` and nothing site-specific as `calibration`, so the automatic thresholds refine the site's values from a browser's next visit. Changing `reference` changes `calibrationKey`, which invalidates cached scores on every device; only change it with a calibration run, not as a no-op edit.

#### `POST /api/lab/runs`

Creates one lab run (one row in `lab_runs`). The `/lab` page calls it once, after the visitor passed Turnstile and pressed the button.

```json
{
  "turnstile": "<Turnstile token>",
  "lib": "0.2.1",
  "cal": "<budget.snapshot().calibration.version>",
  "device": {
    "score": 61.2, "cold": 48.0, "warm": 66.4,
    "kernels": { "float": 7130, "typed": 151000, "alloc": 18200, "path": 3010 },
    "tickMs": 0.1, "cores": 8, "memoryGb": 4,
    "refreshHz": 60, "dpr": 2.6, "viewportWidth": 400,
    "reducedMotion": false, "saveData": false
  },
  "protocol": 2
}
```

Checks in order, each failure a bare status with no body:

| Check | Failure |
| --- | --- |
| Method is `POST` | 405 |
| Same origin: `Origin` equals the request origin, or `Origin` is absent and `Sec-Fetch-Site: same-origin` (no CORS headers, unlike `/api/report`) | 403 |
| `Content-Type` is `application/json` | 415 |
| Body at most 4096 bytes | 413 |
| Body is a valid run (`src/lab-validate.ts`): exact keys at every level, every device key present (`cold`, `warm`, `tickMs`, `cores`, `memoryGb` and each kernel may be `null`), scores 0..10000, kernel rates positive, whole `cores` 1..1024, whole `refreshHz` 1..1000, `dpr` above 0 up to 16, booleans for the flags, `lib` `^[0-9A-Za-z.+-]{1,32}$`, a Turnstile token of 1..2048 characters, `protocol` absent, `1` or `2` | 400 |
| Turnstile: `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` with the form fields `secret` and `response` only (never the IP) answers `success: true`; an unreachable siteverify also fails | 403 |
| Fewer than `LAB_DAILY_CAP` runs created today (UTC) | 429 |
| Insert succeeds | 503 |

Success is `201` with `{"run": "<uuid>", "key": "<64 hex characters>", "maxSteps": 20, "expiresIn": 900}` and `Cache-Control: no-store`. The run id is `crypto.randomUUID()`; the key is 32 random bytes in hex, and only its SHA-256 is stored. The page keeps both in memory only. Device numbers are stored at the precision the page promises, whatever it sent: scores and `dpr` to 1 decimal, kernel rates to 3 significant digits, `tickMs` to 2, `viewportWidth` to the nearest 100. The daily cap and the insert are one statement (`INSERT ... SELECT ... WHERE (SELECT COUNT(*) FROM lab_runs WHERE created_day = ?) < ?`), so concurrent requests cannot pass the cap.

`protocol` is the lab protocol of the page and is stored in the `protocol` column. Protocol 1 pages (built before protocol 2 existed) send no `protocol` and get `1`: their runs keep working unchanged. Protocol 2 pages send `2` and add the main-thread work per frame to every step (see below).

#### `POST /api/lab/runs/<run>/steps`

Appends one measured step to the run's row. The page sends each step between measurements, never during one.

```json
{
  "key": "<key from the create response>",
  "step": {
    "name": "baseline", "effects": [], "frames": 300, "durationMs": 5004, "medianMs": 16.7, "p95Ms": 18.1, "maxMs": 33.4, "over": 2,
    "workMeanMs": 2.35, "workMedianMs": 2, "workP95Ms": 4.1, "workFrames": 298
  },
  "done": false
}
```

The four work fields come from protocol 2 pages: the main-thread work of each frame (the page's JavaScript plus style, layout and paint; not compositor or GPU work), as its mean, median and p95 over the step, and `workFrames`, the frames that had a work sample. They are `null` when no frame had one. Protocol 1 pages send the step without them.

| Check | Failure |
| --- | --- |
| `<run>` is a UUID | 404 |
| Method is `POST` | 405 |
| Same origin | 403 |
| `Content-Type` is `application/json` | 415 |
| Body at most 2048 bytes | 413 |
| Body is valid: `key` 64 lowercase hex characters, `done` boolean, `name` `baseline`, `baseline-end`, `all` or an effect name (`^[A-Za-z][A-Za-z0-9]{0,31}$`), at most 32 distinct effect names, whole `frames` 0..10000, whole `over` 0..`frames`, ms values 0..10000; the four work fields all present or all absent, each `null` or in range (`workMeanMs`, `workMedianMs`, `workP95Ms` 0..10000, whole `workFrames` 0..`frames`) | 400 |
| The run exists | 404 |
| The run is open: not completed, `open_until` not passed, fewer than 20 steps | 409 |
| `sha256(key)` matches the stored hash | 403 |

Success is `204`. The write is a single `UPDATE lab_runs SET steps = json_insert(steps, '$[#]', json(?)), step_count = step_count + 1 WHERE id = ? AND write_key_hash = ? AND completed = 0 AND step_count < 20 AND open_until >= ?`, so concurrent steps can never exceed 20 or write to a closed run; only when it changes no row does the Worker read the row to choose between 404, 409 and 403. The stored step is rebuilt from the validated fields in a fixed key order: the protocol 1 keys, then, only when sent, the work keys, with the work ms values rounded to 2 decimals. `done: true` also sets `completed = 1`, `write_key_hash = NULL` and `open_until = NULL`: the run is closed and nothing on the row tells the time of day.

### Data collected

Each row holds exactly what the library's `TelemetryReport` contains, plus coarse facts derived from request headers:

- From the report: calibration version, final score, cold and warm benchmark scores, per-kernel rates, clock resolution, core count, device memory, Compute Pressure state, reduced-motion preference, tier, effects that ran, effects the governor stepped down, median fps per source.
- Derived server-side: UTC day (no time of day), engine family and major version, OS family, phone-class flag, two-letter country from `request.cf.country`.

A lab run (`lab_runs`) holds the library version, the calibration version, the lab protocol, the device numbers listed under [`POST /api/lab/runs`](#post-apilabruns) (scores, kernel rates, clock resolution, cores, memory, refresh rate, device pixel ratio, viewport width rounded to 100 px, reduced-motion and save-data flags), the same derived fields as a report, and the measured steps (per step: name, effects, frame count, duration, median, p95 and max frame time, frames over 1.5 refresh intervals, and for protocol 2 the mean, median and p95 main-thread work per frame and the frames with a work sample). Until the run closes it also holds the SHA-256 of the write key and the epoch second the run stops accepting steps; both are cleared when the last step arrives or, for abandoned runs, by the daily cron.

Not collected, not stored, not logged, for reports and lab runs alike: IP address, User-Agent string, client hint values, cookies, any identifier, the page URL, referrer, the `Origin` header (so not which site sent a report), time of day, city or region. The raw headers are read once to derive the coarse fields (`src/client.ts`) and then discarded. Turnstile's siteverify gets the token and the secret, not the IP. Nothing is logged by the Worker.

### Schema

`migrations/0001_reports.sql`, table `reports`:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PK | Row id, no meaning outside the table |
| `created_day` | TEXT | UTC `YYYY-MM-DD` |
| `cal` | TEXT | Calibration version the scores used |
| `score` | INTEGER | Final score (caps and pressure applied) |
| `cold`, `warm` | INTEGER NULL | Benchmark scores, NULL when that run did not happen |
| `tick_ms` | REAL NULL | Clock resolution |
| `kernel_float`, `kernel_typed`, `kernel_alloc`, `kernel_path` | REAL NULL | Work units per ms (warm run when present, else cold) |
| `cores` | INTEGER NULL | `hardwareConcurrency` |
| `memory_gb` | REAL NULL | `deviceMemory` |
| `pressure` | TEXT NULL | `nominal`, `fair`, `serious`, `critical` |
| `reduced_motion` | INTEGER | 0 or 1 |
| `tier` | TEXT | `Full`, `High`, `Medium`, `Lite` |
| `effects` | TEXT | JSON array of effect names |
| `stepped` | TEXT | JSON array of effect names |
| `fps` | TEXT | JSON object, source to median fps |
| `fps_main` | INTEGER NULL | `fps.main`, for direct queries |
| `engine` | TEXT | `blink`, `gecko`, `webkit`, `other` |
| `engine_version` | INTEGER NULL | Chromium, Firefox or Safari (iOS) major version |
| `os` | TEXT | `android`, `ios`, `windows`, `macos`, `linux`, `chromeos`, `other` |
| `mobile` | INTEGER | 1 for phones (tablets are 0) |
| `country` | TEXT NULL | Two-letter code, NULL when unknown |

Indexes: `score`, `(engine, engine_version)`, `(os, mobile)`, `created_day`. `mobile` alone has two values and gets no index of its own; it is the second column of the `os` index. iPadOS Safari reports itself as macOS, so iPads usually land in `macos`.

`migrations/0002_lab.sql` and `migrations/0003_lab_protocol.sql`, table `lab_runs` (one row per lab run; steps update it, never add rows):

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PK | Random UUID, no meaning outside the table |
| `created_day` | TEXT | UTC `YYYY-MM-DD` |
| `lib` | TEXT | framebudget version the page ran |
| `cal` | TEXT | Calibration version the scores used |
| `score` | REAL | framebudget score, 1 decimal |
| `cold`, `warm` | REAL NULL | Benchmark scores, 1 decimal |
| `tick_ms` | REAL NULL | Clock resolution, 2 significant digits |
| `kernel_float`, `kernel_typed`, `kernel_alloc`, `kernel_path` | REAL NULL | Work units per ms, 3 significant digits |
| `cores` | INTEGER NULL | `hardwareConcurrency` |
| `memory_gb` | REAL NULL | `deviceMemory` |
| `refresh_hz` | INTEGER | Refresh rate measured by the page |
| `dpr` | REAL | `devicePixelRatio`, 1 decimal |
| `viewport_width` | INTEGER | CSS pixels, nearest 100 |
| `reduced_motion`, `save_data` | INTEGER | 0 or 1 |
| `engine`, `engine_version`, `os`, `mobile`, `country` | | As in `reports` |
| `steps` | TEXT | JSON array of steps, at most 20 |
| `step_count` | INTEGER | Entries in `steps` |
| `completed` | INTEGER | 1 once the page sent `done: true`; 0 for abandoned runs |
| `write_key_hash` | TEXT NULL | SHA-256 hex of the write key, NULL once closed |
| `open_until` | INTEGER NULL | Epoch seconds, creation + 900, NULL once closed |
| `protocol` | INTEGER | Lab protocol of the page: 1 (frame times only) or 2 (also main-thread work per frame); rows from before 0003 read as 1 |

Index: `created_day` (the daily cap counts today's rows; retention deletes by day). A row is at most about 27 KB (20 steps of 32 effect names each); a typical run is about 4 KB.

`migrations/0004_calibration_log.sql`, table `calibration_log` (one row per daily automatic calibration, applied or not; see [Automatic calibration](#automatic-calibration)):

| Column | Type | Notes |
| --- | --- | --- |
| `id` | INTEGER PK | Row id, increasing; the latest applied row is the one with the highest `id` and `applied = 1` |
| `created_at` | INTEGER | Epoch seconds of the evaluation |
| `cal` | TEXT NULL | Calibration version of the runs used, NULL when no run qualified |
| `runs` | INTEGER | Lab runs counted and used (the most recent 1000 at most) |
| `excluded` | INTEGER | Lab runs of that version excluded within the 400 days (refresh rate, missing baseline, busy baseline, thermal throttling) |
| `patch` | TEXT | The full automatic patch in force after this evaluation, a `CalibrationPatch` JSON with `effects.<name>.threshold` only |
| `changes` | TEXT | JSON array, one `{effect, from, to, proposed, devices, limitedBy}` per effect evaluated |
| `applied` | INTEGER | 1 when at least one threshold changed |

Index: `created_at` (retention). One small row a day.

`migrations/0005_report_days.sql`, table `report_days` (the daily budget of `POST /api/report`; see [Rate limits](#rate-limits)):

| Column | Type | Notes |
| --- | --- | --- |
| `day` | TEXT PK | UTC `YYYY-MM-DD` |
| `n` | INTEGER | Reports stored that day |

One row a day, incremented in the same transaction as each stored report.

### Retention

The cron trigger (`17 3 * * *`, daily) runs, with the UTC day 400 days before the run:

- `DELETE FROM reports WHERE created_day < ?`
- `DELETE FROM report_days WHERE day < ?`
- `DELETE FROM lab_runs WHERE created_day < ?`
- `UPDATE lab_runs SET write_key_hash = NULL, open_until = NULL WHERE open_until < ?` (the current epoch second): runs the page abandoned are closed, so no time of day survives a run.
- `DELETE FROM calibration_log WHERE created_at < ? AND id <> COALESCE((SELECT MAX(id) FROM calibration_log WHERE applied = 1), 0)` (the epoch second that UTC day starts): the latest applied row stays however old, since it holds the patch in force.

A row from exactly 400 days ago is kept; one day older is deleted. The automatic calibration runs after these statements, in the same job.

### Free plan notes

- Workers free plan: 100,000 Worker requests per day. Static asset requests are free and unlimited. The Worker runs only for `/api/*` (missing pages get `404.html` from the asset layer); a browser costs at most one Worker request a week for the report (`minIntervalDays: 7`), plus the calibration fetch at most once a day, for each site it visits that turned sharing on (the library keeps its state per origin). Since framebudget 0.5.0 every such site reports here and fetches the calibration from here, so traffic grows with the library's adoption, not with this site's visitors. The calibration fetch is the larger share: the edge cache saves the D1 read, but every fetch still runs the Worker.
- D1 free plan: 5 GB storage, 100,000 rows written and 5 million rows read per day. A row is about 400 bytes. This site's visitors all report (`sampleRate: 1`) but at most once a week (`minIntervalDays: 7`), so their rows track weekly unique browsers rather than page views; other sites report from 10% of page views by default (`sampleRate: 0.1`), with the same weekly limit per browser and site. 400 days of retention fit in 5 GB up to about 30,000 reports a day (12 million rows); at `REPORT_DAILY_CAP` (6,000) they take about 2.4 million rows, about 1 GB. Past the daily write limit, inserts fail and the Worker answers 503 until the next day (reports and lab runs alike, they share the database); nothing is billed. The two caps below keep a day under that limit.
- Lab: `LAB_DAILY_CAP` (a var in `wrangler.jsonc`, `"1000"`) bounds new runs per UTC day. A run costs 3 rows written to create (the row, its `id` primary key index and the `created_day` index), 1 per step (steps touch no indexed column), so at most 23 with 20 steps, plus 1 when the cron closes an abandoned run: at most 24,000 rows written a day at the cap (about 13 a run, 13,000 a day, for a typical run of about 10 steps). The cap's `COUNT(*)` reads at most one index entry per run already created that day (about 500,000 rows read a day at the cap). A run is about 4 KB (27 KB at most), so 400 days at the cap take about 1.6 GB. Change the cap in `wrangler.jsonc` and deploy; `"0"` closes the lab. Turnstile guards run creation, and the write key guards each run's steps.
- Reports: D1 bills one extra row written per index an insert touches. A stored report writes 5 rows (the row and the 4 indexes of `reports`) plus 1 for its `report_days` count (2 for the day's first report, which also writes the primary key index), so 6. Measured with `wrangler dev --local` (workerd's D1 returns `meta.rows_written`): 5 for the insert, 1 for the count (2 on the day's first), and 0 written (3 read) for a report rejected at the cap. At the cap that is 6,000 x 6 = 36,000 rows written a day.
- Retention deletes cost writes too. Counted like inserts (a row plus its indexes; workerd's local D1 reports 1 per deleted row, so this is the pessimistic count), deleting a day at both caps 400 days later takes 6,000 x 5 = 30,000 for reports and 1,000 x 3 = 3,000 for lab runs; `report_days` and `calibration_log` add a few rows.
- Daily write budget at both caps, worst case (full lab runs, a day at the cap 400 days earlier): 36,000 (reports) + 24,000 (lab) + 30,000 + 3,000 (retention) + under 10 (counts, calibration log) = about 93,000 rows written, under the 100,000 of the free plan. With typical lab runs it is about 82,000. Reads stay far under 5 million: a stored or rejected report reads at most 4 rows, and Worker requests are capped at 100,000 a day. Do not raise `REPORT_DAILY_CAP` or `LAB_DAILY_CAP` on the free plan without redoing this sum.
- When real adoption needs more reports than `REPORT_DAILY_CAP`, move to Workers Paid ($5 a month), whose D1 allowance is counted per month (50 million rows written, 25 billion rows read included, then billed per million), and raise `REPORT_DAILY_CAP` there: every 1,000 reports a day add about 11,000 rows written a day once retention deletes them too (about 330,000 a month). Raise the burst limit's `simple.limit` with it so that a normal busy minute is not cut. On the paid plan the cap becomes a bound on cost rather than on availability.
- Automatic calibration: a scheduled invocation on the Workers free plan gets 10 ms of CPU; D1 query time does not count, but everything the Worker parses and computes does, and an evaluation that runs out of CPU fails silently (the error is swallowed, no log row that day). So D1 does the heavy part: the SQL in `src/calibration/runs.ts` parses the steps JSON with `json_each`, applies the exclusions, pools the late frames of each run's baseline steps, keeps the 1000 most recent counted runs (`MAX_RUNS`), and returns only compact rows (run, score, step name, the step's late frames and frames, the run's baseline late frames and frames) for the registry's effects, about 8 rows per run. 1000 runs are plenty for a 5% tail with 10 devices or more at or above a threshold, and the bound keeps the Worker's share flat however large the lab grows: on a development machine, parsing the 8,000 rows of 1000 runs takes about 2 ms and the evaluation about 3.5 ms. D1 reads each run of the 400-day window a few times a day (two queries), well within the 5 million rows read a day even at the full `LAB_DAILY_CAP`.

## Automatic calibration

Every day, after retention, the cron evaluates the effect thresholds of framebudget.dev from the lab runs and, within hard guardrails, changes them without anyone editing a file. The code is `src/calibration/`; `scripts/calibrate.mjs --lab` runs the same code and prints what the cron would apply today.

1. **Runs.** Completed lab runs with `protocol >= 2` from the last 400 days, of the most common calibration version among them (scores of different versions are on different scales). Protocol 1 runs and other versions are ignored. Each remaining run is excluded when its refresh rate is outside 30..360 Hz, when it lacks the `baseline` or the `baseline-end` step or those two steps hold no frame to compare late frames with, when its `baseline` p95 frame time is above 1.5 refresh intervals (the device was busy before any effect), or when its `baseline-end` p95 is more than 25% above its `baseline` p95 (it throttled during the run). The rest are counted, and the 1000 most recent of them (by day) are used; see [Free plan notes](#free-plan-notes) for why. All of this happens in SQL (`src/calibration/runs.ts`), which hands the Worker one compact row per effect step.
2. **Proposal.** For each effect of `shared/site-effects.json` that a counted run measured (the lab cannot drive `hover`, `sound`, `morph`, `pageTransition`, `springs`, `magnetic` and `spotlight`), the proposed threshold is the lowest device score S such that, among the counted devices with score >= S that ran the effect, fewer than 5% missed, with at least 10 such devices. Otherwise there is no proposal and the effect keeps its value (`limitedBy: "devices"`). A device missed when more than 5% of the effect step's frames were late (`over / frames`, `over` being the frames longer than 1.5 refresh intervals; `LATE_MAX`) and that share is at least 2 points above the late share of the run's `baseline` and `baseline-end` steps pooled (their `over` added up, over their `frames` added up; `LATE_OVER_BASELINE`). A step without a positive frame count is not a sample. The rule is `missedLateFrames` and the search `lowestThreshold`, both in `src/calibration/search.ts`, the ones the script's `--lab` table uses too.

   Why late frames rather than the p95 frame time: on cheap phones the gaps between animation frames jitter even when no frame is dropped, so the p95 frame time sits above a 55 fps target with no effect on at all. A Samsung M31 and an LG K41s at 61 Hz read 18.8 to 19.1 ms in the baseline, against a target of 17.9 ms, so with the p95 they counted as missing nearly every effect, including effects that dropped no frame, and would have pushed thresholds up once enough such devices ran the lab. A late frame is a dropped frame whatever the jitter, and comparing with the run's own baseline leaves out what the device drops with nothing on. On the LG K41s (baseline 4 of 304 frames late, baseline-end 0 of 305), `textReveal` (17 of 246) and `all` (42 of 245) miss, while `counters`, `entrances`, `canvasLowRes`, `shimmer`, `parallax`, `blur` and `canvasHiRes` (at most 3 late frames out of about 305) do not; the p95 rule had it miss 7 of 8 effects.
3. **Guardrails**, in this order, from the current value (the last applied automatic value, else the baseline in `shared/site-effects.json`). Values are kept on tenths, the lab's score precision.
   1. Step limit (`step`): at most 20% away from the current value.
   2. Drift limit (`drift`): within 0.5x..2x of the baseline. Moving further needs a human editing the baseline.
   3. Tier floors (`tier`): never crosses a tier floor of `shared/site-effects.json`. An effect runs on a tier when its threshold is at most the tier floor, so the threshold stays above the highest floor below the baseline and at most the lowest floor at or above it: automatic changes never move an effect between tiers (`textReveal` at 46 stays within 20.1..49, `blur` at 135 within 90.1..180).
   4. Minimum change (`min-change`): skipped unless the result differs from the current value by at least 5%.
   5. Cadence (`cadence`): at most one applied change per effect every 7 days.

   `limitedBy` in the log names the last guardrail that changed or held back the value (null when the proposal went through as is). Drift and tier are hard limits: when a human moves a baseline so that the value in force falls outside them, the next evaluation in which a counted run measured the effect pulls it back, even without a proposal, past minimum change and cadence.
4. **Patch.** Only `effects.<name>.threshold` ever changes: never reference rates, version, tiers, hysteresis, costs or flags. The new patch is the previous one with the changed thresholds (effects gone from the registry dropped). Every evaluation writes one `calibration_log` row (see [Schema](#schema)): `applied = 1` when a threshold changed, and `patch` holds the full patch in force afterwards either way. `GET /api/calibration` serves `calibration.json` deep-merged with the patch of the latest applied row. An error in the evaluation is swallowed (nothing is logged, like everything else here): retention has already run, and that day simply has no log row.

Clients see a change within about a day: the edge cache keeps the answer for an hour, and the library fetches the patch at most once a day and applies it from the next visit.

### Kill switch

`AUTO_CALIBRATION` in `wrangler.jsonc` (`vars`) is `"on"`. Set it to anything else (`"off"`) and deploy: the cron then evaluates nothing and writes no log row, and `GET /api/calibration` serves `calibration.json` alone (after at most an hour of edge cache). The log stays; setting it back to `"on"` serves the latest applied patch again and resumes the daily evaluation from it.

### Reading the log

```sh
# The last evaluations: when, how many runs, applied or not.
npx wrangler d1 execute framebudget --remote --command "SELECT id, datetime(created_at, 'unixepoch') AS at, cal, runs, excluded, applied FROM calibration_log ORDER BY id DESC LIMIT 14"
# What each effect proposed and why it moved or not, in the latest evaluation.
npx wrangler d1 execute framebudget --remote --command "SELECT json_extract(c.value, '$.effect') AS effect, json_extract(c.value, '$.from') AS from_value, json_extract(c.value, '$.to') AS to_value, json_extract(c.value, '$.proposed') AS proposed, json_extract(c.value, '$.devices') AS devices, json_extract(c.value, '$.limitedBy') AS limited_by FROM calibration_log l, json_each(l.changes) c WHERE l.id = (SELECT MAX(id) FROM calibration_log)"
# The patch in force (what GET /api/calibration merges in).
npx wrangler d1 execute framebudget --remote --command "SELECT id, datetime(created_at, 'unixepoch') AS at, patch FROM calibration_log WHERE applied = 1 ORDER BY id DESC LIMIT 1"
```

### Rolling back

- Everything at once: set `AUTO_CALIBRATION` to `"off"` (see [Kill switch](#kill-switch)). The site's own values are back within about a day.
- The latest change only: delete the latest applied rows; the endpoint then serves the patch of the previous applied row (or `calibration.json` alone when none is left), after at most an hour of edge cache. For example, the last one:

  ```sh
  npx wrangler d1 execute framebudget --remote --command "DELETE FROM calibration_log WHERE id = (SELECT MAX(id) FROM calibration_log WHERE applied = 1)"
  ```

  The cadence then counts from the remaining applied rows, so the next evaluation may apply a change again; turn the kill switch off first if the data itself is the problem.

## Calibration workflow

1. Export the reports:

   ```sh
   npx wrangler d1 execute framebudget --remote --json --command "SELECT * FROM reports" > export.json
   ```

   A CSV export with a header row works too.

2. Run the script (Node 22.18 or later: it runs `src/calibration/` with Node's type stripping; it reads the library's default reference rates from the installed `framebudget` package, so run `npm ci` first):

   ```sh
   node scripts/calibrate.mjs export.json --percentile 50 --target-fps 55 --max-under 0.05
   ```

   Options: `--percentile` (device percentile that becomes score 100, default 50), `--target-fps` (default 55), `--max-under` (largest tolerated fraction of devices under the target, default 0.05), `--min-samples` (default 10), `--cal` (version whose stored scores are the current scale, default the most common one), `--reference float=..,typed=..,alloc=..,path=..` (current reference rates, default `defaultCalibration.reference` of the installed `framebudget` package overridden by `calibration.json`).

   It prints:
   - proposed reference rates: per kernel, the warm rate of the device at the chosen percentile (rows with a warm run only), rounded to 3 significant digits;
   - the rescale factor for existing scores. A score is `100 * geomean(rate / reference)` over the kernels (the library's benchmark, [github.com/framebudget/core](https://github.com/framebudget/core)), so new score = old score x `geomean(current reference / proposed reference)`;
   - per effect, the lowest score threshold such that fewer than `--max-under` of the devices at or above it that ran the effect reported fps under the target (`fps[effect]` when present, else `fps.main`), on the current and on the proposed scale.

   Only devices that ran an effect report its fps, so the data cannot justify a threshold below the lowest score that ran it. Proposed thresholds scale the stored final score, which includes hardware caps and pressure multipliers, so they are approximate for capped devices.

   Try it on the sample: `node scripts/calibrate.mjs test/fixtures/export.json`.

   Lab runs measure effect costs directly, on every device, rather than only on devices that already run an effect. Export them and pass `--lab` (alone, or with a reports export):

   ```sh
   npx wrangler d1 execute framebudget --remote --json --command "SELECT * FROM lab_runs" > lab.json
   node scripts/calibrate.mjs --lab lab.json --max-under 0.05 --min-samples 10
   ```

   It uses the runs of one calibration version (`--cal`, default the most common) that measured a `baseline` step and have frames in their `baseline` and `baseline-end` steps, protocol 2 runs only whenever the export has any (a device that ran both protocols must not count twice), and prints per effect (every step except `baseline` and `baseline-end`; `all` is every effect at once; steps without frames left out):
   - the frame cost over the baseline, `medianMs - baseline medianMs` of the same run, as the median and p95 across devices in each score bucket (0-25, 25-50, 50-75, 75-100, 100-150, 150-200, 200+);
   - a proposed threshold: the lowest score at which fewer than `--max-under` of the devices at or above it missed by the automatic calibration's late-frame rule (more than 5% of the step's frames late, and at least 2 points above the run's `baseline` and `baseline-end` steps together; see [Automatic calibration](#automatic-calibration) for why not the p95 frame time), with at least `--min-samples` devices at or above it; otherwise `not enough devices`.

   Thresholds are on the lab's score scale (`cal`). Try it on the sample: `node scripts/calibrate.mjs --lab test/fixtures/lab-export.json`.

   Frame times stay locked to the refresh rate while a device has headroom, so on most devices that analysis reads a cost of 0. Protocol 2 runs also measure the main-thread work of each frame, and `--lab` then prints a second table, over the protocol 2 runs of the same calibration version whose `baseline` step has a work sample. Per effect:
   - the cost, `workMeanMs - baseline workMeanMs` of the same run, floored at 0, converted to the score 100 device the way `docs/src/effects.ts` models an effect (`msAt(ms, score) = ms * 100 / score`, so `ms at 100 = cost * score / 100`);
   - the devices, the median and p90 of that `ms at 100`, the effect's current `ms` read from `shared/site-effects.json`, and the median as the proposed `ms` once at least `--min-samples` devices measured the effect; otherwise `not enough devices`.

   The work excludes compositor and GPU work, so an effect like backdrop blur reads lower here than it costs. Try it on the sample: `node scripts/calibrate.mjs --lab test/fixtures/lab-work-export.json --min-samples 4`.

   Last, `--lab` prints what the daily [automatic calibration](#automatic-calibration) would apply today: the same code, runs, exclusions and guardrails as the cron (the export is loaded into an in-memory `node:sqlite` database built from `migrations/`, and the cron's own SQL selects the runs), with its fixed settings (`--max-under`, `--min-samples` and `--cal` do not apply to it). Per effect it prints the devices, the proposed threshold, the current and the resulting value and the guardrail that limited it, then the resulting patch. Pass the automatic calibration in force with `--current`, either the log export (the patch in force and the cadence, exactly as the cron reads them) or a patch JSON such as the output of `GET /api/calibration` (the patch only; the cadence goes unchecked); without it every effect starts from its baseline:

   ```sh
   npx wrangler d1 execute framebudget --remote --json --command "SELECT * FROM calibration_log WHERE applied = 1" > log.json
   node scripts/calibrate.mjs --lab lab.json --current log.json
   ```

3. Apply the result: edit the effect thresholds and `ms` in `shared/site-effects.json` (the site reads them from there; a new threshold there is the new baseline of the automatic calibration), and the library defaults, `defaultCalibration` in [github.com/framebudget/core](https://github.com/framebudget/core), when they should change for everyone (the site picks them up with the library release that ships them), and/or set `reference` (and `coldReference`) in `calibration.json`. If the reference rates move, scale every threshold and tier floor by the printed factor in the same change, so effects stay on the same devices.

4. Open a pull request, then release the website (see [Releases and deploys](#releases-and-deploys)): the release deploys the Worker and the site.

## Pull requests

`.github/workflows/ci.yml` runs on pull requests that are ready for review (drafts skip every job; marking one ready starts the run). A change under `docs/` or `shared/` runs the Site job (install and build), a change to the Worker's paths at the root (`src/`, `test/`, `migrations/`, `scripts/`, `shared/`, `wrangler.jsonc`, `calibration.json`, `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`) runs the Worker job (install, typecheck, tests), and a change to `ci.yml` runs both. The `CI` job is the one required check: it fails when any job failed and passes when the others were skipped.

## Releases and deploys

The website has its own versions, independent of the library's; the first website release is `v1.0.0`. A release is cut by pushing a tag `vX.Y.Z` to a commit on `main`, and `.github/workflows/release.yml` does the rest:

1. **Validate**: refuses a tag that already has a release, then checks the tag (format, order, bump) and classifies the commits since the previous tag with the release tooling of [github.com/framebudget/core](https://github.com/framebudget/core) (`scripts/release/`, checked out at `main`), configured by `release.config.json` (sections Site for `docs/` and Worker for the root paths above).
2. **Notes**: writes the release notes, renders the release card with the template from [github.com/framebudget/assets](https://github.com/framebudget/assets) (`brand/build/release.html`), and opens the pull request `chore(release): vX.Y.Z` that prepends the release to `CHANGELOG.md`.
3. **Deploy** (environment `production`, secret `CLOUDFLARE_API_TOKEN`): installs both projects, checks registry signatures, runs the Worker tests, builds the site, applies the D1 migrations and runs `wrangler deploy` from the root. The deployed `docs/dist` is kept as `framebudget-website-vX.Y.Z.tar.gz`.
4. **Release**: a draft release with the card, the site tarball and `SHA256SUMS`, each with a build provenance attestation, then published. Immutable releases are on, so a published release and its tag never change; the job then verifies the release attestation and every asset.

### Deploy

The D1 database `framebudget` already exists in the owner's account and its id is in `wrangler.jsonc`. To deploy by hand, from the repository root:

```sh
npm ci && npm ci --prefix docs
npm run site:build
npx wrangler d1 migrations apply framebudget --remote   # only when migrations/ changed
npm run deploy                                          # wrangler deploy: the Worker plus docs/dist
```

The lab's Turnstile secret is a Worker secret, already set on the deployed Worker; to rotate it, run `npx wrangler secret put TURNSTILE_SECRET_KEY` (never commit it). `LAB_DAILY_CAP`, `REPORT_DAILY_CAP` and the `REPORT_LIMIT` rate limiting binding ship with `wrangler.jsonc`. The report route reads `report_days`, so `migrations/0005_report_days.sql` must be applied before the deploy that adds it (otherwise every report answers 503).

`framebudget.dev` and `www.framebudget.dev` are custom domains of the Worker, so the zone must be on the same Cloudflare account. Each host is its own origin: a page on `www` reports to `www`. New migrations go in `migrations/` and are applied with `npx wrangler d1 migrations apply framebudget --remote` before the deploy that needs them.

### Verifying a release

Verify a release asset:

```sh
gh release verify vX.Y.Z --repo framebudget/website
gh release verify-asset vX.Y.Z framebudget-website-vX.Y.Z.tar.gz --repo framebudget/website
gh attestation verify framebudget-website-vX.Y.Z.tar.gz --repo framebudget/website
```

The changelog lists every release, newest first, in [`CHANGELOG.md`](CHANGELOG.md).
