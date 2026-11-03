/**
 * Page SEO — the single resolver.
 *
 * Every page hands raw inputs (an entry, a computed heading, the request URL)
 * to `resolveSeo()` and gets one `SeoContext` back. Both the `<title>` element
 * and the page context EmDash turns into head tags are derived from that single
 * object, so the precedence chain exists in exactly one place:
 *
 *     SEO panel (entry.seo)  →  page-computed  →  entry data  →  site settings  →  fallback
 *
 * `EmDashHead` re-applies the SEO panel on top of the context we hand it (see
 * `resolveSeoPanelPage` upstream). That overlay is idempotent, so editor-set
 * values win in both layers and the two cannot disagree.
 *
 * Nothing here hardcodes the site name, the title separator, or the tagline:
 * they come from Admin → Settings. `SITE_LOCALE` is the exception — EmDash
 * stores the locale in an options row (`emdash:locale`) it does not expose to
 * templates, so the language lives here, next to `<html lang>`.
 */

import { getSiteSettings } from "emdash";

import type { MediaRef, PageEntry, PostEntry } from "./content/types";

/** Language of the site: `<html lang>` and the `og:locale` base. */
export const SITE_LOCALE = process.env.PUBLIC_SITE_LOCALE || "zh-Hant";

/** Separator used when Admin → Settings → SEO has none configured. */
const DEFAULT_TITLE_SEPARATOR = " - ";

/**
 * Query parameters that identify a distinct page (pagination, search term).
 * Anything else (`utm_*`, `fbclid`, …) is dropped from the canonical URL so
 * campaign links do not compete with the clean page.
 */
const CANONICAL_QUERY_ALLOWLIST = new Set(["page", "q"]);

const ABSOLUTE_URL_RE = /^https?:\/\//i;
const TRAILING_SLASH_RE = /\/+$/;

/** Shapes we read from EmDash; kept narrow so pages stay free of `any`. */
interface SeoSettingsLike {
  title?: string;
  tagline?: string;
  url?: string;
  favicon?: MediaRef | null;
  seo?: {
    titleSeparator?: string;
    defaultOgImage?: MediaRef | null;
  } | null;
}

export interface SeoArticle {
  publishedTime?: string | null;
  modifiedTime?: string | null;
}

export interface SeoContext {
  /** Final `<title>` text: page title, separator, site name. */
  title: string;
  /** Title without the site suffix, used for `og:title` / `twitter:title`. */
  pageTitle: string;
  description: string | null;
  /** Absolute URL of the social image, or null when none is configured. */
  image: string | null;
  /** Absolute canonical URL. Always set, for every page. */
  canonical: string;
  pageType: "website" | "article";
  robots: string | null;
  article?: SeoArticle;
  /** Tells EmDash which entry this page renders (SEO panel overlay, JSON-LD). */
  content?: { collection: string; id: string; slug?: string | null };
  siteName: string;
  siteUrl: string;
  /** `og:locale` form, e.g. `zh_TW`. */
  locale: string;
}

export interface SeoInput {
  url: URL;
  /** Content entry this page renders, when there is one. */
  entry?: PostEntry | PageEntry | null;
  /** Collection the entry belongs to (`posts`, `pages`). */
  collection?: string;
  slug?: string | null;
  /** Title computed by the page (list headings, search term). */
  title?: string | null;
  /** Description computed by the page. */
  description?: string | null;
  /** Image computed by the page (a post's featured image). */
  image?: string | null;
  /** Defaults to `article` for entry pages and `website` for everything else. */
  pageType?: "website" | "article";
  /** Force a robots directive (search and 404 set `noindex, nofollow`). */
  robots?: string | null;
}

function isAbsolute(url: string): boolean {
  return ABSOLUTE_URL_RE.test(url);
}

/** Site origin for absolute URLs: the configured site URL, else the request. */
function resolveOrigin(configured: string | undefined, url: URL): string {
  if (configured && isAbsolute(configured)) return configured.replace(TRAILING_SLASH_RE, "");
  return url.origin;
}

/** Root-relative, protocol-relative and absolute refs all resolve to absolute. */
function toAbsolute(ref: string, origin: string): string {
  if (isAbsolute(ref) || ref.startsWith("//")) return ref;
  return `${origin}${ref.startsWith("/") ? ref : `/${ref}`}`;
}

