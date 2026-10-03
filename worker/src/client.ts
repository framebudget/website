/**
 * Coarse client facts derived from request headers. Only these derived values
 * are kept; the raw User-Agent, client hints and IP are never stored or logged.
 */

export type Engine = "blink" | "gecko" | "webkit" | "other";
export type Os = "android" | "ios" | "windows" | "macos" | "linux" | "chromeos" | "other";

export interface Client {
  engine: Engine;
  /** Major version: Chromium for blink, Firefox for gecko, Safari (or iOS) for webkit. */
  engineVersion: number | null;
  os: Os;
  /** Phone-class device (tablets count as not mobile). */
  mobile: boolean;
  /** Two-letter country code from Cloudflare, null when unknown. */
  country: string | null;
}

/** Major versions outside this range are treated as unknown. */
const MAX_VERSION = 9999;

function major(text: string | undefined): number | null {
  if (text === undefined) return null;
  const n = parseInt(text, 10);
  return n > 0 && n <= MAX_VERSION ? n : null;
}

const PLATFORMS: Record<string, Os> = {
  android: "android",
  ios: "ios",
  windows: "windows",
  macos: "macos",
  linux: "linux",
  "chrome os": "chromeos",
  "chromium os": "chromeos",
};

function osFromUa(ua: string): Os {
  if (/\b(iPhone|iPad|iPod)\b/.test(ua)) return "ios";
  if (/\bAndroid\b/.test(ua)) return "android";
  if (/\bCrOS\b/.test(ua)) return "chromeos";
  if (/\bWindows\b/.test(ua)) return "windows";
  if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) return "macos";
  if (/\bLinux\b|\bX11\b/.test(ua)) return "linux";
  return "other";
}

function engineFromUa(ua: string, os: Os): { engine: Engine; engineVersion: number | null } {
  // Every iOS browser runs WebKit. Safari's Version/ token tracks WebKit releases;
  // other iOS browsers only carry the OS version, which moves with WebKit.
  if (os === "ios") {
    const v = /\bVersion\/(\d+)/.exec(ua)?.[1] ?? /\bOS (\d+)_/.exec(ua)?.[1];
    return { engine: "webkit", engineVersion: major(v) };
  }
  const firefox = /\bFirefox\/(\d+)/.exec(ua);
  if (firefox && /\bGecko\//.test(ua)) return { engine: "gecko", engineVersion: major(firefox[1]) };
  const chrome = /\b(?:Chrome|Chromium|HeadlessChrome)\/(\d+)/.exec(ua);
  if (chrome) return { engine: "blink", engineVersion: major(chrome[1]) };
  if (/\bAppleWebKit\//.test(ua) && /\bSafari\//.test(ua)) {
    return { engine: "webkit", engineVersion: major(/\bVersion\/(\d+)/.exec(ua)?.[1]) };
  }
  return { engine: "other", engineVersion: null };
}

/** Derives the coarse client facts. `country` is `request.cf.country`. */
export function deriveClient(headers: Headers, country: unknown): Client {
  const ua = headers.get("user-agent") ?? "";
  const platform = headers.get("sec-ch-ua-platform")?.replace(/"/g, "").trim().toLowerCase();
  const os = (platform !== undefined && PLATFORMS[platform]) || osFromUa(ua);
  let { engine, engineVersion } = engineFromUa(ua, os);
  // Client hints are only sent by Chromium browsers and are not frozen like the UA string.
  const hinted = major(/"Chromium";\s*v="(\d+)/.exec(headers.get("sec-ch-ua") ?? "")?.[1]);
  if (hinted !== null && os !== "ios") {
    engine = "blink";
    engineVersion = hinted;
  }
  const mobileHint = headers.get("sec-ch-ua-mobile");
  const mobile = mobileHint === "?1" || (mobileHint !== "?0" && (/\b(iPhone|iPod)\b/.test(ua) || (/\bMobi/.test(ua) && !/\biPad\b/.test(ua))));
  return {
    engine,
    engineVersion,
    os,
    mobile,
    country: typeof country === "string" && /^[A-Z][A-Z0-9]$/.test(country) && country !== "XX" ? country : null,
  };
}
