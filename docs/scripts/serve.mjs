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

/** The dist/ file a URL path maps to, or null when there is none. */
async function resolveFile(url) {
  let path = normalize(decodeURIComponent(new URL(url, "http://x").pathname));
  if (path.endsWith("/")) path += "index.html";
  // Like the Worker's html_handling "auto-trailing-slash": /api serves api.html.
  else if (!extname(path)) path += ".html";
  const file = join(root, path);
  if (!file.startsWith(root)) return null;
  return (await stat(file).catch(() => null))?.isFile() ? file : null;
}

async function send(req, res, file, status) {
  const ext = extname(file);
  let body = await readFile(file);
  const headers = {
    "content-type": TYPES[ext] || "application/octet-stream",
    // Hashed assets never change; pages and public files revalidate.
    "cache-control": file.startsWith(join(root, "assets/")) ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate",
  };
  if (COMPRESS.has(ext) && /\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
    body = gzipSync(body);
    headers["content-encoding"] = "gzip";
    headers.vary = "accept-encoding";
  }
  res.writeHead(status, headers).end(body);
}

createServer(async (req, res) => {
  try {
    const file = await resolveFile(req.url).catch(() => null);
    if (file) return await send(req, res, file, 200);
    // Like the Worker's not_found_handling "404-page": unmatched paths get 404.html with a 404.
    await send(req, res, join(root, "404.html"), 404);
  } catch {
    res.writeHead(500, { "content-type": "text/plain" }).end("Server error");
  }
}).listen(port, "127.0.0.1", () => console.log(`framebudget site on http://127.0.0.1:${port}/`));
