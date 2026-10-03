# framebudget site

The landing page and API reference for framebudget. The page is also a demo of the library: every effect on it is registered with framebudget and only runs while the budget allows it. Pick a slower device in the hero or the simulator and the page really changes.

## Commands

Run these in `docs/`. The site depends on the published library: `framebudget` in `package.json` is the 0.2.1 release tarball of framebudget/core, pinned by integrity in `package-lock.json` (see the repository `README.md`). The library's source is [github.com/framebudget/core](https://github.com/framebudget/core).

| Command | What it does |
| --- | --- |
| `npm ci` | Installs Vite, TypeScript, `motion`, `cuelume` and `framebudget` exactly as `package-lock.json` pins them. |
| `npm run dev` | Starts the Vite dev server with hot reload. |
| `npm run build` | Type-checks, then writes the static site to `dist/`. |
| `npm run serve` | Serves `dist/` with gzip and long-lived caching for hashed assets, like a production host. Extensionless paths serve the matching page (`/api` serves `api.html`) and missing paths get `404.html` with status 404, like the Worker. Optional port: `npm run serve -- 8080`. |
| `node scripts/interaction-check.mjs <cdp-url> <url-part> <throttle> <selector>...` | Clicks each selector with real input events through the DevTools protocol of an open browser, under CPU throttling, and reports the interaction time, long tasks, layout shift and any view transition. |

## How it uses framebudget

