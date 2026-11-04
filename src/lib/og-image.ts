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

export interface OgImage {
  url: string;
  width: number;
  height: number;
  type: string;
}

/**
 * Hosts Astro's image endpoint is allowed to fetch from.
 *
 * EmDash bakes `image.remotePatterns` from the storage adapter's public URL at
 * build time, and the endpoint answers **403** for every other host — including
 * this site's own origin. Wrapping an unauthorised host would replace a heavy
 * card with a broken one, which is strictly worse, so anything outside this
 * list keeps its original URL.
 *
 * `S3_PUBLIC_URL` is the media base in every deployed environment (the compose
 * file passes `.env` through), which is exactly what EmDash bakes from.
 */
function allowedMediaHosts(): Set<string> {
  const hosts = new Set<string>();
  const configured = process.env.S3_PUBLIC_URL ?? "";

  for (const entry of configured.split(",")) {
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
