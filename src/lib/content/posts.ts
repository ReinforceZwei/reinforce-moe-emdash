/**
 * Post list queries.
 *
 * One place that knows how to fetch a page of posts *and* the terms for the
 * cards, so every list surface renders from the same shape. Pages keep only
 * the concern that differs: which posts to show.
 */

import { getEmDashCollection, getTermsForEntries } from "emdash";
import type { CacheHint } from "emdash";

import { splitTerms, type NormalizedTerms } from "./terms";
import type { PostEntry } from "./types";

export interface PostListOptions {
  /** EmDash filter, e.g. `{ category: [slug] }`. */
  where?: NonNullable<Parameters<typeof getEmDashCollection>[1]>["where"];
  page: number;
  limit: number;
  orderBy?: { published_at: "asc" | "desc" };
}

export interface PostList {
  posts: PostEntry[];
  /** Terms per entry, keyed by the entry's database id. */
  termsByEntry: Map<string, NormalizedTerms>;
  hasMore?: boolean;
  /** Pass to `Astro.cache.set` when caching is enabled. */
  cacheHint: CacheHint;
}

export function parsePageNumber(value: string | null, limit: number): number {
  if (!value || !/^\d+$/.test(value)) return 1;

  const page = Number(value);
  const offset = (page - 1) * limit;
  return Number.isSafeInteger(page) && page > 0 && Number.isSafeInteger(offset) ? page : 1;
}

/**
 * Returns the unique post whose slug starts with the given prefix, or `null`.
 *
 * WordPress used `redirect_guess_404_permalink()`: when a miss matched exactly
 * one post slug prefix, it redirected to that record instead of returning a
 * 404. That is how `/blog/parsec` — the real slug with its percent-encoded CJK
 * tail truncated by a crawler or shared link — kept landing on the article for
 * years. EmDash has no equivalent fallback, so this helper mirrors the same
 * rule with a single indexed query and returns nothing when the prefix is
 * ambiguous.
 */
export async function guessPostSlug(prefix: string): Promise<string | null> {
  // Find slugs that start with `prefix` using an indexed range query, rather
  // than scanning every post.
  const { entries } = await getEmDashCollection("posts", {
    status: "published",
    limit: 2,
    where: { slug: { gte: prefix, lt: `${prefix}\u{10FFFF}` } },
  });

  if (entries.length !== 1) return null;
  const [match] = entries;
  const found = match.data.slug;
  return found?.startsWith(prefix) ? found : null;
}

export async function getPostList({
  where,
  page,
  limit,
  orderBy = { published_at: "desc" },
}: PostListOptions): Promise<PostList> {
  const { entries, cacheHint, hasMore } = await getEmDashCollection("posts", {
    where,
    orderBy,
    limit,
    offset: (page - 1) * limit,
  });

  const posts = entries as unknown as PostEntry[];
  const ids = posts.map((post) => post.data.id);

  // Two queries: a term does not say which taxonomy it belongs to.
  const [categoriesByEntry, tagsByEntry] = await Promise.all([
    getTermsForEntries("posts", ids, "category"),
    getTermsForEntries("posts", ids, "tag"),
  ]);

  const termsByEntry = new Map<string, NormalizedTerms>(
    ids.map((id) => [id, splitTerms(categoriesByEntry.get(id), tagsByEntry.get(id))]),
  );

  return { posts, termsByEntry, hasMore, cacheHint };
}
