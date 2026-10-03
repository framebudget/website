/**
 * Text files for AI agents that are derived from committed sources, so they
 * cannot drift: llms-full.txt is the root README.md without its Development
 * section, and llm.txt is a copy of public/llms.txt for agents that ask for
 * that name. Emitted at build time and served by the dev server.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

const README = resolve(import.meta.dirname, "../../README.md");
const LLMS = resolve(import.meta.dirname, "../public/llms.txt");

const FULL_HEADER = `# framebudget

> framebudget is a TypeScript library for the browser that decides, per device, which visual effects a site can afford. Keep the effects. Lose the stutter.

This is the full documentation in one Markdown file. Website and API reference: https://framebudget.dev/api. Source code (MIT license): https://github.com/framebudget/framebudget.
`;

/** The README from its first prose paragraph up to, not including, "## Development". */
function llmsFull(): string {
  const readme = readFileSync(README, "utf8");
  const intro = "\nKeep the effects. Lose the stutter.\n";
  const start = readme.indexOf(intro);
  const end = readme.indexOf("\n## Development\n");
  if (start < 0 || end < 0) throw new Error("llms-full.txt: README.md no longer has the expected tagline or Development section");
  return `${FULL_HEADER}${readme.slice(start + intro.length, end).trimEnd()}\n`;
}

const FILES: Record<string, () => string> = {
  "llms-full.txt": llmsFull,
  "llm.txt": () => readFileSync(LLMS, "utf8"),
};

export function llmsFiles(): Plugin {
  return {
    name: "framebudget-llms",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const render = FILES[(req.url ?? "").split("?")[0]!.slice(1)];
        if (!render) return next();
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end(render());
      });
    },
    generateBundle() {
      for (const [fileName, render] of Object.entries(FILES)) this.emitFile({ type: "asset", fileName, source: render() });
    },
  };
}