- `vite.config.ts` inlines `createBootScript({ calibration })` at the top of `<head>` on every page, so the decision is on `<html>` before the first paint. A second small inline script skips the cross-document view transition when `pageTransition` is off. It also renders the static parts (header, footer, dock, device pickers, tables, highlighted code) from `src/render.ts`, so the first paint has its final layout.
- `src/effects.ts` is the effect registry: name, threshold, cost, flags, and the frame time each effect spends on the reference device. The same `calibration` goes to the boot script and to `configure()` in `src/setup.ts`.
- CSS gates effects with `:root[data-framebudget-effects~="name"]`. Scripts subscribe once through `src/state.ts`, which batches every change into one animation frame, and `onEffect(name, fn)` runs only when that effect flips.
- One `requestAnimationFrame` loop (`src/loop.ts`) runs every animated part. It stops when nothing on screen needs it and while the tab is hidden, and it reports the real gap between frames to the governor (framebudget's own sampler is off with `governor: { auto: false }`).
- The simulator calls `budget.simulate(score)` and `budget.simulate(null)`. The simulated device lasts for the tab, across pages and reloads, and the dock at the bottom of every page leads back. The load test burns the simulated device's frame time on the main thread and reports it as `loadTest`, so the governor steps effects down for real.
- `motion` (the WAAPI build, plus its spring generator) and `cuelume` are loaded on idle, and only when an effect that uses them is allowed. Under `prefers-reduced-motion: reduce` nothing moves and `motion` is never fetched.

## Effects

| Name | Label | Threshold | Cost | Flags |
| --- | --- | --- | --- | --- |
| `hover` | Hover states | 10 | 1 | |
| `counters` | Counting numbers | 12 | 1 | motion |
| `sound` | Interface sounds | 20 | 1 | data |
| `entrances` | Staggered reveals | 24 | 2 | motion |
| `canvasLowRes` | Frame chart, 1x | 32 | 3 | motion |
| `shimmer` | Deadline glow | 38 | 2 | motion |
| `textReveal` | Text reveals | 46 | 2 | motion |
| `morph` | Morphing controls | 49 | 2 | motion |
| `pageTransition` | Page transitions | 62 | 3 | motion |
| `springs` | Spring presses | 66 | 3 | motion |
| `magnetic` | Magnetic buttons | 85 | 2 | motion |
| `parallax` | Parallax | 90 | 5 | motion |
| `spotlight` | Cursor spotlight | 112 | 4 | motion |
| `blur` | Backdrop blur | 135 | 6 | |
| `canvasHiRes` | Frame chart, full res | 180 | 8 | motion, data |

The thresholds sit between the simulator's presets (Flagship 2025 240, Upper mid-range 2023 150, Reference 100, Mid-range 2020 75, Budget 2021 55, Budget 2019 45, Old budget 2017 28, Ancient 15), outside the 10% hysteresis band where the spacing allows, so each step down turns off one or two effects. The site's tier floors follow them: Lite 20, Medium 49, High 90, Full 180. The hero's picker offers five of the presets; the simulator lists all of them.

## Sharing measurements

The site enables framebudget's telemetry for its own visitors (`src/share.ts`, `src/setup.ts`): `endpoint: "/api/report"`, `sampleRate: 1`, `minIntervalDays: 7`, `calibrationUrl: "/api/calibration"`, served by the Worker at the repository root (see the root `README.md`). A notice at the bottom of the first visit says what is measured and links to `privacy.html`; **Don't share** stores `framebudget-site-share=off` in `localStorage` and calls `configure({ share: null })`, so nothing is sent from that moment on. The privacy page has the same control. GPC and Save-Data are honored by the library.

## The lab

`lab.html` (`/lab`, linked from the footer and the privacy page) is an opt-in calibration test. Nothing runs until the visitor presses **Run the test and share the results**. Then `src/lab/main.ts`:

1. Loads Cloudflare Turnstile (`src/lab/turnstile.ts`, explicit render, only on this page and only after the press) and gets a token. On `localhost` and `127.0.0.1` it uses Cloudflare's always-passing test sitekey.
2. Waits for framebudget's warm benchmark, measures the refresh rate from a second of idle frames, and creates the run with `POST /api/lab/runs` (`src/lab/api.ts`, `src/lab/device.ts` for the rounded device fields).
3. Runs the steps in `src/lab/steps.ts`: `baseline`, each effect that runs without the visitor's input, `all`, and `baseline-end`. Each step forces its exact effect set with `forceEffects()` from `src/state.ts`, builds a fresh stage (`src/lab/stage.ts`: a track of sections that scrolls under the header, and a panel at the bottom with the parallax layers, the frame chart, the install line and four counters), lets it settle, then scrolls the page and changes the counters for 5 seconds while `src/lab/measure.ts` records every frame gap through `setProbe()` in `src/loop.ts`. Every step gets the same stage, scroll and counter changes; only the effect set differs.
4. Between steps nothing runs: the set goes back to none, the stage empties, and the step is sent with `POST /api/lab/runs/<run>/steps`. The last step is sent with `done: true`. A step that sees the tab hidden runs once more; a second hidden attempt stops the run.
5. Shows the results table and only then writes `framebudget-lab` (`{"cal", "day"}`, no id) to `localStorage`, so the button stays hidden for the same calibration version.

The override lives in `src/force.ts`. While a set is forced, `allows()` answers from it for the chart, the motion gate and the reveal observers, `state.ts` hands it to every view (`watch`, `onEffect`), the `data-framebudget-effects` attribute on `<html>` holds it (a `MutationObserver` puts it back if framebudget rewrites the attribute), and no frame reaches the governor, so a run neither steps effects down nor teaches framebudget to skip them on later visits. `forceEffects(null)` returns to framebudget's decision.

Hover states, sounds, morphing controls, page transitions, spring presses, magnetic buttons and the cursor spotlight need the visitor's pointer, a press or a navigation, so the lab lists them as not measured. The API, the table and retention are described in the root `README.md`; the visitor-facing details are on the page and in `privacy.html#lab`.

## Sound

`src/sound.ts` follows the cuelume pattern: `import("cuelume")` when the browser is idle, `setVolume(0.45)`, `setEnabled()` from the visitor's choice and the `sound` effect, and `bind()` for the `data-cuelume-tap`, `-select`, `-toggle`, `-navigate` and `-emphasis` attributes in the markup. Outcomes play from code with `cue()`: copying (`success`), FAQ open and close, and the governor stepping an effect down (`warning`). The speaker button in the header stores the choice in `localStorage` (`framebudget-site-sound`); when framebudget turns `sound` off, the button shows it as unavailable.

## Search, social previews and AI agents

- Each page has `<!-- fb:seo:home|api|privacy|lab -->` in its `<head>`. `vite.config.ts` replaces it with the output of `seoHead()` from `src/seo.ts`: canonical URL, `robots` meta, Open Graph and Twitter tags (absolute `og.png`, 1200x630), the `llms.txt` alternate link, the apple-touch-icon and manifest links, and JSON-LD (`WebSite`, `SoftwareSourceCode`, and a `WebPage` or `TechArticle`). The title and description come from the page's own `<title>` and `<meta name="description">`, so edit those in the HTML.
- Canonicals and the sitemap use the paths the Worker serves with `html_handling: "auto-trailing-slash"`: `/`, `/api`, `/privacy` and `/lab`. Link pages the same way, without `.html`.
- `public/robots.txt` allows everything except `/api/` (the Worker's endpoints; `/api` itself is the API reference page) and points to `public/sitemap.xml`. Add new pages to the sitemap and to `PATHS` in `src/seo.ts`.
- `public/llms.txt` follows [llmstxt.org](https://llmstxt.org): a short summary and links for AI agents. The plugin in `src/llms.ts` derives two more files at build time (and serves them in `npm run dev`), so nothing is copied by hand: `llm.txt`, the same content for agents that ask for that name, and `llms-full.txt`, the `README.md` of the installed `framebudget` package without its Development section under a short header. Upgrading the library upgrades this file.
- `public/site.webmanifest` lists `logo/icon-192.png` and `logo/icon-512.png`. Those and `logo/apple-touch-icon.png` (180x180) are `mark.svg` rendered as a full-bleed square on Ink, since iOS rounds the corners itself.

## Error pages

`404.html` and `500.html` are pages of the build like the others: same header, footer, dock, stylesheet and scripts (`nav:error` renders the header with no current link). Their head uses `<!-- fb:seo:error -->`, which renders `<meta name="robots" content="noindex">` and the shared links, without a canonical or social tags, and they stay out of `public/sitemap.xml`. Every URL in them is root-relative, since they are served at whatever path failed.

- `404.html`: the asset layer serves it with status 404 for any path with no matching file (`not_found_handling: "404-page"` in the root `wrangler.jsonc`), and so does `npm run serve`. A small inline script shows the requested path (`location.pathname`, set with `textContent`).
- `500.html`: the Worker serves it with status 500 when it fails while answering a page load (see "Routing and errors" in the root `README.md`). The retry button reloads the page.

## Assets

The fonts (Archivo and Martian Mono, SIL Open Font License 1.1), logos, favicon and `og.png` are copied from `brand/` in [github.com/framebudget/assets](https://github.com/framebudget/assets) into `public/`. `src/tokens.css` is a copy of that repository's `brand/tokens.css` with root-relative font paths. Nothing is loaded from a CDN.
