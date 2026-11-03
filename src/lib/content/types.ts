/**
 * View models shared by pages and components.
 *
 * These describe only the fields the site actually reads, so a component never
 * needs `any` and never depends on which EmDash query produced its entry.
 */

/** A taxonomy term reduced to what links need. */
export interface TermLink {
  slug: string;
  label: string;
}

/**
 * A term as returned by `getEntryTerms` / `getTermsForEntries`.
 *
 * EmDash's `TaxonomyTerm` carries the term's own `name`; the taxonomy it
 * belongs to comes from the query, not the term (see lib/content/terms.ts).
 */
export interface TaxonomyTermLike {
  slug: string;
  label: string;
  name?: string;
  taxonomy?: string | { name?: string } | null;
}

/** A media reference, in either the expanded or the list-query shape. */
export interface MediaRef {
  id?: string | null;
  src?: string | null;
  url?: string | null;
  alt?: string | null;
  width?: number | null;
  height?: number | null;
  meta?: { storageKey?: string | null } | null;
}

/**
 * Editor-set SEO values from the content SEO panel.
 *
 * Mirrors EmDash's `ContentSeo`. The entry query folds the `_emdash_seo` row
 * into `data.seo`, so these are available without an extra query.
 */
export interface SeoPanel {
  title?: string | null;
  description?: string | null;
  image?: string | null;
  canonical?: string | null;
  noIndex?: boolean;
}

export interface PostData {
  id: string;
  title: string;
  excerpt?: string | null;
  /**
   * Portable Text blocks. Left as `unknown[]`: EmDash and astro-portabletext
   * ship separate copies of the Portable Text types, so the renderer cast
   * happens once, in Prose.astro, instead of failing at every call site.
   */
  content?: unknown[] | null;
  featured_image?: MediaRef | string | null;
  publishedAt?: Date | string | null;
  updatedAt?: Date | string | null;
  createdAt?: Date | string | null;
  seo?: SeoPanel | null;
}

/** A post entry as returned by the content queries. */
export interface PostEntry {
  id: string;
  slug?: string | null;
  data: PostData;
  /** Visual-editing attributes injected by EmDash; spread onto headings. */
  edit?: Record<string, Record<string, string> | undefined> | null;
  /** SEO panel values in the entry's legacy top-level position, if any. */
  seo?: SeoPanel | null;
}

export interface PageEntry {
  id: string;
  slug?: string | null;
  data: {
    id: string;
    title: string;
    content?: unknown[] | null;
    excerpt?: string | null;
    publishedAt?: Date | string | null;
    updatedAt?: Date | string | null;
    seo?: SeoPanel | null;
  };
  edit?: Record<string, Record<string, string> | undefined> | null;
  seo?: SeoPanel | null;
}
