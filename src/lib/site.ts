/**
 * Site-level settings the layout and lists read.
 */

import { getSiteSettings } from "emdash";

const FALLBACK_POSTS_PER_PAGE = 10;

/**
 * Page size for post lists, from Admin → Settings (`postsPerPage`).
 *
 * Lists used to hardcode 10 (home) and 20 (/posts) independently, so the
 * setting existed but did nothing.
 */
export async function getPostsPerPage(): Promise<number> {
  const settings = (await getSiteSettings()) as { postsPerPage?: number } | null;
  const value = Number(settings?.postsPerPage);

  return Number.isFinite(value) && value > 0 ? value : FALLBACK_POSTS_PER_PAGE;
}
