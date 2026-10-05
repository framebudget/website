# framebudget.dev

The website of [framebudget](https://github.com/framebudget/core), the browser library that decides, per device, which visual effects a site can afford.

| Path | What it is |
| --- | --- |
| repository root | The Cloudflare Worker (see [The Worker](#the-worker)): `src/`, `test/`, `migrations/`, `scripts/calibrate.mjs`, `wrangler.jsonc`, `calibration.json`. It serves `docs/dist` through its static assets layer, receives the library's anonymous reports (`POST /api/report`, stored in D1), serves the calibration patch (`GET /api/calibration`), stores the opt-in lab runs (`POST /api/lab/runs`, `POST /api/lab/runs/<run>/steps`, stored in D1) and calibrates the site's effect thresholds from them every day (see [Automatic calibration](#automatic-calibration)). |
| `shared/site-effects.json` | The site's effect numbers (threshold, cost, ms, motion and data flags per effect) and tier floors: the baseline the automatic calibration starts from and never drifts far from. Today they must equal `docs/src/effects.ts` (a Worker test fails otherwise); the site will read them from this file. |
| [`docs/`](docs/README.md) | The site: landing page, API reference, privacy page, the opt-in lab (`/lab`), error pages and the files for AI agents (`llms.txt`, `llm.txt`, `llms-full.txt`). A static Vite build with its own `package.json`, and a live demo of the library. |

Related repositories: the library is [github.com/framebudget/core](https://github.com/framebudget/core) (the npm packages `framebudget`, `@framebudget/core` and `@framebudget/react`), and the brand (fonts, logos, tokens, the release card template) is [github.com/framebudget/assets](https://github.com/framebudget/assets).

## The library as a dependency

The site and the Worker's tests use the published library, never its source. Until the library is on npmjs, `docs/package.json` (dependency) and the root `package.json` (devDependency) install it from a release asset of [framebudget/core](https://github.com/framebudget/core/releases): `"framebudget": "https://github.com/framebudget/core/releases/download/v0.2.1/framebudget-framebudget-0.2.1.tgz"`, today's full package. Release assets are immutable and public, so no registry or token is involved, and both lockfiles pin the tarball's integrity. Check the tarball against the core release attestation with:

```sh
gh release download v0.2.1 --repo framebudget/core --pattern 'framebudget-framebudget-0.2.1.tgz'
gh release verify-asset v0.2.1 framebudget-framebudget-0.2.1.tgz --repo framebudget/core
```

The package's `README.md` becomes `llms-full.txt`, and the Worker's calibration script reads `defaultCalibration` from it. To move to a new library release, change the URL in both `package.json` files, run `npm install` at the root and in `docs/`, and commit both lockfiles.

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
                       # sends, site-effects.test.ts checks shared/site-effects.json against docs/src/effects.ts
npm run typecheck      # src/ with the Workers types, then test/
```

## The Worker

One Cloudflare Worker (free plan) for framebudget.dev:

- Serves the landing site (`docs/dist`, the Vite build) through the static assets layer. Static files are served without running the Worker, so they cost nothing and do not count against Worker requests. `html_handling` is `auto-trailing-slash`: `/` serves `index.html`, `/api` and `/privacy` serve `api.html` and `privacy.html`, which is how the site links them. `/privacy.html` redirects to `/privacy`. `not_found_handling` is `404-page`: a path with no matching file gets `404.html` (`docs/404.html`) with status 404, from the asset layer.
- `POST /api/report`: receives the anonymous report the library sends with `navigator.sendBeacon` and stores one row in D1.
- `GET /api/calibration`: returns the calibration patch the library fetches at most once a day: `calibration.json` with the latest automatic thresholds merged in.
- `POST /api/lab/runs` and `POST /api/lab/runs/<run>/steps`: the opt-in lab (`/lab`). A visitor who consents and passes Turnstile gets one row; each measured step updates that row.
- A daily cron deletes reports, lab runs and calibration log rows older than 400 days, closes expired lab runs, then calibrates the effect thresholds from the lab runs (see [Automatic calibration](#automatic-calibration)).

The data exists to calibrate the score scale (reference rates) and the effect thresholds on real devices.

### Routing and errors

`run_worker_first: ["/api/*"]` is the only way into the Worker: every other path, matched or not, is answered by the asset layer, so a missing page never costs a Worker request. `/api` itself is the API reference page; `/api/` and below are the Worker's.

The fetch entry (`handleFetchSafely` in `src/handler.ts`) catches any error the handler throws. A page load (an `Accept` header with `text/html`, outside `/api/`) gets the site's `500.html` with status 500 and `Cache-Control: no-store`, fetched from the assets binding as `/500` (`/500.html` would redirect there); anything else, the API included, gets a bare 500, as the API's other errors do. With today's routing only `/api/*` reaches the Worker, so the page is a safety net for routes added later. The error is not logged, like everything else here.

### Endpoints

#### `POST /api/report`

Accepted only when all of these hold, otherwise a bare status with no body:

| Check | Failure |
| --- | --- |
| Path is exactly `/api/report` | 404 |
| Method is `POST` | 405 |
| `Origin` equals the request origin, or `Origin` is absent and `Sec-Fetch-Site: same-origin` | 403 |
| `Content-Type` is `text/plain` (what `sendBeacon` sends for a string) or `application/json` | 415 |
| `Content-Length` (when present) and the bytes actually read are at most 4096; reading stops past the limit | 413 |
| Body is UTF-8 JSON and a valid v1 report (`src/validate.ts`) | 400 |
| Insert succeeds | 503 |

Success is `204 No Content`. Validation is strict: exact keys at every level, `v === 1`, integer scores 0..10000, kernel rates finite and positive, effect and fps names matching `^[A-Za-z][A-Za-z0-9_-]{0,31}$`, at most 64 effects with no duplicates, at most 40 fps sources with whole values 0..1000, known tier and pressure values. Any other `/api/*` path answers a bare 404.

#### `GET /api/calibration`

Returns `calibration.json` deep-merged with the patch of the latest applied row of `calibration_log` (the automatic thresholds win; see [Automatic calibration](#automatic-calibration)), with `Cache-Control: public, max-age=3600`, and stores it in the edge cache (`caches.default`) for an hour. Without an applied row, while the kill switch `AUTO_CALIBRATION` is not `on`, or when D1 fails (that answer is not cached), it returns `calibration.json` alone. Other methods get 405.

`calibration.json` is a JSON file in the repository, bundled into the Worker at build time, instead of a row in D1 or a KV value: hand-made calibration changes go through pull request review, ship with a deploy, and need no extra storage, admin endpoint or secret. It starts as `{}`: the library defaults stay in force. The automatic thresholds are the only part that lives in D1, behind the guardrails of [Automatic calibration](#automatic-calibration). The library applies the remote patch over its defaults and the site's `calibrationDefaults`, and under the site's `calibration` patches (core v0.4.0); while the site still passes its thresholds as `calibration`, the site's values win and the automatic thresholds have no effect on framebudget.dev. Changing `reference` changes `calibrationKey`, which invalidates cached scores on every device; only change it with a calibration run, not as a no-op edit.

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
| Same origin, as for `/api/report` | 403 |
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

Not collected, not stored, not logged, for reports and lab runs alike: IP address, User-Agent string, client hint values, cookies, any identifier, the page URL, referrer, time of day, city or region. The raw headers are read once to derive the coarse fields (`src/client.ts`) and then discarded. Turnstile's siteverify gets the token and the secret, not the IP. Nothing is logged by the Worker.

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
| `runs` | INTEGER | Lab runs counted |
| `excluded` | INTEGER | Lab runs of that version excluded (refresh rate, missing baseline, busy baseline, thermal throttling) |
| `patch` | TEXT | The full automatic patch in force after this evaluation, a `CalibrationPatch` JSON with `effects.<name>.threshold` only |
| `changes` | TEXT | JSON array, one `{effect, from, to, proposed, devices, limitedBy}` per effect evaluated |
| `applied` | INTEGER | 1 when at least one threshold changed |

Index: `created_at` (retention). One small row a day.

### Retention

The cron trigger (`17 3 * * *`, daily) runs, with the UTC day 400 days before the run:

- `DELETE FROM reports WHERE created_day < ?`
- `DELETE FROM lab_runs WHERE created_day < ?`
- `UPDATE lab_runs SET write_key_hash = NULL, open_until = NULL WHERE open_until < ?` (the current epoch second): runs the page abandoned are closed, so no time of day survives a run.
- `DELETE FROM calibration_log WHERE created_at < ? AND id <> COALESCE((SELECT MAX(id) FROM calibration_log WHERE applied = 1), 0)` (the epoch second that UTC day starts): the latest applied row stays however old, since it holds the patch in force.

A row from exactly 400 days ago is kept; one day older is deleted. The automatic calibration runs after these statements, in the same job.

### Free plan notes

- Workers free plan: 100,000 Worker requests per day. Static asset requests are free and unlimited. The Worker runs only for `/api/*` (missing pages get `404.html` from the asset layer); a browser costs at most one Worker request a week for the report (`minIntervalDays: 7`), plus the calibration fetch at most once a day.
- D1 free plan: 5 GB storage, 100,000 rows written and 5 million rows read per day. A row is about 400 bytes. Every browser reports (`sampleRate: 1`) but at most once a week (`minIntervalDays: 7`), so rows track weekly unique browsers rather than page views; 400 days of retention fit in 5 GB up to about 30,000 reports a day (12 million rows). Past the daily write limit, inserts fail and the Worker answers 503 until the next day; nothing is billed.
- Lab: `LAB_DAILY_CAP` (a var in `wrangler.jsonc`, `"1000"`) bounds new runs per UTC day. A run is at most 21 row writes (the insert and 20 steps), so the lab adds at most about 21,000 row writes a day, and the cap's `COUNT(*)` reads at most one index entry per run already created that day (about 500,000 rows read a day at the cap). A run is about 4 KB (27 KB at most), so 400 days at the cap take about 1.6 GB. Change the cap in `wrangler.jsonc` and deploy; `"0"` closes the lab. Turnstile guards run creation, and the write key guards each run's steps.
- No rate limiting binding is configured. The Workers Rate Limiting API page does not state whether the binding is available on the free plan, so it is left out rather than risk a failed deploy. If added later, key it by a constant or by route, never by IP.
- Automatic calibration: once a day it reads the columns it needs of every completed protocol 2 run of the last 400 days (one row read per run) and the applied log rows, and writes one log row. The steps of every run are parsed in the Worker's memory: a few thousand runs take a few MB, but months at the full `LAB_DAILY_CAP` (hundreds of thousands of runs, about 4 KB each) would not fit the Worker's memory and CPU limits, and the evaluation would then fail every day (retention still runs; no log row is written). Lower the cap or add a bound before the lab gets there.

## Automatic calibration

Every day, after retention, the cron evaluates the effect thresholds of framebudget.dev from the lab runs and, within hard guardrails, changes them without anyone editing a file. The code is `src/calibration/`; `scripts/calibrate.mjs --lab` runs the same code and prints what the cron would apply today.

1. **Runs.** Completed lab runs with `protocol >= 2` from the last 400 days, of the most common calibration version among them (scores of different versions are on different scales). Protocol 1 runs and other versions are ignored. Each remaining run is excluded when its refresh rate is outside 30..360 Hz, when it lacks the `baseline` or the `baseline-end` step, when its `baseline` p95 frame time is above 1.5 refresh intervals (the device was busy before any effect), or when its `baseline-end` p95 is more than 25% above its `baseline` p95 (it throttled during the run). The rest are counted.
2. **Proposal.** For each effect of `shared/site-effects.json` that a counted run measured (the lab cannot drive `hover`, `sound`, `morph`, `pageTransition`, `springs`, `magnetic` and `spotlight`), the proposed threshold is the lowest device score S such that, among the counted devices with score >= S that ran the effect, fewer than 5% had a step p95 frame time above `(1000 / 55) * (60 / refreshHz)` ms (18.18 ms at 60 Hz, 9.09 ms at 120 Hz), with at least 10 such devices. Otherwise there is no proposal and the effect keeps its value (`limitedBy: "devices"`). The search is `src/calibration/search.ts`, the one the script's `--lab` table uses too.
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
   node scripts/calibrate.mjs --lab lab.json --target-fps 55 --max-under 0.05 --min-samples 10
   ```

   It uses the runs of one calibration version (`--cal`, default the most common) that measured a `baseline` step, protocol 2 runs only whenever the export has any (a device that ran both protocols must not count twice), and prints per effect (every step except `baseline` and `baseline-end`; `all` is every effect at once):
   - the frame cost over the baseline, `medianMs - baseline medianMs` of the same run, as the median and p95 across devices in each score bucket (0-25, 25-50, 50-75, 75-100, 100-150, 150-200, 200+);
   - a proposed threshold: the lowest score at which fewer than `--max-under` of the devices at or above it had a p95 frame time over the target, which is `1000 / --target-fps` ms at 60 Hz scaled by the refresh rate (18.18 ms at 60 Hz, 9.09 ms at 120 Hz by default), with at least `--min-samples` devices at or above it; otherwise `not enough devices`.

   Thresholds are on the lab's score scale (`cal`). Try it on the sample: `node scripts/calibrate.mjs --lab test/fixtures/lab-export.json`.

   Frame times stay locked to the refresh rate while a device has headroom, so on most devices that analysis reads a cost of 0. Protocol 2 runs also measure the main-thread work of each frame, and `--lab` then prints a second table, over the protocol 2 runs of the same calibration version whose `baseline` step has a work sample. Per effect:
   - the cost, `workMeanMs - baseline workMeanMs` of the same run, floored at 0, converted to the score 100 device the way `docs/src/effects.ts` models an effect (`msAt(ms, score) = ms * 100 / score`, so `ms at 100 = cost * score / 100`);
   - the devices, the median and p90 of that `ms at 100`, the effect's current `ms` read from `shared/site-effects.json`, and the median as the proposed `ms` once at least `--min-samples` devices measured the effect; otherwise `not enough devices`.

   The work excludes compositor and GPU work, so an effect like backdrop blur reads lower here than it costs. Try it on the sample: `node scripts/calibrate.mjs --lab test/fixtures/lab-work-export.json --min-samples 4`.

   Last, `--lab` prints what the daily [automatic calibration](#automatic-calibration) would apply today: the same code, runs, exclusions and guardrails as the cron, with its fixed settings (`--target-fps`, `--max-under`, `--min-samples` and `--cal` do not apply to it). Per effect it prints the devices, the proposed threshold, the current and the resulting value and the guardrail that limited it, then the resulting patch. Pass the automatic calibration in force with `--current`, either the log export (the patch in force and the cadence, exactly as the cron reads them) or a patch JSON such as the output of `GET /api/calibration` (the patch only; the cadence goes unchecked); without it every effect starts from its baseline:

   ```sh
   npx wrangler d1 execute framebudget --remote --json --command "SELECT * FROM calibration_log WHERE applied = 1" > log.json
   node scripts/calibrate.mjs --lab lab.json --current log.json
   ```

3. Apply the result: edit the effect thresholds and `ms` in both `docs/src/effects.ts` and `shared/site-effects.json` (the Worker's tests fail when they disagree; a new threshold there is the new baseline of the automatic calibration), and the library defaults, `defaultCalibration` in [github.com/framebudget/core](https://github.com/framebudget/core), when they should change for everyone (the site picks them up with the library release that ships them), and/or set `reference` (and `coldReference`) in `calibration.json`. If the reference rates move, scale every threshold and tier floor by the printed factor in the same change, so effects stay on the same devices.

4. Open a pull request, then release the website (see [Releases and deploys](#releases-and-deploys)): the release deploys the Worker and the site.

## Pull requests

`.github/workflows/ci.yml` runs on pull requests that are ready for review (drafts skip every job; marking one ready starts the run). A change under `docs/` or `shared/` runs the Site job (install and build), a change to the Worker's paths at the root (`src/`, `test/`, `migrations/`, `scripts/`, `shared/`, `wrangler.jsonc`, `calibration.json`, `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`) or to `docs/src/effects.ts` (checked against `shared/site-effects.json`) runs the Worker job (install, typecheck, tests), and a change to `ci.yml` runs both. The `CI` job is the one required check: it fails when any job failed and passes when the others were skipped.

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

The lab's Turnstile secret is a Worker secret, already set on the deployed Worker; to rotate it, run `npx wrangler secret put TURNSTILE_SECRET_KEY` (never commit it). `LAB_DAILY_CAP` ships with `wrangler.jsonc`.

`framebudget.dev` and `www.framebudget.dev` are custom domains of the Worker, so the zone must be on the same Cloudflare account. Each host is its own origin: a page on `www` reports to `www`. New migrations go in `migrations/` and are applied with `npx wrangler d1 migrations apply framebudget --remote` before the deploy that needs them.

### Verifying a release

Verify a release asset:

```sh
gh release verify vX.Y.Z --repo framebudget/website
gh release verify-asset vX.Y.Z framebudget-website-vX.Y.Z.tar.gz --repo framebudget/website
gh attestation verify framebudget-website-vX.Y.Z.tar.gz --repo framebudget/website
```

The changelog lists every release, newest first, in [`CHANGELOG.md`](CHANGELOG.md).
