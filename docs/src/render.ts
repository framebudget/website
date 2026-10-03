/**
 * HTML rendered at build time by vite.config.ts: shared chrome (header,
 * footer, device dock), the tables generated from the effect registry, and
 * syntax highlighting for code blocks. Everything here is static markup, so
 * the first paint already has its final size and nothing shifts when scripts
 * fill in live values.
 */
import { defaultCalibration } from "framebudget";
import { RESERVES } from "./copy";
import { DEVICES, LADDER_MAX, SITE_EFFECTS } from "./effects";

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const LOCKUP = `<img src="/logo/lockup-dark.svg" alt="framebudget" width="158" height="22">`;

const SPEAKER = `<svg class="sound-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path class="sound-icon__body" d="M4 9.5h3.2L12 5.5v13l-4.8-4H4z"/><path class="sound-icon__wave sound-icon__wave--1" d="M15.2 9.3a3.6 3.6 0 0 1 0 5.4"/><path class="sound-icon__wave sound-icon__wave--2" d="M17.6 6.9a7 7 0 0 1 0 10.2"/><path class="sound-icon__mute" d="M15.5 9.5l5 5m0-5l-5 5"/></svg>`;

export function nav(page: "home" | "api"): string {
  const current = (p: string): string => (p === page ? ` aria-current="page"` : "");
  return `<header class="nav">
  <div class="shell nav__inner">
    <a class="nav__brand" href="/"${current("home")}>${LOCKUP}</a>
    <nav class="nav__links" aria-label="Main">
      <a class="nav__section" href="/#how">How it works</a>
      <a class="nav__section" href="/#simulator">Simulator</a>
      <a class="nav__section" href="/#code">Code</a>
      <a href="/api.html"${current("api")} data-cuelume-navigate>API</a>
    </nav>
    <button class="sound-toggle press" type="button" aria-pressed="true" aria-describedby="sound-state" data-sound-toggle data-cuelume-toggle>${SPEAKER}<span class="visually-hidden">Interface sounds</span></button>
    <span class="visually-hidden" id="sound-state" data-sound-state></span>
  </div>
</header>`;
}

export function footer(): string {
  return `<footer class="footer">
  <div class="shell footer__inner">
    <div class="footer__brand">
      ${LOCKUP}
      <p class="footer__tag">Keep the effects. Lose the stutter.</p>
      <p class="footer__install"><code>npm i framebudget</code></p>
    </div>
    <nav class="footer__links" aria-label="Footer">
      <a href="/#how">How it works</a>
      <a href="/#simulator">Simulator</a>
      <a href="/#code">Code</a>
      <a href="/#effects">Effects and tiers</a>
      <a href="/#faq">Questions</a>
      <a href="/api.html">API reference</a>
    </nav>
    <p class="footer__legal">framebudget is MIT licensed. Archivo and Martian Mono are used under the SIL Open Font License 1.1. Interface sounds by cuelume.</p>
  </div>
</footer>`;
}

/** Fixed bottom bar on every page while a device is simulated: which one, and the way back. */
export function dock(): string {
  return `<aside class="dock" aria-label="Simulated device" data-dock>
  <span class="tier" data-dock-tier>Full</span>
  <p class="dock__device"><span class="dock__name" data-dock-device>My device</span><span class="dock__score">score <span class="num num--3" data-dock-score>100</span></span></p>
  <span class="dock__actions">
    <button class="dock__action press" type="button" data-dock-back data-cuelume-navigate>Back to my device</button>
  </span>
</aside>`;
}

/** The device picker: a segmented control whose thumb slides between equal segments. */
export function picker(labelId: string): string {
  const buttons = DEVICES.map((d) => {
    const short = d.id === "real" ? "Mine" : d.id === "mid" ? "Mid" : d.id === "budget" ? "2019" : d.name;
    return `<button type="button" class="press" aria-pressed="${d.score === null}" data-score="${d.score ?? ""}" data-cuelume-select><span class="picker__name"><span class="picker__long">${d.name}</span><span class="picker__short" aria-hidden="true">${short}</span></span><span class="picker__score num num--3"${d.score === null ? " data-picker-real" : ""}>${d.score ?? "..."}</span></button>`;
  }).join("");
  return `<div class="segmented segmented--5 picker" role="group" aria-labelledby="${labelId}" data-picker><span class="segmented__thumb" aria-hidden="true"></span>${buttons}</div>`;
}

export function ladder(): string {
  const h = defaultCalibration.hysteresis;
  const rows = SITE_EFFECTS.map((fx) => {
    const t = fx.threshold / LADDER_MAX;
    return `<li class="ladder__row" data-fx="${fx.name}"><span class="ladder__name">${esc(fx.label)}</span><span class="ladder__bar" style="--c:${fx.color};--t:${t.toFixed(4)};--lo:${(t * (1 - h)).toFixed(4)};--hi:${Math.min(1, t * (1 + h)).toFixed(4)}"><span class="ladder__band"></span><span class="ladder__tick"></span></span><span class="ladder__value num num--3">${fx.threshold}</span></li>`;
  }).join("");
  return `<div class="ladder"><ol class="ladder__rows" aria-label="Effect thresholds">${rows}</ol><div class="ladder__scale" aria-hidden="true"><span class="ladder__marker" data-ladder-marker><span class="ladder__marker-label">score <span class="num num--3" data-ladder-score>100</span></span></span></div></div>`;
}

