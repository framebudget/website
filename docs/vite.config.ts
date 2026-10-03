import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import { createBootScript } from "framebudget/boot";
import { calibration } from "./src/effects";
import { defaultsTable, dock, footer, highlightCode, ladder, nav, picker, registry, reserve, simRows } from "./src/render";

/**
 * Cross-document view transitions are opted into in CSS. This classic script
 * runs before the first render of each page, earlier than any module, and
 * skips the transition when framebudget did not allow "pageTransition". It
 * reads the attribute the boot script wrote a moment earlier.
 */
const PAGE_TRANSITION_GATE = `(function(){function gate(e){var t=e.viewTransition;if(!t)return;var list=(document.documentElement.getAttribute("data-framebudget-effects")||"").split(" ");if(list.indexOf("pageTransition")<0)t.skipTransition();}addEventListener("pageswap",gate);addEventListener("pagereveal",gate);})();`;

const PARTIALS: Record<string, () => string> = {
  "nav:home": () => nav("home"),
  "nav:api": () => nav("api"),
  footer,
  dock,
  ladder,
  "sim-rows": simRows,
  registry,
  defaults: defaultsTable,
};

/**
 * Inlines the framebudget boot script at the top of <head>, so it decides
 * before the first paint, and renders the static partials and code blocks.
 */
function framebudgetPages(): Plugin {
  const boot = createBootScript({ calibration });
  return {
    name: "framebudget-pages",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        const page = html
          .replace("<!-- framebudget:boot -->", () => `<script>${boot}</script>\n<script>${PAGE_TRANSITION_GATE}</script>`)
          .replace(/<!-- fb:picker:([\w-]+) -->/g, (_all, label: string) => picker(label))
          .replace(/<!-- fb:reserve:([\w-]+) (.*?) -->/g, (_all, id: string, initial: string) => reserve(id, initial))
          .replace(/<!-- fb:([\w:-]+) -->/g, (all, key: string) => {
            const render = PARTIALS[key];
            if (!render) throw new Error(`Unknown partial ${all}`);
            return render();
          });
        return highlightCode(page);
      },
    },
  };
}

/**
 * Inlines the stylesheet into each page. It is small, and a separate request
 * would hold the first paint back on slow phones.
 */
function inlineCss(): Plugin {
  return {
    name: "inline-css",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const css = Object.values(bundle).filter((f) => f.type === "asset" && f.fileName.endsWith(".css"));
      for (const page of Object.values(bundle)) {
        if (page.type !== "asset" || !page.fileName.endsWith(".html")) continue;
        let html = String(page.source);
        for (const sheet of css) {
          if (sheet.type !== "asset") continue;
          const tag = new RegExp(`<link rel="stylesheet"[^>]*href="/${sheet.fileName}"[^>]*>`);
          html = html.replace(tag, () => `<style>${String(sheet.source)}</style>`);
        }
        page.source = html;
      }
      for (const sheet of css) delete bundle[sheet.fileName];
    },
  };
}

export default defineConfig({
  plugins: [framebudgetPages(), inlineCss()],
  build: {
    target: "es2020",
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        api: resolve(import.meta.dirname, "api.html"),
      },
    },
  },
});
