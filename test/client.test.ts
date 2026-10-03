import { describe, expect, it } from "vitest";
import { deriveClient } from "../src/client";
import { CHROME_ANDROID_UA } from "./helpers";

const UA = {
  chromeAndroid: CHROME_ANDROID_UA,
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  chromeIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1",
  safariIpad:
    "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
  firefoxWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
  firefoxAndroid: "Mozilla/5.0 (Android 14; Mobile; rv:131.0) Gecko/131.0 Firefox/131.0",
  edgeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
  chromeOs:
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
};

const derive = (headers: Record<string, string>, country?: unknown) => {
  const { country: c, ...rest } = deriveClient(new Headers(headers), country);
  return { ...rest, country: c };
};

describe("deriveClient", () => {
  it.each([
    ["Chrome Android", UA.chromeAndroid, "blink", 130, "android", true],
    ["Safari iPhone", UA.safariIphone, "webkit", 17, "ios", true],
    ["Chrome iPhone runs WebKit", UA.chromeIphone, "webkit", 17, "ios", true],
    ["Safari iPad is not a phone", UA.safariIpad, "webkit", 17, "ios", false],
    ["Safari macOS", UA.safariMac, "webkit", 18, "macos", false],
    ["Firefox Windows", UA.firefoxWindows, "gecko", 131, "windows", false],
    ["Firefox Linux", UA.firefoxLinux, "gecko", 131, "linux", false],
    ["Firefox Android", UA.firefoxAndroid, "gecko", 131, "android", true],
    ["Edge Windows", UA.edgeWindows, "blink", 130, "windows", false],
    ["ChromeOS", UA.chromeOs, "blink", 130, "chromeos", false],
    ["no user agent", "", "other", null, "other", false],
  ])("%s", (_name, ua, engine, engineVersion, os, mobile) => {
    expect(derive({ "user-agent": ua })).toEqual({ engine, engineVersion, os, mobile, country: null });
  });

  it("prefers client hints over the frozen Chromium user agent", () => {
    const client = derive({
      "user-agent": UA.edgeWindows,
      "sec-ch-ua": '"Chromium";v="131", "Microsoft Edge";v="131", "Not?A_Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
    });
    expect(client).toMatchObject({ engine: "blink", engineVersion: 131, os: "windows", mobile: false });
  });

  it("reads mobile and platform from hints", () => {
    const client = derive({
      "user-agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      "sec-ch-ua": '"Chromium";v="130", "Google Chrome";v="130"',
      "sec-ch-ua-mobile": "?1",
      "sec-ch-ua-platform": '"Android"',
    });
    expect(client).toMatchObject({ os: "android", mobile: true });
  });

  it.each([
    ["BR", "BR"],
    ["T1", "T1"],
    ["XX", null],
    ["usa", null],
    [undefined, null],
    [42, null],
  ])("country %j becomes %j", (input, expected) => {
    expect(derive({}, input).country).toBe(expected);
  });
});
