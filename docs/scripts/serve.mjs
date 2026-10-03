// Serves dist/ with gzip, like a production host, for local checks and Lighthouse.
// Usage: node scripts/serve.mjs [port]
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { gzipSync } from "node:zlib";

const root = new URL("../dist/", import.meta.url).pathname;
const port = Number(process.argv[2] || 4173);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};
const COMPRESS = new Set([".html", ".js", ".css", ".svg", ".txt", ".xml", ".webmanifest"]);

createServer(async (req, res) => {
  try {
    let path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (path.endsWith("/")) path += "index.html";
    // Like the Worker's html_handling "auto-trailing-slash": /api serves api.html.
    else if (!extname(path)) path += ".html";
    const file = join(root, path);
    if (!file.startsWith(root) || !(await stat(file)).isFile()) throw new Error("not found");
    const ext = extname(file);
    let body = await readFile(file);
    const headers = {
      "content-type": TYPES[ext] || "application/octet-stream",
      // Hashed assets never change; pages and public files revalidate.
      "cache-control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate",
    };
    if (COMPRESS.has(ext) && /\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
      body = gzipSync(body);
      headers["content-encoding"] = "gzip";
      headers.vary = "accept-encoding";
    }
    res.writeHead(200, headers).end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`framebudget site on http://127.0.0.1:${port}/`));
