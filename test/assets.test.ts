import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestHarness, experimental_readRawConfig, type TestHarness } from "wrangler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The real wrangler.jsonc (routing, html_handling, not_found_handling) run by wrangler's local
// runtime, with stand-in pages instead of the docs/dist build.
const root = fileURLToPath(new URL("..", import.meta.url));
const pages: Record<string, string> = { "index.html": "Home", "api.html": "API reference", "404.html": "Page not found", "500.html": "Something went wrong" };
let assets: string;
let server: TestHarness;

beforeAll(async () => {
  assets = mkdtempSync(join(tmpdir(), "framebudget-assets-"));
  for (const [file, title] of Object.entries(pages)) writeFileSync(join(assets, file), `<!doctype html><title>${title}</title>`);
  const { rawConfig } = experimental_readRawConfig({ config: join(root, "wrangler.jsonc") });
  const config = { ...rawConfig, main: join(root, rawConfig.main!), assets: { ...rawConfig.assets, directory: assets } };
  server = createTestHarness({ root, workers: [{ config }] });
  await server.listen();
}, 30000);

afterAll(async () => {
  await server?.close();
  rmSync(assets, { recursive: true, force: true });
});

const page = { accept: "text/html,application/xhtml+xml,*/*;q=0.8" };

describe("static routing", () => {
  it.each(["/does-not-exist", "/docs/deep/page", "/assets/missing.js", "/api.json"])("answers unknown path %s with the 404 page", async (path) => {
    const response = await server.fetch(path, { headers: page });
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("<title>Page not found</title>");
  });

  it("serves pages under their extensionless paths, /api included", async () => {
    for (const [path, title] of [["/", "Home"], ["/api", "API reference"]] as const) {
      const response = await server.fetch(path, { headers: page });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(`<title>${title}</title>`);
    }
  });

  it("answers unknown /api/ paths with the Worker's bare 404, even for page loads", async () => {
    const response = await server.fetch("/api/nope", { headers: page });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });
});
