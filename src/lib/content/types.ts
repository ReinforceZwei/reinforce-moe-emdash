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
  featured_image?: MediaRef | null;
  publishedAt?: Date | string | null;
  createdAt?: Date | string | null;
}

/** A post entry as returned by the content queries. */
export interface PostEntry {
  id: string;
  slug?: string | null;
  data: PostData;
  /** Visual-editing attributes injected by EmDash; spread onto headings. */
  edit?: Record<string, Record<string, string> | undefined> | null;
}

export interface PageEntry {
  id: string;
  slug?: string | null;
  data: {
    id: string;
    title: string;
    content?: unknown[] | null;
  };
  edit?: Record<string, Record<string, string> | undefined> | null;
}
