export type Comment = {
  id: string;
  collection: string;
  contentId: string;
  parentId: string | null;
  authorName: string;
  authorEmail: string;
  body: string;
  status: "pending" | "approved" | "spam" | "trash";
  createdAt: string;
  updatedAt: string;
};

export type Group = {
  collection: string;
  contentId: string;
  comments: Comment[];
  title: string;
  url: string | null;
};

type Status = Comment["status"];
const statuses: Status[] = ["pending", "approved", "spam", "trash"];
const base = "/_emdash/api";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// EmDash wraps both successes and errors in { success, data/error }.
async function request(path: string, init: RequestInit = {}, allowUnavailable = false): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("X-EmDash-Request", "1");
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  // Moderators may lack content:read; hidden drafts and deleted entries return 404.
  if (allowUnavailable && (response.status === 403 || response.status === 404)) return null;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`EmDash request failed (${response.status}): invalid JSON`);
  }
  if (!response.ok || !object(body) || body.success !== true || !("data" in body)) {
    const message = object(body) && object(body.error) && typeof body.error.message === "string"
      ? body.error.message : `HTTP ${response.status}`;
    throw new Error(`EmDash request failed: ${message}`);
  }
  return body.data;
}

function isComment(value: unknown, status: Status): value is Comment {
  return object(value) &&
    ["id", "collection", "contentId", "authorName", "authorEmail", "body", "createdAt", "updatedAt"]
      .every((key) => typeof value[key] === "string") &&
    (typeof value.parentId === "string" || value.parentId === null) && value.status === status;
}

async function commentsForStatus(status: Status): Promise<Comment[]> {
  const comments: Comment[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ status, limit: "100" });
    if (cursor !== undefined) query.set("cursor", cursor);
    const data = await request(`${base}/admin/comments?${query}`);
    if (!object(data) || !Array.isArray(data.items) || !data.items.every((item) => isComment(item, status))) {
      throw new Error("Invalid comment page response");
    }
    comments.push(...data.items);
    const next = data.nextCursor;
    if (next === undefined || next === null) break;
    if (typeof next !== "string" || !next || !data.items.length || cursors.has(next)) {
      throw new Error("Invalid or repeated comment pagination cursor");
    }
    cursors.add(next);
    cursor = next;
  } while (true);
  return comments;
}

async function fillContent(group: Group): Promise<void> {
  const path = `${base}/content/${encodeURIComponent(group.collection)}/${encodeURIComponent(group.contentId)}`;
  const data = await request(path, {}, true);
  if (data === null) return;
  if (!object(data) || !object(data.item) || !object(data.item.data)) {
    throw new Error("Invalid content response");
  }
  const item = data.item;
  const fields = item.data as Record<string, unknown>;
  if (typeof fields.title === "string" && fields.title.trim()) group.title = fields.title;
  // This site actually serves posts at /blog/[slug] and pages at /[slug],
  // regardless of the seed's stale /posts/{slug} pattern. Unknown collections
  // and unpublished content have no known public route.
  if (item.status === "published" && typeof item.slug === "string" && item.slug && item.slug !== "." && item.slug !== "..") {
    const slug = encodeURIComponent(item.slug);
    if (group.collection === "posts") group.url = `/blog/${slug}`;
    else if (group.collection === "pages") group.url = `/${slug}`;
  }
}

export async function loadGroups(status: Status | "all"): Promise<Group[]> {
  if (status !== "all" && !statuses.includes(status)) throw new Error("Invalid comment status");
  const pages = await Promise.all((status === "all" ? statuses : [status]).map(commentsForStatus));
  const groups = new Map<string, Group>();
  const ids = new Set<string>();
  for (const comment of pages.flat()) {
    // A comment can move between statuses while the four inboxes are loading.
    if (ids.has(comment.id)) continue;
    ids.add(comment.id);
    const key = JSON.stringify([comment.collection, comment.contentId]);
    let group = groups.get(key);
    if (!group) {
      group = { collection: comment.collection, contentId: comment.contentId, comments: [], title: `${comment.collection} / ${comment.contentId}`, url: null };
      groups.set(key, group);
    }
    group.comments.push(comment);
  }
  const result = [...groups.values()];
  // Bound concurrent content requests when an inbox contains many posts.
  for (let i = 0; i < result.length; i += 8) {
    await Promise.all(result.slice(i, i + 8).map(fillContent));
  }
  return result;
}

export async function setCommentStatus(id: string, status: Status): Promise<void> {
  if (!statuses.includes(status)) throw new Error("Invalid comment status");
  await request(`${base}/admin/comments/${encodeURIComponent(id)}/status`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }),
  });
}

export async function deleteComment(id: string): Promise<void> {
  await request(`${base}/admin/comments/${encodeURIComponent(id)}`, { method: "DELETE" });
}
