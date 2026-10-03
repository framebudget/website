/**
 * Search, social and AI-agent tags for each page's <head>, rendered at build
 * time by vite.config.ts from <!-- fb:seo:page -->. The title and the
 * description come from the page's own <title> and <meta name="description">,
 * so each page keeps a single source for both.
 */

const ORIGIN = "https://framebudget.dev";
const REPOSITORY = "https://github.com/alysnnix/framebudget";
const OG_IMAGE_ALT =
  "framebudget: keep the effects, lose the stutter. A 16.7 ms frame budget bar split between your app, a transition, parallax and a canvas.";

export type SeoPage = "home" | "api" | "privacy";

/**
 * The paths the Worker serves (html_handling: auto-trailing-slash): / for
 * index.html, /api for api.html, /privacy for privacy.html. Canonicals, the
 * sitemap and the site's own links all use them.
 */
const PATHS: Record<SeoPage, string> = { home: "/", api: "/api", privacy: "/privacy" };

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Reverses the entities a hand-written <title> or attribute may contain. */
const unescape = (s: string): string =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function pick(html: string, pattern: RegExp, what: string): string {
  const found = pattern.exec(html)?.[1];
  if (!found) throw new Error(`fb:seo needs ${what} in the page`);
  return unescape(found.trim());
}

const SOFTWARE = {
  "@type": "SoftwareSourceCode",
  "@id": `${ORIGIN}/#software`,
  name: "framebudget",
  description: "Decides, per device, which visual effects a site can afford. Keep the effects. Lose the stutter.",
  url: `${ORIGIN}/`,
  codeRepository: REPOSITORY,
  license: "https://opensource.org/licenses/MIT",
  programmingLanguage: "TypeScript",
  runtimePlatform: "Web browsers",
  image: `${ORIGIN}/og.png`,
};

const WEBSITE = {
  "@type": "WebSite",
  "@id": `${ORIGIN}/#website`,
  url: `${ORIGIN}/`,
  name: "framebudget",
  inLanguage: "en",
};

function pageNode(page: SeoPage, url: string, title: string, description: string): Record<string, unknown> {
  const common = { "@id": `${url}#page`, url, name: title, description, inLanguage: "en", isPartOf: { "@id": WEBSITE["@id"] } };
  if (page === "api") {
    return { "@type": "TechArticle", ...common, headline: title, about: { "@id": SOFTWARE["@id"] }, image: `${ORIGIN}/og.png` };
  }
  return { "@type": "WebPage", ...common, about: { "@id": SOFTWARE["@id"] } };
}

/** JSON-LD, with "<" escaped so the payload can never close its script element. */
function jsonLd(page: SeoPage, url: string, title: string, description: string): string {
  const graph = { "@context": "https://schema.org", "@graph": [WEBSITE, SOFTWARE, pageNode(page, url, title, description)] };
  return `<script type="application/ld+json">${JSON.stringify(graph).replace(/</g, "\\u003c")}</script>`;
}

export function seoHead(page: SeoPage, html: string): string {
  const title = pick(html, /<title>([^<]+)<\/title>/, "a <title>");
  const description = pick(html, /<meta name="description" content="([^"]+)">/, `a <meta name="description">`);
  const url = `${ORIGIN}${PATHS[page]}`;
  const [t, d, alt] = [esc(title), esc(description), esc(OG_IMAGE_ALT)];
  return `<link rel="canonical" href="${url}">
<meta name="robots" content="index, follow, max-image-preview:large">
<meta property="og:type" content="website">
<meta property="og:site_name" content="framebudget">
<meta property="og:locale" content="en_US">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:image" content="${ORIGIN}/og.png">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${alt}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
<meta name="twitter:image" content="${ORIGIN}/og.png">
<meta name="twitter:image:alt" content="${alt}">
<link rel="alternate" type="text/markdown" href="/llms.txt" title="framebudget for AI agents (llms.txt)">
<link rel="apple-touch-icon" href="/logo/apple-touch-icon.png">
<link rel="manifest" href="/site.webmanifest">
${jsonLd(page, url, title, description)}`;
}
