/**
 * Cloudflare Turnstile, loaded and run only when the visitor presses the
 * lab's button, never on page load and never on other pages. Explicit
 * rendering: one widget, reset for every new token, since a token is good for
 * one run only.
 */
const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const SITEKEY = "0x4AAAAAAFNAudgNvxLdXbLQ";
/** Cloudflare's test sitekey that always passes, for wrangler dev and the tests. */
const TEST_SITEKEY = "1x00000000000000000000AA";

interface RenderOptions {
  sitekey: string;
  theme: "dark";
  retry: "never";
  callback: (token: string) => void;
  "error-callback": () => boolean;
  "timeout-callback": () => void;
}

interface Turnstile {
  render(container: HTMLElement, options: RenderOptions): string | null | undefined;
  reset(widget: string): void;
}

declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

let loading: Promise<Turnstile> | null = null;
let widget: string | null = null;
let pending: { resolve: (token: string) => void; reject: (error: Error) => void } | null = null;

function load(): Promise<Turnstile> {
  // An executor, not Promise.withResolvers: the site still runs on browsers from before ES2024.
  loading ??= new Promise<Turnstile>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT;
    script.async = true;
    script.addEventListener("load", () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile did not start"))));
    script.addEventListener("error", () => {
      // Allow another attempt with a fresh script element.
      script.remove();
      loading = null;
      reject(new Error("Turnstile did not load"));
    });
    document.head.append(script);
  });
  return loading;
}

function settle(token: string | null): void {
  const waiting = pending;
  pending = null;
  if (!waiting) return;
  if (token) waiting.resolve(token);
  else waiting.reject(new Error("Turnstile failed"));
}

/** Runs the challenge in `container` and resolves with a fresh, single-use token. */
export async function challenge(container: HTMLElement): Promise<string> {
  const turnstile = await load();
  settle(null);
  const local = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  const token = new Promise<string>((resolve, reject) => {
    pending = { resolve, reject };
  });
  container.hidden = false;
  if (widget === null) {
    widget =
      turnstile.render(container, {
        sitekey: local ? TEST_SITEKEY : SITEKEY,
        theme: "dark",
        retry: "never",
        callback: (value) => settle(value),
        "error-callback": () => {
          settle(null);
          return true;
        },
        "timeout-callback": () => settle(null),
      }) ?? null;
    if (widget === null) settle(null);
  } else turnstile.reset(widget);
  return token;
}
