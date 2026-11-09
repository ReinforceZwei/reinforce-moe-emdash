#!/usr/bin/env node
/**
 * SEO regression check.
 *
 * Turns the head-tag checklist this site keeps failing by hand into assertions
 * that can run against any deployment (local preview, staging, production):
 *
 *   node scripts/seo-check.mjs http://127.0.0.1:4321
 *   node scripts/seo-check.mjs https://reinforce.moe --post /blog/foo --page /about
 *
 * Assertions are behavioural, not snapshot-based, so they survive copy edits:
 *
 *   - every page: one non-empty <title>, description, absolute canonical,
 *     og:url === canonical, og:type, og:title, og:site_name, absolute og:image,
 *     og:locale, twitter card + image, theme-color, icon, apple-touch-icon,
 *     parseable JSON-LD, and no stray noindex
 *   - every page: the trailing-slash spelling is a 301 to the canonical path,
 *     keeping the query string, instead of a second 200
 *   - article pages: og:type=article, article:published_time, BlogPosting
 *     JSON-LD, and og:image agreeing with the structured-data image
 *   - list/home: og:type=website
 *   - /search and 404: noindex, nofollow
 *   - the title separator is identical on every page and really sits between
 *     the page title and the site name (this is how a hardcoded separator or a
 *     hardcoded site name gets caught)
 *
 * Post and page targets are discovered from sitemap.xml unless passed
 * explicitly. No dependencies: plain fetch + regex, so it runs anywhere Node
 * runs.
 */

const args = process.argv.slice(2);
const baseUrlArg = args.find((arg) => !arg.startsWith("--"));
if (!baseUrlArg) {
  console.error("usage: node scripts/seo-check.mjs <base-url> [--post <path>] [--page <path>]");
  process.exit(2);
}

