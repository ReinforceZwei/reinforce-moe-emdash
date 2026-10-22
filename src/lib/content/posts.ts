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
  cursor?: string;
  limit: number;
  orderBy?: { published_at: "asc" | "desc" };
}

export interface PostList {
  posts: PostEntry[];
  /** Terms per entry, keyed by the entry's database id. */
  termsByEntry: Map<string, NormalizedTerms>;
  nextCursor?: string | null;
  /** Pass to `Astro.cache.set` when caching is enabled. */
  cacheHint: CacheHint;
}

export async function getPostList({
  where,
  cursor,
  limit,
  orderBy = { published_at: "desc" },
}: PostListOptions): Promise<PostList> {
  const { entries, cacheHint, nextCursor } = await getEmDashCollection("posts", {
    where,
    orderBy,
    limit,
    cursor,
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

  return { posts, termsByEntry, nextCursor, cacheHint };
}