export function simRows(): string {
  return SITE_EFFECTS.map(
    (fx) =>
      `<tr data-fx="${fx.name}"><th scope="row"><span class="swatch" style="--c:${fx.color}"></span>${esc(fx.label)}</th><td class="r num">${fx.threshold}</td><td class="r num">${fx.cost}</td><td><span class="decision" data-decision>Checking</span></td></tr>`,
  ).join("");
}

const TIERS = ["Lite", "Medium", "High", "Full"] as const;

export function registry(): string {
  const floors = defaultCalibration.tiers;
  const head = `<thead><tr><th scope="col">Effect</th><th scope="col">What it does</th><th scope="col" class="r">Threshold</th><th scope="col" class="r">Cost</th>${TIERS.map((t) => `<th scope="col" class="c" data-tier-col="${t}">${t} <span class="registry__floor">${floors[t]}</span></th>`).join("")}</tr></thead>`;
  const body = SITE_EFFECTS.map((fx) => {
    const cells = TIERS.map((t) => {
      const kept = fx.threshold <= floors[t];
      return `<td class="c" data-tier-col="${t}"><span class="dot${kept ? "" : " dot--no"}" style="--c:${fx.color}" role="img" aria-label="${kept ? `In ${t}` : `Not in ${t}`}"></span></td>`;
    }).join("");
    const flags = [fx.motion && "reduced motion", fx.data && "Save-Data"].filter(Boolean).join(" and ");
    const what = esc(fx.what) + (flags ? ` <span class="registry__flags">Off under ${flags}.</span>` : "");
    return `<tr><th scope="row"><span class="swatch" style="--c:${fx.color}"></span>${esc(fx.label)} <code>${fx.name}</code></th><td>${what}</td><td class="r num">${fx.threshold}</td><td class="r num">${fx.cost}</td>${cells}</tr>`;
  }).join("");
  return `<table class="registry__table">${head}<tbody>${body}</tbody></table>`;
}

/**
 * A live text with its longest variants stacked under it, hidden. The box
 * takes the height of the tallest one at every width, so replacing the live
 * text never shifts the layout. Scripts write to `[data-live="id"]`.
 */
export function reserve(id: string, initial: string): string {
  const variants = RESERVES[id];
  if (!variants) throw new Error(`No reserve variants for ${id}`);
  const hidden = variants.map((v) => `<span class="reserve__max" aria-hidden="true">${esc(v)}</span>`).join("");
  return `<span class="reserve">${hidden}<span class="reserve__live" data-live="${id}">${esc(initial)}</span></span>`;
}

/** The library's own defaults, for the API page. */
export function defaultsTable(): string {
  const rows = Object.entries(defaultCalibration.effects)
    .map(([name, fx]) => {
      const flags = [fx.motion && "motion", fx.data && "data"].filter(Boolean).join(", ") || "none";
      return `<tr><th scope="row"><code>${name}</code></th><td class="r num">${fx.threshold}</td><td class="r num">${fx.cost}</td><td>${flags}</td></tr>`;
    })
    .join("");
  return `<table class="table"><thead><tr><th scope="col">Effect</th><th scope="col" class="r">Threshold</th><th scope="col" class="r">Cost</th><th scope="col">Flags</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/* Syntax highlighting ------------------------------------------------------ */

const KEYWORDS = new Set(
  "import from export function const let return if else new true false null await async typeof".split(" "),
);

const decode = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

function highlightTs(src: string): string {
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_$][\w$]*)\b(?=\s*\()|\b([A-Za-z_$][\w$]*)\b/g;
  let out = "";
  let last = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    out += esc(src.slice(last, m.index));
    last = re.lastIndex;
    const [text, comment, str, num, fn, word] = m;
    if (comment) out += `<span class="t-c">${esc(comment)}</span>`;
    else if (str) out += `<span class="t-s">${esc(str)}</span>`;
    else if (num) out += `<span class="t-n">${num}</span>`;
    else if (fn) out += KEYWORDS.has(fn) ? `<span class="t-k">${fn}</span>` : `<span class="t-f">${fn}</span>`;
    else if (word && KEYWORDS.has(word)) out += `<span class="t-k">${word}</span>`;
    else out += esc(text);
  }
  return out + esc(src.slice(last));
}

function highlightCss(src: string): string {
  const re = /(\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*")|([a-z-]+)(?=\s*:\s)|(\d+(?:\.\d+)?(?:px|ms|%|rem|em)?)/g;
  let out = "";
  let last = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    out += esc(src.slice(last, m.index));
    last = re.lastIndex;
    const [, comment, str, prop, num] = m;
    if (comment) out += `<span class="t-c">${esc(comment)}</span>`;
    else if (str) out += `<span class="t-s">${esc(str)}</span>`;
    else if (prop) out += `<span class="t-k">${prop}</span>`;
    else if (num) out += `<span class="t-n">${num}</span>`;
  }
  return out + esc(src.slice(last));
}

/** Highlights every `<code data-lang="ts|css">` block in a page. */
export function highlightCode(html: string): string {
  return html.replace(/<code data-lang="(ts|css)">([\s\S]*?)<\/code>/g, (_all, lang: string, body: string) => {
    const src = decode(body);
    return `<code>${lang === "css" ? highlightCss(src) : highlightTs(src)}</code>`;
  });
}