/**
 * A bare media id in the SEO panel means "the file endpoint"; a root-relative
 * path already carries that prefix. Mirrors EmDash's own image resolution so a
 * value we pass through is not expanded twice.
 */
function resolveImageRef(ref: string, origin: string): string {
  if (isAbsolute(ref) || ref.startsWith("//")) return ref;
  if (ref.startsWith("/")) return `${origin}${ref}`;
  return `${origin}/_emdash/api/media/file/${ref}`;
}

function buildCanonical(url: URL, origin: string): string {
  const path = url.pathname.replace(TRAILING_SLASH_RE, "") || "/";
  const params = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    if (CANONICAL_QUERY_ALLOWLIST.has(key)) params.append(key, value);
  }
  const query = params.toString();
  return `${origin}${path}${query ? `?${query}` : ""}`;
}

function entrySeo(entry: PostEntry | PageEntry | null | undefined) {
  return entry?.seo ?? entry?.data?.seo ?? null;
}

function entryExcerpt(entry: PostEntry | PageEntry | null | undefined): string | null {
  const excerpt = entry?.data && "excerpt" in entry.data ? entry.data.excerpt : null;
  return typeof excerpt === "string" && excerpt.trim() ? excerpt : null;
}

function toIsoTime(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value !== "string" || !value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

/**
 * `zh-Hant` → `zh_TW` for `og:locale`.
 *
 * Open Graph expects `language_TERRITORY`; a script subtag is not valid there,
 * and omitting the territory (`zh`) tells scrapers nothing about which Chinese.
 * Script→region is the only faithful mapping available without a locale table.
 */
const OG_SCRIPT_REGIONS: Record<string, string> = { hant: "TW", hans: "CN" };

export function toOgLocale(locale: string): string {
  const [language, subtag] = locale.split("-");
  if (!language) return locale;
  if (!subtag) return language.toLowerCase();

  const region = OG_SCRIPT_REGIONS[subtag.toLowerCase()];
  return `${language.toLowerCase()}_${region ?? subtag.toUpperCase()}`;
}

/** Metadata for one rendered page. See the precedence table at the top. */
export async function resolveSeo(input: SeoInput): Promise<SeoContext> {
  const settings = (await getSiteSettings()) as SeoSettingsLike;
  const panel = entrySeo(input.entry);
  const origin = resolveOrigin(settings.url, input.url);

  const siteName = settings.title?.trim() ?? "";
  const separator = settings.seo?.titleSeparator || DEFAULT_TITLE_SEPARATOR;

  const entryTitle =
    typeof input.entry?.data?.title === "string" ? input.entry.data.title : null;
  const pageTitle = panel?.title || input.title || entryTitle || siteName;

  let title = pageTitle;
  if (pageTitle && siteName && pageTitle !== siteName) title = `${pageTitle}${separator}${siteName}`;
  else if (!pageTitle) title = siteName;

  const description =
    panel?.description ||
    input.description ||
    entryExcerpt(input.entry) ||
    settings.tagline ||
    null;

  const configuredImage = settings.seo?.defaultOgImage?.url;
  const imageRef = panel?.image || input.image || configuredImage || null;
  const image = imageRef ? resolveImageRef(imageRef, origin) : null;

  const canonical = panel?.canonical
    ? toAbsolute(panel.canonical, origin)
    : buildCanonical(input.url, origin);

  const pageType: "website" | "article" =
    input.pageType ?? (input.entry ? "article" : "website");

  const article: SeoArticle | undefined =
    pageType === "article" && input.entry
      ? {
          publishedTime: toIsoTime(input.entry.data.publishedAt),
          modifiedTime: toIsoTime(input.entry.data.updatedAt),
        }
      : undefined;

  return {
    title,
    pageTitle,
    description,
    image,
    canonical,
    pageType,
    robots: panel?.noIndex ? "noindex, nofollow" : (input.robots ?? null),
    ...(article ? { article } : {}),
    ...(input.entry && input.collection
      ? {
          content: {
            collection: input.collection,
            id: input.entry.data.id,
            slug: input.slug ?? input.entry.slug ?? null,
          },
        }
      : {}),
    siteName,
    siteUrl: origin,
    locale: toOgLocale(SITE_LOCALE),
  };
}
