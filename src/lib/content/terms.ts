/**
 * Term shaping.
 *
 * EmDash returns `TaxonomyTerm` objects carrying the term's own `name`, `slug`
 * and `label` — nothing that says which taxonomy it belongs to. Taxonomy
 * identity therefore comes from the query (`getEntryTerms(..., "category")`),
 * not from the term, so this module takes the groups as given and never tries
 * to guess.
 *
 * The previous code compared `(term.taxonomy ?? term.name)` against
 * "category"/"tag", which could never match: the post page silently rendered
 * neither its category nor its tags. Splitting at the query is the fix.
 */

import type { TermLink, TaxonomyTermLike } from "./types";

export interface NormalizedTerms {
  category: TermLink | null;
  tags: TermLink[];
}

export const EMPTY_TERMS: NormalizedTerms = { category: null, tags: [] };

/** Reduce terms to the fields links need. */
export function toTermLinks(terms?: readonly TaxonomyTermLike[] | null): TermLink[] {
  return (terms ?? []).map((term) => ({ slug: term.slug, label: term.label }));
}

/** At most one category (the first), plus the entry's tags. */
export function splitTerms(
  categoryTerms?: readonly TaxonomyTermLike[] | null,
  tagTerms?: readonly TaxonomyTermLike[] | null,
): NormalizedTerms {
  const [category] = toTermLinks(categoryTerms);

  return {
    category: category ?? null,
    tags: toTermLinks(tagTerms),
  };
}
