/**
 * Resolving post images to a URL Astro can optimise.
 *
 * List queries do not expand `featured_image`, so the field can carry only a
 * URL — often the internal `/_emdash/api/media/file/<key>` route, which Astro
 * cannot transform (it would emit a srcset of identical URLs). Resolve the
 * storage key and ask the storage adapter for the CDN URL instead. Width and
 * height matter too: EmDash's `<Image>` only emits a `/_image` srcset when both
 * are known, otherwise it silently degrades to a plain `<img>`.
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

function fromMediaRef(ref: MediaRef, resolve?: MediaUrlResolver): ResolvedImage | null {
  const key = ref.meta?.storageKey ?? keyFromMediaRoute(ref.url);
  const src = toPublicMediaUrl(ref.src ?? ref.url, key, resolve);
  if (!src) return null;

  return {
    // `<Image>` requires a media id; any stable identifier works for local
    // media, so fall back to the storage key or the resolved URL.
    id: ref.id ?? key ?? src,
    src,
    alt: ref.alt ?? undefined,
    width: ref.width ?? undefined,
    height: ref.height ?? undefined,
  };
}

/**
 * The image to show for a post: its featured image. Posts without one render
 * no image — the body's first inline image is not a stand-in.
 */
export function resolvePostImage(
  post: PostEntry,
  resolve?: MediaUrlResolver,
): ResolvedImage | null {
  const featured = post.data.featured_image;
  if (!featured) return null;

  return fromMediaRef(featured, resolve);
}
