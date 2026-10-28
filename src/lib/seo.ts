/**
 * Page metadata.
 *
 * EmDash's `getSeoMeta` honours editor-set SEO fields (title, description,
 * canonical, image) that live on the entry, but the site used to call it from
 * every page and then thread six props into the layout. Now each page builds
 * one `PageMeta` object with `buildEntryMeta` and hands that to Base, which
 * turns it into the EmDash page context.
 */

import { getSeoMeta, getSiteSettings } from "emdash";

import type { PageEntry, PostEntry } from "./content/types";

const ABSOLUTE_URL_RE = /^https?:\/\//i;

/**
 * Public origin for absolute URLs (`<link rel="canonical">`, `og:url`).
 *
 * The request origin is only correct when the app is the public endpoint. Behind a proxy that
 * rewrites `Host` — nginx's default with `proxy_pass http://localhost:4321` sends
 * `Host: localhost:4321` — `Astro.url.origin` is the *internal* address, and every canonical on the
 * live site came out as `http://localhost:4321/...`, which points search engines at a host they
 * cannot reach.
 *
 * Admin → Settings → Site URL is the authoritative public origin (EmDash's own sitemaps already
 * use it), so prefer it and fall back to the request origin only when it is unset or not absolute —
 * which is what local development looks like.
 */
export async function getSiteOrigin(fallback: string): Promise<string> {
	const settings = (await getSiteSettings()) as { url?: string | null } | null;
	const configured = typeof settings?.url === "string" ? settings.url.trim() : "";
	const origin = ABSOLUTE_URL_RE.test(configured) ? configured : fallback;

	return origin.replace(/\/+$/, "");
}

/**
 * Fallback site name for `<title>` suffixes and OG tags.
 *
 * Site settings (Admin → Settings) win where available; this only covers
 * surfaces that build metadata before settings are loaded. Keep it in sync if
 * the site is renamed and settings are not set.
 */
export const SITE_NAME = "Reinforce.moe";

export interface PageMeta {
  /** Page title without the site suffix. Empty on the home page. */
  title: string;
  pageTitle?: string | null;
  description?: string | null;
  image?: string | null;
  canonical?: string | null;
  /** Tells EmDash which entry this page renders (visual editing, OG type). */
  content?: { collection: string; id: string; slug?: string | null };
}

export interface EntryMetaOptions {
  collection: string;
  slug?: string | null;
  url: URL;
  /** Overrides the entry's own title/description when the page computes them. */
  pageTitle?: string | null;
  description?: string | null;
}

/**
 * Metadata for a page backed by a single content entry.
 *
 * Async because the public origin comes from site settings (see `getSiteOrigin`).
 */
export async function buildEntryMeta(
  entry: PostEntry | PageEntry,
  { collection, slug, url, pageTitle, description }: EntryMetaOptions,
): Promise<PageMeta> {
  const seo = getSeoMeta(entry as Parameters<typeof getSeoMeta>[0], {
    siteTitle: SITE_NAME,
    siteUrl: await getSiteOrigin(url.origin),
    path: url.pathname.replace(/\/$/, ""),
  });

  return {
    title: entry.data.title,
    pageTitle: pageTitle ?? seo.ogTitle,
    description: description ?? seo.description,
    image: seo.ogImage,
    canonical: seo.canonical,
    content: { collection, id: entry.data.id, slug: slug ?? entry.slug ?? null },
  };
}

/** Metadata for a page that is not backed by content (home, archives, 404). */
export function buildPageMeta(title: string, extra: Omit<PageMeta, "title"> = {}): PageMeta {
  return { title, ...extra };
}
