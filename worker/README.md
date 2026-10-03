# framebudget Worker

One Cloudflare Worker (free plan) for framebudget.dev:

- Serves the landing site (`site/dist`, the Vite build) through the static assets layer. Static files are served without running the Worker, so they cost nothing and do not count against Worker requests. `html_handling` is `auto-trailing-slash`: `/` serves `index.html`, `/api` and `/privacy` serve `api.html` and `privacy.html`, which is how the site links them. `/privacy.html` redirects to `/privacy`.
- `POST /api/report`: receives the anonymous report the library sends with `navigator.sendBeacon` and stores one row in D1.
- `GET /api/calibration`: returns the calibration patch the library fetches at most once a day.
- A daily cron deletes reports older than 400 days.

The data exists to calibrate the score scale (reference rates) and the effect thresholds on real devices.

## Endpoints

### `POST /api/report`

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

### `GET /api/calibration`

Returns `worker/calibration.json` with `Cache-Control: public, max-age=3600`, and stores it in the edge cache (`caches.default`) for an hour. Other methods get 405.

The patch is a JSON file in the repository, bundled into the Worker at build time, instead of a row in D1 or a KV value. Calibration changes then go through pull request review, ship with a deploy, and need no extra storage, admin endpoint or secret. It starts as `{}`: the library defaults stay in force. Note that `mergeCalibration(defaultCalibration, remote, ...sitePatches)` lets the site's own patch (effect thresholds in `site/src/effects.ts`) win over this one, so this file mainly matters for other sites using the library and for reference rates, cold reference rates, tier floors, caps and pressure multipliers. Changing `reference` changes `calibrationKey`, which invalidates cached scores on every device; only change it with a calibration run, not as a no-op edit.

## Data collected

Each row holds exactly what the library's `TelemetryReport` contains, plus coarse facts derived from request headers:

- From the report: calibration version, final score, cold and warm benchmark scores, per-kernel rates, clock resolution, core count, device memory, Compute Pressure state, reduced-motion preference, tier, effects that ran, effects the governor stepped down, median fps per source.
- Derived server-side: UTC day (no time of day), engine family and major version, OS family, phone-class flag, two-letter country from `request.cf.country`.

Not collected, not stored, not logged: IP address, User-Agent string, client hint values, cookies, any identifier, the page URL, referrer, time of day, city or region. The raw headers are read once to derive the coarse fields (`src/client.ts`) and then discarded. Nothing is logged by the Worker.

## Schema

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

## Local development

From the repository root:

```sh
npm install
npm run build -w framebudget          # library
npm run build -w framebudget-site     # site/dist, served by the assets binding
cd worker
npx wrangler d1 migrations apply framebudget --local   # or: npm run migrate:local
npx wrangler dev --local                               # or: npm run dev
```

Then, with the port wrangler prints (8787 by default):

```sh
curl -i -X POST http://localhost:8787/api/report \
  -H 'Origin: http://localhost:8787' -H 'Content-Type: text/plain;charset=UTF-8' \
  --data-binary '{"v":1,"cal":"provisional-1","score":62,"cold":48,"warm":66,"kernels":{"float":7130,"typed":151000,"alloc":18200,"path":3010},"tickMs":0.1,"hints":{"cores":8,"memoryGb":4,"reducedMotion":false},"tier":"Medium","effects":["canvasLowRes","entrances","hover"],"stepped":[],"fps":{"main":58,"canvasLowRes":55}}'
npx wrangler d1 execute framebudget --local --command "SELECT * FROM reports"
curl -i http://localhost:8787/api/calibration
```

Run the retention job locally with `npx wrangler dev --local --test-scheduled` and `curl "http://localhost:8787/__scheduled?cron=17+3+*+*+*"`. Local D1 state lives in `worker/.wrangler/` (ignored by git).

Tests and types:

```sh
npm test -w framebudget-worker        # Vitest; handler tests run against in-memory SQLite with the real migration
npm run typecheck -w framebudget-worker
```

## Calibration workflow

1. Export the reports:

   ```sh
   cd worker
   npx wrangler d1 execute framebudget --remote --json --command "SELECT * FROM reports" > export.json
   ```

   A CSV export with a header row works too.

2. Run the script (plain Node, no dependencies):

   ```sh
   node worker/scripts/calibrate.mjs export.json --percentile 50 --target-fps 55 --max-under 0.05
   ```

   Options: `--percentile` (device percentile that becomes score 100, default 50), `--target-fps` (default 55), `--max-under` (largest tolerated fraction of devices under the target, default 0.05), `--min-samples` (default 10), `--cal` (version whose stored scores are the current scale, default the most common one), `--reference float=..,typed=..,alloc=..,path=..` (current reference rates, default the library defaults overridden by `worker/calibration.json`).

   It prints:
   - proposed reference rates: per kernel, the warm rate of the device at the chosen percentile (rows with a warm run only), rounded to 3 significant digits;
   - the rescale factor for existing scores. A score is `100 * geomean(rate / reference)` over the kernels (`packages/framebudget/src/bench.ts`), so new score = old score x `geomean(current reference / proposed reference)`;
   - per effect, the lowest score threshold such that fewer than `--max-under` of the devices at or above it that ran the effect reported fps under the target (`fps[effect]` when present, else `fps.main`), on the current and on the proposed scale.

   Only devices that ran an effect report its fps, so the data cannot justify a threshold below the lowest score that ran it. Proposed thresholds scale the stored final score, which includes hardware caps and pressure multipliers, so they are approximate for capped devices.

   Try it on the sample: `node worker/scripts/calibrate.mjs worker/test/fixtures/export.json`.

3. Apply the result: edit the effect thresholds in `site/src/effects.ts` (and the library defaults in `packages/framebudget/src/calibration.ts` when they should change for everyone), and/or set `reference` (and `coldReference`) in `worker/calibration.json`. If the reference rates move, scale every threshold and tier floor by the printed factor in the same change, so effects stay on the same devices.

4. Open a pull request, then deploy (`npm run deploy` at the root).

## Retention

The cron trigger (`17 3 * * *`, daily) runs `DELETE FROM reports WHERE created_day < ?` with the UTC day 400 days before the run. A report from exactly 400 days ago is kept; one day older is deleted.

## Free plan notes

- Workers free plan: 100,000 Worker requests per day. Static asset requests are free and unlimited. The Worker runs only for `/api/*` and for paths with no asset; page views cost one Worker request each, for the report (the calibration fetch is at most once a day per browser).
- D1 free plan: 5 GB storage, 100,000 rows written and 5 million rows read per day. A row is about 400 bytes, and the site reports every page view (`sampleRate: 1`), so 400 days of retention fit in 5 GB up to about 30,000 page views a day (12 million rows). Past the daily write limit, inserts fail and the Worker answers 503 until the next day; nothing is billed.
- No rate limiting binding is configured. The Workers Rate Limiting API page does not state whether the binding is available on the free plan, so it is left out rather than risk a failed deploy. If added later, key it by a constant or by route, never by IP.

## Deploy

The D1 database `framebudget` already exists in the owner's account and its id is in `worker/wrangler.jsonc`.

```sh
cd worker && npx wrangler d1 migrations apply framebudget --remote && cd ..   # only when migrations/ changed
npm run deploy    # builds the library and site, then wrangler deploy
```

`framebudget.dev` and `www.framebudget.dev` are custom domains of the Worker, so the zone must be on the same Cloudflare account. Each host is its own origin: a page on `www` reports to `www`. New migrations go in `migrations/` and are applied with `npx wrangler d1 migrations apply framebudget --remote` before the deploy that needs them.
