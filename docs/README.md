# framebudget site

The landing page and API reference for framebudget. The page is also a demo of the library: every effect on it is registered with framebudget and only runs while the budget allows it. Pick a slower device in the hero or the simulator and the page really changes.

## Commands

Run these in `docs/`. The site uses the library from the repository root through a `file:..` dependency, so build the library first (`npm run build` at the repository root).

| Command | What it does |
| --- | --- |
| `npm install` | Installs Vite, TypeScript, `motion` and `cuelume`, and links `framebudget` from the repository root. |
| `npm run dev` | Starts the Vite dev server with hot reload. |
| `npm run build` | Type-checks, then writes the static site to `dist/`. |
| `npm run serve` | Serves `dist/` with gzip and long-lived caching for hashed assets, like a production host. Extensionless paths serve the matching page (`/api` serves `api.html`), like the Worker. Optional port: `npm run serve -- 8080`. |
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

The site enables framebudget's telemetry for its own visitors (`src/share.ts`, `src/setup.ts`): `endpoint: "/api/report"`, `sampleRate: 1`, `minIntervalDays: 7`, `calibrationUrl: "/api/calibration"`, served by the Worker in `worker/`. A notice at the bottom of the first visit says what is measured and links to `privacy.html`; **Don't share** stores `framebudget-site-share=off` in `localStorage` and calls `configure({ share: null })`, so nothing is sent from that moment on. The privacy page has the same control. GPC and Save-Data are honored by the library.

## Sound

`src/sound.ts` follows the cuelume pattern: `import("cuelume")` when the browser is idle, `setVolume(0.45)`, `setEnabled()` from the visitor's choice and the `sound` effect, and `bind()` for the `data-cuelume-tap`, `-select`, `-toggle`, `-navigate` and `-emphasis` attributes in the markup. Outcomes play from code with `cue()`: copying (`success`), FAQ open and close, and the governor stepping an effect down (`warning`). The speaker button in the header stores the choice in `localStorage` (`framebudget-site-sound`); when framebudget turns `sound` off, the button shows it as unavailable.

## Search, social previews and AI agents

- Each page has `<!-- fb:seo:home|api|privacy -->` in its `<head>`. `vite.config.ts` replaces it with the output of `seoHead()` from `src/seo.ts`: canonical URL, `robots` meta, Open Graph and Twitter tags (absolute `og.png`, 1200x630), the `llms.txt` alternate link, the apple-touch-icon and manifest links, and JSON-LD (`WebSite`, `SoftwareSourceCode`, and a `WebPage` or `TechArticle`). The title and description come from the page's own `<title>` and `<meta name="description">`, so edit those in the HTML.
- Canonicals and the sitemap use the paths the Worker serves with `html_handling: "auto-trailing-slash"`: `/`, `/api` and `/privacy`. Link pages the same way, without `.html`.
- `public/robots.txt` allows everything except `/api/` (the Worker's endpoints; `/api` itself is the API reference page) and points to `public/sitemap.xml`. Add new pages to the sitemap and to `PATHS` in `src/seo.ts`.
- `public/llms.txt` follows [llmstxt.org](https://llmstxt.org): a short summary and links for AI agents. The plugin in `src/llms.ts` derives two more files at build time (and serves them in `npm run dev`), so nothing is copied by hand: `llm.txt`, the same content for agents that ask for that name, and `llms-full.txt`, the root `README.md` without its Development section under a short header.
- `public/site.webmanifest` lists `logo/icon-192.png` and `logo/icon-512.png`. Those and `logo/apple-touch-icon.png` (180x180) are `mark.svg` rendered as a full-bleed square on Ink, since iOS rounds the corners itself.

## Assets

The fonts (Archivo and Martian Mono, SIL Open Font License 1.1), logos, favicon and `og.png` are copied from `../assets/brand/` into `public/`. `src/tokens.css` is a copy of `../assets/brand/tokens.css` with root-relative font paths. Nothing is loaded from a CDN.
