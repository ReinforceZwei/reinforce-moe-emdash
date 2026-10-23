/**
 * Resolving a post's featured image to a URL Astro can optimise.
 *
 * Only the featured image is used. The body's first inline image is *not* a
 * stand-in: a post without `featured_image` renders no card image at all.
 *
 * List queries do not expand media, so `featured_image` can arrive in several
 * shapes, and a resolver that only understands one of them silently returns
 * nothing (which is how a previous "featured only" attempt blanked every card):
 *
 *   - expanded:        { id, src, width, height, alt }
 *   - reference only:  { id, meta: { storageKey } }  — no src/url at all
 *   - internal route:  { url: "/_emdash/api/media/file/<key>" }
 *   - legacy string:   "https://…" or the internal route as a bare string
 *
 * All of them resolve through the storage adapter to the CDN URL, because
 * Astro cannot transform the internal route (it would emit a srcset of
 * identical URLs). Width and height are preserved: EmDash's `<Image>` only
 * emits a `/_image` srcset when both are known, otherwise it degrades to a
 * plain `<img>`.
 */

import type { MediaRef, PostEntry } from "./types";

const MEDIA_ROUTE = "/_emdash/api/media/file/";

/** `Astro.locals.emdash.getPublicMediaUrl`, passed in to keep this framework-free. */
export type MediaUrlResolver = (storageKey: string) => string | undefined | null;

/** Shape expected by EmDash's `<Image>` (a `MediaValue`). */
export interface ResolvedImage {
  id: string;
  src: string;
  alt?: string;
  width?: number;
  height?: number;
}

function keyFromMediaRoute(url: string | null | undefined): string | null {
  if (!url || !url.startsWith(MEDIA_ROUTE)) return null;
  return decodeURIComponent(url.slice(MEDIA_ROUTE.length));
}

export function toPublicMediaUrl(
  url: string | null | undefined,
  storageKey: string | null | undefined,
  resolve?: MediaUrlResolver,
): string | null {
  if (!url) return null;

  const key = storageKey ?? keyFromMediaRoute(url);
  if (!key || !resolve) return url;

  return resolve(key) ?? url;
}

function fromFeatured(
  value: string | MediaRef | null | undefined,
  resolve?: MediaUrlResolver,
): ResolvedImage | null {
  if (!value) return null;

  // Legacy/imported shape: the field holds the URL itself.
  if (typeof value === "string") {
    const key = keyFromMediaRoute(value);
    return {
      id: key ?? value,
      src: toPublicMediaUrl(value, key, resolve) ?? value,
    };
  }

  const key = value.meta?.storageKey ?? keyFromMediaRoute(value.url);
  const url = value.src ?? value.url ?? null;

  // No URL but a storage key: ask the adapter for the public URL directly.
  const src = url ? toPublicMediaUrl(url, key, resolve) : key ? (resolve?.(key) ?? null) : null;
  if (!src) return null;

  return {
    // `<Image>` requires a media id; any stable identifier works for local
    // media, so fall back to the storage key or the resolved URL.
    id: value.id ?? key ?? src,
    src,
    alt: value.alt ?? undefined,
    width: value.width ?? undefined,
    height: value.height ?? undefined,
  };
}

/** The image to show for a post: its featured image, or nothing. */
export function resolvePostImage(
  post: PostEntry,
  resolve?: MediaUrlResolver,
): ResolvedImage | null {
  return fromFeatured(post.data.featured_image, resolve);
}