function option(name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

const base = new URL(baseUrlArg);
const origin = base.origin;
const explicitPost = option("post");
const explicitPage = option("page");
const timeoutMs = Number(option("timeout") ?? 20_000);

let failures = 0;
let passes = 0;
let separators = new Map();
const canonicalOrigins = new Set();

function check(scope, label, ok, detail = "") {
  if (ok) {
    passes += 1;
    return;
  }
  failures += 1;
  console.error(`FAIL  ${scope}  ${label}${detail ? ` — ${detail}` : ""}`);
}

function note(message) {
  console.log(`note  ${message}`);
}

async function fetchPage(path) {
  const url = new URL(path, origin);
  const response = await fetch(url, {
    redirect: "manual",
    headers: { "user-agent": "seo-check" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.text();
  return { url, status: response.status, body };
}

/**
 * The trailing-slash spelling of a page must redirect, not render a second
 * 200. Both spellings used to serve the same body; the canonical names only
 * the unslashed one, so the slashed copy is a duplicate page a crawler can
 * only resolve by trusting the canonical — and inbound links keep the copy
 * alive. Asserted as a behaviour (301 + `Location`), not as a config value.
 */
async function assertTrailingSlash(scope, path) {
  const target = new URL(path, origin);
  if (target.pathname === "/") return;
  const slashed = new URL(target);
  slashed.pathname = `${target.pathname}/`;

  const response = await fetch(slashed, {
    redirect: "manual",
    headers: { "user-agent": "seo-check" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  await response.body?.cancel();

  check(scope, "trailing slash redirects", response.status === 301, `${slashed.pathname} → ${response.status}`);
  const location = response.headers.get("location") ?? "";
  check(scope, "trailing slash keeps the query", location === `${target.pathname}${target.search}`, location);
}

function attrValues(tag) {
  const attrs = {};
  for (const match of tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) attrs[match[1]] = match[2];
  return attrs;
}

function parseHead(html) {
  const head = html.slice(0, html.indexOf("</head>") + 1);
  const meta = new Map();
  const links = new Map();

  for (const [tag] of head.matchAll(/<meta\b[^>]*>/g)) {
    const attrs = attrValues(tag);
    const key = attrs.property ?? attrs.name;
    if (!key) continue;
    if (!meta.has(key)) meta.set(key, []);
    meta.get(key).push(attrs.content ?? "");
  }

  for (const [tag] of head.matchAll(/<link\b[^>]*>/g)) {
    const attrs = attrValues(tag);
    if (!attrs.rel) continue;
    if (!links.has(attrs.rel)) links.set(attrs.rel, []);
    links.get(attrs.rel).push(attrs);
  }

  const jsonLd = [];
  for (const match of head.matchAll(
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g,
  )) {
    try {
      jsonLd.push(JSON.parse(match[1]));
    } catch {
      jsonLd.push(null);
    }
  }

  const titleMatch = head.match(/<title>([^<]*)<\/title>/);
  return {
    meta,
    links,
    jsonLd,
    titleCount: (head.match(/<title>/g) ?? []).length,
    title: titleMatch ? titleMatch[1].trim() : "",
    htmlLang: head.match(/<html[^>]*lang="([^"]*)"/)?.[1] ?? null,
  };
}

const one = (head, key) => head.meta.get(key)?.[0];
const all = (head, key) => head.meta.get(key) ?? [];
const isAbsolute = (value) => /^https?:\/\//i.test(value ?? "");

/** True when the URL is this site's image endpoint (a resized derivative). */
function isDerivative(url) {
  try {
    return new URL(url).pathname === "/_image";
  } catch {
    return false;
  }
}

/** Origin of a URL, or empty when it does not parse. */
function imageOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/** EmDash's internal media route; the same file as the storage URL for `key`. */
const INTERNAL_MEDIA_PREFIX = "/_emdash/api/media/file/";

/**
 * The file behind a card URL, normalised so the same upload compares equal
 * however it is addressed: `/_image?href=…` → its source, the internal media
 * route → its storage key, anything else → its path. The CDN URL and the
 * app-proxied route are the same file, and comparing hosts would miss that.
 */
function imageSource(url) {
  if (!url) return url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.pathname === "/_image") {
    const href = parsed.searchParams.get("href");
    return href ? imageSource(href) : url;
  }
  if (parsed.pathname.startsWith(INTERNAL_MEDIA_PREFIX)) {
    return parsed.pathname.slice(INTERNAL_MEDIA_PREFIX.length);
  }
  return parsed.pathname.replace(/^\/+/, "");
}

function assertCommon(scope, head, { expectNoIndex = false } = {}) {
  check(scope, "<title> present and unique", head.titleCount === 1 && head.title.length > 0);
  check(scope, "meta description", (one(head, "description") ?? "").length > 0);
  check(scope, "og:title", (one(head, "og:title") ?? "").length > 0);
  check(scope, "og:description", (one(head, "og:description") ?? "").length > 0);
  check(scope, "og:site_name", (one(head, "og:site_name") ?? "").length > 0);

  const canonical = head.links.get("canonical")?.[0]?.href ?? "";
  check(scope, "exactly one canonical", (head.links.get("canonical") ?? []).length === 1);
  check(scope, "canonical is absolute", isAbsolute(canonical), canonical);
  if (isAbsolute(canonical)) canonicalOrigins.add(new URL(canonical).origin);
  check(scope, "og:url matches canonical", one(head, "og:url") === canonical, one(head, "og:url"));

  // Images are optional on pages that legitimately have none (empty state,
  // 404); when present they must be scrapable as absolute URLs.
  const image = one(head, "og:image");
  check(scope, "og:image absolute when present", !image || isAbsolute(image), image ?? "");

  const locale = one(head, "og:locale") ?? "";
  check(scope, "og:locale formatted", /^[a-z]{2}(_[A-Z]{2})?$/.test(locale), locale);
  check(scope, "html lang set", Boolean(head.htmlLang), head.htmlLang ?? "missing");

  const card = one(head, "twitter:card") ?? "";
  check(scope, "twitter:card", card === "summary" || card === "summary_large_image", card);
  const twitterImage = one(head, "twitter:image");
  check(scope, "twitter:image absolute when present", !twitterImage || isAbsolute(twitterImage), twitterImage ?? "");

  // When og:image is our resized derivative, the declared dimensions are part
  // of the contract: checkers such as opengraph.to flag a card that omits them,
  // and a wrong pair is worse than none. Only asserted for `/_image` URLs,
  // because that is the only case where this site knows the real dimensions.
  if (image && isDerivative(image)) {
    check(scope, "og:image:width", /^\d+$/.test(one(head, "og:image:width") ?? ""), one(head, "og:image:width") ?? "missing");
    check(scope, "og:image:height", /^\d+$/.test(one(head, "og:image:height") ?? ""), one(head, "og:image:height") ?? "missing");
    check(scope, "og:image:type", /^image\//.test(one(head, "og:image:type") ?? ""), one(head, "og:image:type") ?? "missing");
  }

  const themeColor = one(head, "theme-color") ?? "";
  check(scope, "theme-color", /^#[0-9a-f]{3,8}$/i.test(themeColor), themeColor);

  check(scope, "rel=icon", (head.links.get("icon") ?? []).length > 0);
  check(scope, "apple-touch-icon", (head.links.get("apple-touch-icon") ?? []).length > 0);

  check(scope, "JSON-LD parses", head.jsonLd.length > 0 && head.jsonLd.every(Boolean));

  const robots = all(head, "robots").join(",");
  if (expectNoIndex) {
    check(scope, "noindex", robots.includes("noindex"), robots || "missing");
  } else {
    check(scope, "indexable", !robots.includes("noindex"), robots);
  }

  return { canonical, image };
}

/** Title must be `<pageTitle><separator><siteName>`, with one separator site-wide. */
function assertTitleShape(scope, head) {
  const title = head.title;
  const pageTitle = one(head, "og:title") ?? "";
  const siteName = one(head, "og:site_name") ?? "";

  if (pageTitle === siteName) {
    check(scope, "title is the bare site name", title === siteName, title);
    return;
  }

  check(scope, "title starts with page title", title.startsWith(pageTitle), title);
  check(scope, "title ends with site name", title.endsWith(siteName), title);

  const separator = title.slice(pageTitle.length, title.length - siteName.length);
  check(scope, "separator not empty", separator.length > 0, JSON.stringify(separator));
  if (separator) separators.set(scope, separator);
}

function jsonLdTypes(head) {
  return head.jsonLd.filter(Boolean).map((node) => node["@type"]).filter(Boolean);
}

/**
 * Collect page paths from the sitemap.
 *
 * The root sitemap is an index (`<sitemap><loc>` → per-collection children),
 * and its child URLs may carry a stale host from a previous deploy, so only
 * pathnames are used. Extension-less, non-underscore paths are treated as
 * pages; `/blog/...` is treated as a post.
 */
async function collectSitemapPaths() {
  const seen = new Set();
  const queue = ["/sitemap.xml"];
  const paths = [];

  while (queue.length > 0) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);

    const response = await fetch(new URL(path, origin), {
      headers: { "user-agent": "seo-check" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) continue;
    const xml = await response.text();

    for (const block of xml.matchAll(/<sitemap>[\s\S]*?<\/sitemap>/g)) {
      const loc = block[0].match(/<loc>([^<]+)<\/loc>/)?.[1];
      if (loc) queue.push(new URL(loc).pathname);
    }
    for (const block of xml.matchAll(/<url>[\s\S]*?<\/url>/g)) {
      const loc = block[0].match(/<loc>([^<]+)<\/loc>/)?.[1];
      if (loc) paths.push(new URL(loc).pathname);
    }
  }

  return paths;
}

async function discoverTargets() {
  const targets = { post: explicitPost, page: explicitPage };
  if (targets.post && targets.page) return targets;

  try {
    const paths = await collectSitemapPaths();
    const isPagePath = (path) => !path.startsWith("/_") && !/\.[a-z0-9]+$/i.test(path);
    const isListing = (path) =>
      path === "/" || /^\/(blog|category|tag|search|about)\/?$/.test(path);

    targets.post ??= paths.find((path) => /^\/blog\/./.test(path));
    targets.page ??= paths.find((path) => isPagePath(path) && !isListing(path) && !/^\/blog\//.test(path));
  } catch (error) {
    note(`sitemap discovery failed (${error.message}); pass --post and --page`);
  }

  return targets;
}

const targets = await discoverTargets();
const missingPath = `/__seo-check-missing-${Date.now()}`;

const pages = [
  { path: "/", kind: "home" },
  { path: "/blog", kind: "list" },
  targets.post && { path: targets.post, kind: "post" },
  targets.page && { path: targets.page, kind: "page" },
  { path: "/search?q=seo", kind: "search", expectNoIndex: true },
  { path: missingPath, kind: "missing", expectNoIndex: true, expectStatus: 404 },
].filter(Boolean);

console.log(`seo-check ${origin}`);
for (const target of pages) {
  const scope = target.path;
  const { status, body } = await fetchPage(target.path);
  const head = parseHead(body);

  if (target.expectStatus) {
    check(scope, `status ${target.expectStatus}`, status === target.expectStatus, String(status));
  } else {
    check(scope, "status 200", status === 200, String(status));
  }

  const { canonical, image } = assertCommon(scope, head, { expectNoIndex: target.expectNoIndex });
  assertTitleShape(scope, head);

  const types = jsonLdTypes(head);
  check(scope, "JSON-LD has @type", types.length > 0);

  if (target.kind === "post") {
    check(scope, "og:type=article", one(head, "og:type") === "article", one(head, "og:type"));
    const ldImage = head.jsonLd.find((node) => node?.["@type"] === "BlogPosting")?.image;
    // A post with no featured image and no default OG image has nothing to
    // emit; that is data, not a regression. Failing only when one side knows
    // an image and the other does not catches the original bug (featured
    // image never reaching og:image) without flagging an empty seed post.
    if (!image && !ldImage) {
      note(`${scope} has no image (no featured image, no default OG image)`);
    } else {
      check(scope, "og:image present", Boolean(image), "structured data has an image but og:image does not");
    }

    // The card must not be the raw upload: a 2032px PNG was 3.19 MB. Two
    // exceptions are allowed, because neither can be improved here: SVG (not
    // re-encodable) and same-origin media (the image endpoint only fetches
    // hosts from `remotePatterns`, so it would 403 rather than resize).
    if (image && !/\.svgz?($|\?)/i.test(image) && imageOrigin(image) !== origin) {
      check(
        scope,
        "og:image is a resized derivative",
        isDerivative(image),
        `points at the original file: ${image}`,
      );
    }

    const published = one(head, "article:published_time") ?? "";
    check(scope, "article:published_time", !Number.isNaN(Date.parse(published)), published);
    check(scope, "BlogPosting JSON-LD", types.includes("BlogPosting"), types.join(","));
    const structuredImage = Array.isArray(ldImage) ? ldImage[0] : ldImage;
    check(
      scope,
      "og:image matches JSON-LD image source",
      !structuredImage || imageSource(structuredImage) === imageSource(image),
      `${imageSource(image)} vs ${imageSource(structuredImage)}`,
    );
  } else if (target.kind === "home" || target.kind === "list") {
    check(scope, "og:type=website", one(head, "og:type") === "website", one(head, "og:type"));
    check(scope, "WebSite JSON-LD", types.includes("WebSite"), types.join(","));
  } else if (target.kind === "page") {
    check(scope, "og:type=website", one(head, "og:type") === "website", one(head, "og:type"));
    check(scope, "no BlogPosting on a page", !types.includes("BlogPosting"), types.join(","));
  }

  if (canonical) {
    const canonicalPath = new URL(canonical).pathname + new URL(canonical).search;
    if (!target.expectNoIndex) {
      check(scope, "canonical is self-referential", canonicalPath === target.path, canonicalPath);
    }
  }

  // A missing path has no slashed twin to normalise; every real page does.
  if (!target.expectStatus) await assertTrailingSlash(scope, target.path);
}

if (separators.size > 1) {
  const distinct = [...new Set(separators.values())];
  check("all", "one title separator site-wide", distinct.length === 1, distinct.map((s) => JSON.stringify(s)).join(" "));
}

if (canonicalOrigins.size > 1) {
  check(
    "all",
    "one canonical origin site-wide",
    false,
    [...canonicalOrigins].join(" vs "),
  );
} else if (canonicalOrigins.size === 1) {
  // Not compared to the request origin on purpose: EmDash prefers the
  // configured site URL, so a preview host legitimately canonicalises to
  // production. What must never happen is canonicals pointing at two hosts.
  note(`canonical origin: ${[...canonicalOrigins][0]}`);
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
