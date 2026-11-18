/**
 * Comment markup shared by the server render and the client refresh.
 *
 * The built-in `emdash/ui/comments` pair renders on the server and only POSTs,
 * which is why the site used to re-fetch the whole page after a comment was
 * accepted. This module is the single template for a comment item, so the
 * server-rendered list and the list rebuilt from `GET /_emdash/api/comments/…`
 * are byte-identical: no scoped-style problems, no duplicated template.
 *
 * Keep it dependency-free (no Astro, no emdash imports) — it is bundled into
 * the browser as well.
 */

/** Same URL rule as EmDash's own comment list, applied after escaping. */
const URL_RE = /https?:\/\/[^\s<>"')]+/g;

const AMP_RE = /&/g;
const LT_RE = /</g;
const GT_RE = />/g;
const QUOT_RE = /"/g;

export function escapeHtml(text: string): string {
  return text
    .replace(AMP_RE, "&amp;")
    .replace(LT_RE, "&lt;")
    .replace(GT_RE, "&gt;")
    .replace(QUOT_RE, "&quot;");
}

/** Escape, then auto-link URLs — plain text only, never trusted HTML. */
export function linkifyBody(text: string): string {
  return escapeHtml(text).replace(
    URL_RE,
    (url) =>
      `<a href="${url}" rel="nofollow ugc noopener" target="_blank">${url}</a>`,
  );
}

/**
 * Format a comment timestamp. `timeZone` is passed explicitly because the same
 * formatter runs in Node and in the browser: without it a lazier client would
 * shift every existing date when it re-renders the list.
 */
export function formatCommentDate(
  value: string,
  locale: string,
  timeZone?: string,
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  try {
    return new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      ...(timeZone ? { timeZone } : {}),
    }).format(date);
  } catch {
    return value;
  }
}

/** A public comment as returned by `getComments()` and the list API. */
export interface CommentNode {
  id: string;
  parentId: string | null;
  authorName: string;
  isRegisteredUser: boolean;
  body: string;
  createdAt: string;
  replies?: CommentNode[];
  reactions?: Record<string, number>;
}

/** Everything the templates print — serialisable, so it can ride a data attribute. */
export interface CommentLabels {
  headingZero: string;
  /** `{count}` is replaced with the number of approved comments. */
  headingMany: string;
  member: string;
  like: string;
  reply: string;
  /** `{name}` becomes the comment author's name. */
  replyTo: string;
  cancel: string;
  name: string;
  email: string;
  comment: string;
  submit: string;
  submitting: string;
  published: string;
  pending: string;
  error: string;
  networkError: string;
  closed: string;
  /** Per-code overrides for the submit endpoint's error codes. */
  errors?: Record<string, string>;
}

export const DEFAULT_LABELS: CommentLabels = {
  headingZero: "No comments yet",
  headingMany: "{count} Comments",
  member: "Site member",
  like: "Like",
  reply: "Reply",
  replyTo: "Replying to {name}",
  cancel: "Cancel",
  name: "Name",
  email: "Email",
  comment: "Comment",
  submit: "Post Comment",
  submitting: "Submitting…",
  published: "Comment published",
  pending: "Comment submitted for review",
  error: "Failed to submit comment.",
  networkError: "Network error. Please try again.",
  closed: "Comments are closed for this post.",
};

export function headingFor(
  labels: Pick<CommentLabels, "headingZero" | "headingMany">,
  count: number,
): string {
  if (count === 0) return labels.headingZero;
  return labels.headingMany.replace("{count}", String(count));
}

export interface CommentListOptions {
  labels: Pick<CommentLabels, "member" | "like" | "reply">;
  /** Render the like button (needs `reactions` enabled on the collection read). */
  reactions?: boolean;
  locale?: string;
  timeZone?: string;
  /** Extra class on the item that was just created, for the arrival fade. */
  newCommentId?: string | null;
  /**
   * Render reply buttons. Off when the collection's closing window has passed,
   * so the UI never offers an action the endpoint would reject.
   */
  allowReply?: boolean;
}

function renderReplyButton(comment: CommentNode, labels: CommentListOptions["labels"]): string {
  return (
    `<button type="button" class="ec-reply-btn" data-ec-reply` +
    ` data-comment-id="${escapeHtml(comment.id)}"` +
    ` data-author-name="${escapeHtml(comment.authorName)}"` +
    ` aria-label="${escapeHtml(labels.reply)} — ${escapeHtml(comment.authorName)}">` +
    `${escapeHtml(labels.reply)}</button>`
  );
}

function renderLikeButton(comment: CommentNode, labels: CommentListOptions["labels"]): string {
  const count = comment.reactions?.like ?? 0;
  return (
    `<button type="button" class="ec-like" data-ec-like` +
    ` data-comment-id="${escapeHtml(comment.id)}" aria-pressed="false">` +
    `<span class="ec-like-icon" aria-hidden="true">&#x2665;</span>` +
    `<span class="ec-like-label">${escapeHtml(labels.like)}</span>` +
    `<span class="ec-like-count" data-ec-like-count>${count}</span>` +
    `</button>`
  );
}

/**
 * One comment as an `<li>`. Replies are rendered inside a nested `<ol>`; the
 * backend only ever nests one level (`parent.parentId ?? parent.id`), so the
 * recursion depth is bounded by the data.
 */
export function commentItemHtml(
  comment: CommentNode,
  options: CommentListOptions,
  depth = 0,
): string {
  const { labels, reactions = false, locale = "en-US", timeZone } = options;
  const isNew = options.newCommentId === comment.id;
  const itemClasses = ["ec-item"];
  if (depth > 0) itemClasses.push("ec-item--reply");
  if (isNew) itemClasses.push("ec-item--new");

  const replies = comment.replies ?? [];
  const repliesHtml = replies.length
    ? `<ol class="ec-list ec-list--replies">${replies
        .map((reply) => commentItemHtml(reply, options, depth + 1))
        .join("")}</ol>`
    : "";

  const actions = [
    reactions ? renderLikeButton(comment, labels) : "",
    depth === 0 && options.allowReply !== false ? renderReplyButton(comment, labels) : "",
  ]
    .filter(Boolean)
    .join("");

  return (
    `<li class="${itemClasses.join(" ")}" id="comment-${escapeHtml(comment.id)}"` +
    ` data-comment-id="${escapeHtml(comment.id)}"` +
    ` data-parent-id="${escapeHtml(comment.parentId ?? "")}">` +
    `<article class="ec-item-body">` +
    `<header class="ec-item-header">` +
    `<span class="ec-author">${escapeHtml(comment.authorName)}` +
    (comment.isRegisteredUser
      ? `<span class="ec-badge" aria-label="${escapeHtml(labels.member)}">&#x2713;</span>`
      : "") +
    `</span>` +
    `<time class="ec-time" datetime="${escapeHtml(comment.createdAt)}">${escapeHtml(
      formatCommentDate(comment.createdAt, locale, timeZone),
    )}</time>` +
    `</header>` +
    `<div class="ec-text">${linkifyBody(comment.body)}</div>` +
    (actions ? `<div class="ec-actions">${actions}</div>` : "") +
    repliesHtml +
    `</article>` +
    `</li>`
  );
}

/** The whole list, or an empty string when there is nothing approved yet. */
export function commentListHtml(
  items: CommentNode[],
  options: CommentListOptions,
): string {
  if (items.length === 0) return "";
  return `<ol class="ec-list">${items
    .map((comment) => commentItemHtml(comment, options))
    .join("")}</ol>`;
}
