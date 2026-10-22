/**
 * Date formatting for content.
 *
 * One implementation for every surface that prints a post date. The site is
 * authored in Hong Kong time, so the display timezone is fixed rather than
 * inherited from the server's clock.
 */

const POST_DATE_FORMAT: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
  weekday: "short",
  timeZone: "Asia/Hong_Kong",
};

/** Format a publish date for display, or `""` when the value is missing/invalid. */
export function formatPostDate(value: Date | string | null | undefined): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("zh-TW", POST_DATE_FORMAT);
}

/** The date to show for a post: its publish date, falling back to creation. */
export function postDate(post: {
  data: { publishedAt?: Date | string | null; createdAt?: Date | string | null };
}): Date | string | null | undefined {
  return post.data.publishedAt ?? post.data.createdAt;
}
