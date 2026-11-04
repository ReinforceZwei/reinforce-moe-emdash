/**
 * Social-card image URLs.
 *
 * EmDash hands us the media file's *public* URL — the original upload, which
 * can be a multi-megabyte PNG (a 2032×1143 upload on this site was 3.19 MB).
 * Social scrapers fetch that whole file, so cards are slow and some checkers
 * give up. Everything here routes a source image through Astro's `/_image`
 * endpoint instead, which resizes and re-encodes it to a 1200×630 JPEG — the
 * Open Graph / Twitter `large` card size, ~140 KB for that same upload.
 *
 * One rule, used from both sides of the SEO path:
 *   - `resolveSeo()` builds the card URL for the page context, so og:image,
 *     twitter:image and the JSON-LD image all agree;
 *   - the `page:metadata` plugin re-applies it after EmDash overlays the SEO
 *     panel, which would otherwise replace it with the raw upload again.
 *
 * Keeping it in this module means the dimensions reported in
 * `og:image:width`/`og:image:height` are always the dimensions of the URL we
 * actually emitted — never a guess about someone else's file.
 */

/** Open Graph / Twitter "large card" size. */
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;

/**
 * Formats the endpoint cannot turn into a JPEG card: SVG (vector, usually a
 * logo rather than a photo). Everything else — including media API paths with
 * no file extension — is decoded by content, so it is worth a try.
 */
const NOT_RASTER = /\.svgz?$/i;

const ENDPOINT_PATH = "/_image";

/** EmDash's own media route: proxies the original bytes through this app. */
const INTERNAL_MEDIA_PREFIX = "/_emdash/api/media/file/";

export interface OgImage {
  url: string;
  width: number;
  height: number;
  type: string;
}

/**
 * The configured media base — the same value EmDash bakes into
 * `image.remotePatterns` and serves through `getPublicUrl()`.
 *
 * `S3_PUBLIC_URL` is the media base in every deployed environment (the compose
 * file passes `.env` through). Without it an internal media key cannot be
 * turned into a fetchable URL, so optimisation is skipped.
 */
function storageBase(): string | null {
  const configured = process.env.S3_PUBLIC_URL?.trim();
  if (!configured) return null;
  try {
    return new URL(configured).href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * A storage key ends in a file extension (`<ulid>.png`). A bare media id has
 * none, and the media host has no object under that name — rewriting it would
 * turn a heavy card into a 404, so those stay on the internal route.
 */
const STORAGE_KEY = /\.[a-z0-9]{2,6}$/i;

/**
 * Map EmDash's internal file route to the storage URL for the same key.
 *
 * The SEO panel stores a media reference, which EmDash expands to
 * `/_emdash/api/media/file/<key>` and prefixes with the site URL. That route
 * streams the original upload through the Node process without resizing, so it
 * is the worst case for a card: heavy and proxied. The key is all that is
 * needed — storage base plus key is the public URL, which is also the host the
 * image endpoint is authorised to fetch.
 */
function fromInternalRoute(source: URL, base: string | null): URL | null {
  if (!base) return null;
  if (!source.pathname.startsWith(INTERNAL_MEDIA_PREFIX)) return null;

  const key = source.pathname.slice(INTERNAL_MEDIA_PREFIX.length);
  if (!key || !STORAGE_KEY.test(key)) return null;

  try {
    return new URL(`${base}/${key}`);
  } catch {
    return null;
  }
}

/**
 * Hosts Astro's image endpoint is allowed to fetch from.
 *
 * EmDash bakes `image.remotePatterns` from the storage adapter's public URL at
 * build time, and the endpoint answers **403** for every other host — including
 * this site's own origin. Wrapping an unauthorised host would replace a heavy
 * card with a broken one, which is strictly worse, so anything outside this
 * list keeps its original URL.
 */
function allowedMediaHosts(): Set<string> {
  const hosts = new Set<string>();
  const base = storageBase();
  if (!base) return hosts;

  for (const entry of base.split(",")) {
    const value = entry.trim();
    if (!value) continue;
    try {
      hosts.add(new URL(value).host);
    } catch {
      hosts.add(value);
    }
  }

  return hosts;
}

function toAbsolute(src: string, siteOrigin: string): string {
  if (/^https?:\/\//i.test(src) || src.startsWith("//")) return src;
  return `${siteOrigin}${src.startsWith("/") ? src : `/${src}`}`;
}

/**
 * A card image for `src`, or null when the source cannot (or must not) be
 * re-encoded: SVG, a host the image endpoint rejects, or a source already
 * served from this site. Callers fall back to the original URL rather than
 * emitting a broken `og:image`.
 */
export function buildOgImage(src: string | null | undefined, siteUrl: string): OgImage | null {
  if (!src) return null;

  const siteOrigin = /^https?:\/\//i.test(siteUrl)
    ? new URL(siteUrl).origin
    : siteUrl.replace(/\/+$/, "");
  const absolute = toAbsolute(src, siteOrigin);

  let source: URL;
  try {
    source = new URL(absolute);
  } catch {
    return null;
  }

  // Already one of our derivatives (the resolver ran first): report it as-is
  // instead of wrapping the endpoint URL in itself.
  if (source.pathname === ENDPOINT_PATH) {
    return {
      url: source.href,
      width: Number(source.searchParams.get("w")) || OG_IMAGE_WIDTH,
      height: Number(source.searchParams.get("h")) || OG_IMAGE_HEIGHT,
      type: "image/jpeg",
    };
  }

  if (NOT_RASTER.test(source.pathname)) return null;

  // The SEO panel stores a media id, which arrives here as EmDash's internal
  // file route. Swap it for the storage URL of the same key before the host
  // checks below: the route is same-origin and would be refused, yet it is the
  // one source that most needs resizing.
  const stored = fromInternalRoute(source, storageBase());
  if (stored) source = stored;

  // Same-origin sources are not in `remotePatterns` (that list is for remote
  // hosts), so the endpoint would refuse them. Leave those alone.
  if (source.origin === siteOrigin) return null;

  if (!allowedMediaHosts().has(source.host)) return null;

  // The endpoint lives on this site, not on the media host — the media host is
  // only ever the `href` argument.
  const endpoint = new URL(ENDPOINT_PATH, siteOrigin);
  endpoint.searchParams.set("href", source.href);
  endpoint.searchParams.set("w", String(OG_IMAGE_WIDTH));
  endpoint.searchParams.set("h", String(OG_IMAGE_HEIGHT));
  endpoint.searchParams.set("f", "jpg");
  endpoint.searchParams.set("fit", "cover");
  endpoint.searchParams.set("position", "center");
  endpoint.searchParams.set("q", "82");

  return {
    url: endpoint.href,
    width: OG_IMAGE_WIDTH,
    height: OG_IMAGE_HEIGHT,
    type: "image/jpeg",
  };
}
