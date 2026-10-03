# framebudget site

The landing page and API reference for framebudget. The page is also a demo of the library: every effect on it is registered with framebudget and only runs while the budget allows it. Pick a slower device in the hero or the simulator and the page really changes.

## Commands

Run these in `site/`. The site uses the library from `../packages/framebudget` through the npm workspace, so build the library first (`npm run build` at the repository root).

| Command | What it does |
| --- | --- |
| `npm install` | Installs Vite, TypeScript, `motion` and `cuelume`, and links `framebudget` from `../packages/framebudget`. |
| `npm run dev` | Starts the Vite dev server with hot reload. |
| `npm run build` | Type-checks, then writes the static site to `dist/`. |
| `npm run serve` | Serves `dist/` with gzip and long-lived caching for hashed assets, like a production host. Optional port: `npm run serve -- 8080`. |
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
| `hover` | Hover states | 20 | 1 | |
| `counters` | Counting numbers | 25 | 1 | motion |
| `canvasLowRes` | Frame chart, 1x | 30 | 3 | motion |
| `entrances` | Staggered reveals | 35 | 2 | motion |
| `morph` | Morphing controls | 40 | 2 | motion |
| `shimmer` | Deadline glow | 45 | 2 | motion |
| `sound` | Interface sounds | 50 | 1 | data |
| `textReveal` | Text reveals | 52 | 2 | motion |
| `pageTransition` | Page transitions | 55 | 3 | motion |
| `springs` | Spring presses | 60 | 3 | motion |
| `magnetic` | Magnetic buttons | 65 | 2 | motion |
| `parallax` | Parallax | 70 | 5 | motion |
| `spotlight` | Cursor spotlight | 80 | 4 | motion |
| `blur` | Backdrop blur | 90 | 6 | |
| `canvasHiRes` | Frame chart, full res | 120 | 8 | motion, data |

## Sound

`src/sound.ts` follows the cuelume pattern: `import("cuelume")` when the browser is idle, `setVolume(0.45)`, `setEnabled()` from the visitor's choice and the `sound` effect, and `bind()` for the `data-cuelume-tap`, `-select`, `-toggle`, `-navigate` and `-emphasis` attributes in the markup. Outcomes play from code with `cue()`: copying (`success`), FAQ open and close, and the governor stepping an effect down (`warning`). The speaker button in the header stores the choice in `localStorage` (`framebudget-site-sound`); when framebudget turns `sound` off, the button shows it as unavailable.

## Assets

The fonts (Archivo and Martian Mono, SIL Open Font License 1.1), logos, favicon and `og.png` are copied from `../brand/` into `public/`. `src/tokens.css` is a copy of `../brand/tokens.css` with root-relative font paths. Nothing is loaded from a CDN.
