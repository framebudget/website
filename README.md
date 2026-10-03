# framebudget.dev

The website of [framebudget](https://github.com/framebudget/core), the browser library that decides, per device, which visual effects a site can afford.

| Path | What it is |
| --- | --- |
| repository root | The Cloudflare Worker (see [The Worker](#the-worker)): `src/`, `test/`, `migrations/`, `scripts/calibrate.mjs`, `wrangler.jsonc`, `calibration.json`. It serves `docs/dist` through its static assets layer, receives the library's anonymous reports (`POST /api/report`, stored in D1) and serves the calibration patch (`GET /api/calibration`). |
| [`docs/`](docs/README.md) | The site: landing page, API reference, privacy page, error pages and the files for AI agents (`llms.txt`, `llm.txt`, `llms-full.txt`). A static Vite build with its own `package.json`, and a live demo of the library. |

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

Run the retention job locally with `npx wrangler dev --local --test-scheduled` and `curl "http://localhost:8787/__scheduled?cron=17+3+*+*+*"`. Local D1 state lives in `.wrangler/` (ignored by git).

Tests and types:

```sh
npm test               # Vitest, test/ only; handler tests run against in-memory SQLite with the real migration,
                       # assets.test.ts runs wrangler.jsonc's routing in wrangler's local runtime,
                       # validate.test.ts checks the report the installed framebudget package sends
npm run typecheck      # src/ with the Workers types, then test/
```

## The Worker

One Cloudflare Worker (free plan) for framebudget.dev:

- Serves the landing site (`docs/dist`, the Vite build) through the static assets layer. Static files are served without running the Worker, so they cost nothing and do not count against Worker requests. `html_handling` is `auto-trailing-slash`: `/` serves `index.html`, `/api` and `/privacy` serve `api.html` and `privacy.html`, which is how the site links them. `/privacy.html` redirects to `/privacy`. `not_found_handling` is `404-page`: a path with no matching file gets `404.html` (`docs/404.html`) with status 404, from the asset layer.
- `POST /api/report`: receives the anonymous report the library sends with `navigator.sendBeacon` and stores one row in D1.
- `GET /api/calibration`: returns the calibration patch the library fetches at most once a day.
- A daily cron deletes reports older than 400 days.

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

Returns `calibration.json` with `Cache-Control: public, max-age=3600`, and stores it in the edge cache (`caches.default`) for an hour. Other methods get 405.

The patch is a JSON file in the repository, bundled into the Worker at build time, instead of a row in D1 or a KV value. Calibration changes then go through pull request review, ship with a deploy, and need no extra storage, admin endpoint or secret. It starts as `{}`: the library defaults stay in force. Note that `mergeCalibration(defaultCalibration, remote, ...sitePatches)` lets the site's own patch (effect thresholds in `docs/src/effects.ts`) win over this one, so this file mainly matters for other sites using the library and for reference rates, cold reference rates, tier floors, caps and pressure multipliers. Changing `reference` changes `calibrationKey`, which invalidates cached scores on every device; only change it with a calibration run, not as a no-op edit.

### Data collected

Each row holds exactly what the library's `TelemetryReport` contains, plus coarse facts derived from request headers:

- From the report: calibration version, final score, cold and warm benchmark scores, per-kernel rates, clock resolution, core count, device memory, Compute Pressure state, reduced-motion preference, tier, effects that ran, effects the governor stepped down, median fps per source.
- Derived server-side: UTC day (no time of day), engine family and major version, OS family, phone-class flag, two-letter country from `request.cf.country`.

Not collected, not stored, not logged: IP address, User-Agent string, client hint values, cookies, any identifier, the page URL, referrer, time of day, city or region. The raw headers are read once to derive the coarse fields (`src/client.ts`) and then discarded. Nothing is logged by the Worker.

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

### Retention

The cron trigger (`17 3 * * *`, daily) runs `DELETE FROM reports WHERE created_day < ?` with the UTC day 400 days before the run. A report from exactly 400 days ago is kept; one day older is deleted.

### Free plan notes

- Workers free plan: 100,000 Worker requests per day. Static asset requests are free and unlimited. The Worker runs only for `/api/*` (missing pages get `404.html` from the asset layer); a browser costs at most one Worker request a week for the report (`minIntervalDays: 7`), plus the calibration fetch at most once a day.
- D1 free plan: 5 GB storage, 100,000 rows written and 5 million rows read per day. A row is about 400 bytes. Every browser reports (`sampleRate: 1`) but at most once a week (`minIntervalDays: 7`), so rows track weekly unique browsers rather than page views; 400 days of retention fit in 5 GB up to about 30,000 reports a day (12 million rows). Past the daily write limit, inserts fail and the Worker answers 503 until the next day; nothing is billed.
- No rate limiting binding is configured. The Workers Rate Limiting API page does not state whether the binding is available on the free plan, so it is left out rather than risk a failed deploy. If added later, key it by a constant or by route, never by IP.

## Calibration workflow

1. Export the reports:

   ```sh
   npx wrangler d1 execute framebudget --remote --json --command "SELECT * FROM reports" > export.json
   ```

   A CSV export with a header row works too.

2. Run the script (plain Node; it reads the library's default reference rates from the installed `framebudget` package, so run `npm ci` first):

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

3. Apply the result: edit the effect thresholds in `docs/src/effects.ts` (and the library defaults, `defaultCalibration` in [github.com/framebudget/core](https://github.com/framebudget/core), when they should change for everyone; the site picks them up with the library release that ships them), and/or set `reference` (and `coldReference`) in `calibration.json`. If the reference rates move, scale every threshold and tier floor by the printed factor in the same change, so effects stay on the same devices.

4. Open a pull request, then release the website (see [Releases and deploys](#releases-and-deploys)): the release deploys the Worker and the site.

## Pull requests

`.github/workflows/ci.yml` runs on pull requests that are ready for review (drafts skip every job; marking one ready starts the run). A change under `docs/` runs the Site job (install and build), a change to the Worker's paths at the root (`src/`, `test/`, `migrations/`, `scripts/`, `wrangler.jsonc`, `calibration.json`, `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`) runs the Worker job (install, typecheck, tests), and a change to `ci.yml` runs both. The `CI` job is the one required check: it fails when any job failed and passes when the others were skipped.

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

`framebudget.dev` and `www.framebudget.dev` are custom domains of the Worker, so the zone must be on the same Cloudflare account. Each host is its own origin: a page on `www` reports to `www`. New migrations go in `migrations/` and are applied with `npx wrangler d1 migrations apply framebudget --remote` before the deploy that needs them.

### Verifying a release

Verify a release asset:

```sh
gh release verify vX.Y.Z --repo framebudget/website
gh release verify-asset vX.Y.Z framebudget-website-vX.Y.Z.tar.gz --repo framebudget/website
gh attestation verify framebudget-website-vX.Y.Z.tar.gz --repo framebudget/website
```

The changelog lists every release, newest first, in [`CHANGELOG.md`](CHANGELOG.md).
