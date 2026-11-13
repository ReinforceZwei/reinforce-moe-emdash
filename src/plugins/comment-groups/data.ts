/**
 * The admin page's API layer — every request the grouped view makes.
 *
 * Three sources, deliberately:
 *
 * 1. `GET /_emdash/api/admin/comments` — the core moderation inbox. It is the only endpoint with
 *    `search` and `status=trash`, so it stays the source for comment rows. Cursor pagination,
 *    100 rows per page (the schema maximum), one request per page.
 * 2. `GET /_emdash/api/admin/comments/counts` — four numbers for the filter tabs. Cheaper than
 *    loading four inboxes just to label a tab.
 * 3. `POST /_emdash/api/plugins/comment-groups/entries` — one request per 200 distinct entries
 *    for titles and public URLs, instead of one content request per entry.
 *
 * Requests go through `apiFetch()` from `emdash/plugin-utils`, which adds the
 * `X-EmDash-Request` header the state-changing core routes require, and responses are unwrapped
 * with `parseApiResponse()`, which turns `{ success: false, error: { message } }` into an `Error`.
 *
 * Everything here is plain async code with no React, so the tests drive it with a fake `fetch`.
 */
import { apiFetch, isRecord, parseApiResponse } from "emdash/plugin-utils";

import {
	COMMENT_STATUSES,
	type Comment,
	type CommentStatus,
	entryKey,
	type EntryInfo,
	type StatusFilter,
} from "./shared.ts";

const API = "/_emdash/api";

/** Server-side maximum for the comment inbox (`commentListQuery.limit`). */
export const COMMENT_PAGE_SIZE = 100;

/** Matches `ENTRY_BATCH_LIMIT` in `entries-route.ts`. */
const ENTRY_BATCH_SIZE = 200;

export interface CommentQueryOptions {
	search?: string;
	signal?: AbortSignal;
}

function isComment(value: unknown): value is Comment {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.collection === "string" &&
		typeof value.contentId === "string" &&
		(value.parentId === null || typeof value.parentId === "string") &&
		typeof value.authorName === "string" &&
		typeof value.authorEmail === "string" &&
		typeof value.body === "string" &&
		typeof value.createdAt === "string" &&
		typeof value.updatedAt === "string" &&
		(COMMENT_STATUSES as readonly string[]).includes(String(value.status))
	);
}

/** The statuses a filter actually reads. `all` is four inboxes, not a server-side value. */
export function statusesForFilter(filter: StatusFilter): CommentStatus[] {
	return filter === "all" ? [...COMMENT_STATUSES] : [filter];
}

/**
 * Walk one status inbox to the end.
 *
 * The cursor loop is inherently sequential (each page names the next), so one status costs
 * `ceil(comments / 100)` requests and cannot be parallelised within itself — but the four
 * statuses behind `all` do run in parallel. A cursor that repeats or points at an empty page
 * would otherwise spin forever, so both are treated as a failure.
 */
export async function fetchStatusComments(
	status: CommentStatus,
	options: CommentQueryOptions = {},
): Promise<Comment[]> {
	const comments: Comment[] = [];
	const seenCursors = new Set<string>();
	let cursor: string | undefined;

	while (true) {
		options.signal?.throwIfAborted();
		const query = new URLSearchParams({ status, limit: String(COMMENT_PAGE_SIZE) });
		if (cursor) query.set("cursor", cursor);
		// The inbox matches `search` against author name, email and body.
		if (options.search?.trim()) query.set("search", options.search.trim());

		const page = await parseApiResponse<unknown>(
			await apiFetch(`${API}/admin/comments?${query}`, { signal: options.signal }),
			`Could not load ${status} comments`,
		);
		if (!isRecord(page) || !Array.isArray(page.items) || !page.items.every(isComment)) {
			throw new Error(`The ${status} comment page was not in the expected shape`);
		}
		comments.push(...page.items);

		const next = page.nextCursor;
		if (next === undefined || next === null) break;
		if (typeof next !== "string" || !next || page.items.length === 0 || seenCursors.has(next)) {
			throw new Error(`The ${status} comment list returned an unusable page cursor`);
		}
		seenCursors.add(next);
		cursor = next;
	}

	return comments;
}

/**
 * Comments for the active filter, deduplicated.
 *
 * Dedupe matters for `all`: the four inboxes are four separate reads, so a comment moderated
 * between them can appear twice.
 */
export async function fetchComments(filter: StatusFilter, options: CommentQueryOptions = {}): Promise<Comment[]> {
	const pages = await Promise.all(
		statusesForFilter(filter).map((status) => fetchStatusComments(status, options)),
	);
	const seen = new Set<string>();
	const comments: Comment[] = [];
	for (const comment of pages.flat()) {
		if (seen.has(comment.id)) continue;
		seen.add(comment.id);
		comments.push(comment);
	}
	return comments;
}

export type StatusCounts = Record<CommentStatus, number>;

/** Four numbers for the filter tabs — one request, no comment rows. */
export async function fetchStatusCounts(signal?: AbortSignal): Promise<StatusCounts> {
	const data = await parseApiResponse<unknown>(
		await apiFetch(`${API}/admin/comments/counts`, { signal }),
		"Could not load comment counts",
	);
	const counts: StatusCounts = { pending: 0, approved: 0, spam: 0, trash: 0 };
	if (!isRecord(data)) return counts;
	for (const status of COMMENT_STATUSES) {
		const value = data[status];
		if (typeof value === "number" && Number.isFinite(value)) counts[status] = value;
	}
	return counts;
}

function isEntryInfo(value: unknown): value is EntryInfo {
	if (!isRecord(value)) return false;
	return (
		typeof value.key === "string" &&
		typeof value.collection === "string" &&
		typeof value.contentId === "string" &&
		typeof value.exists === "boolean" &&
		typeof value.title === "string" &&
		(value.url === null || typeof value.url === "string") &&
		(value.slug === null || typeof value.slug === "string") &&
		(value.status === null || typeof value.status === "string")
	);
}

/**
 * Titles and public URLs for the entries behind a set of comments.
 *
 * Batched into requests of `ENTRY_BATCH_SIZE` and keyed by `entryKey`, so the returned map feeds
 * `groupComments()` directly. Entries the server could not resolve come back as `exists: false`
 * with a fallback label rather than throwing — a deleted entry must not blank the page its
 * comments still hang off.
 */
export async function fetchEntries(
	entries: ReadonlyArray<{ collection: string; contentId: string }>,
	signal?: AbortSignal,
): Promise<Map<string, EntryInfo>> {
	const unique = new Map<string, { collection: string; id: string }>();
	for (const entry of entries) {
		const key = entryKey(entry.collection, entry.contentId);
		if (!unique.has(key)) unique.set(key, { collection: entry.collection, id: entry.contentId });
	}
	const targets = [...unique.values()];
	const batches: Array<typeof targets> = [];
	for (let index = 0; index < targets.length; index += ENTRY_BATCH_SIZE) {
		batches.push(targets.slice(index, index + ENTRY_BATCH_SIZE));
	}

	const pages = await Promise.all(
		batches.map(async (batch) => {
			const data = await parseApiResponse<unknown>(
				await apiFetch(`${API}/plugins/comment-groups/entries`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ entries: batch }),
					signal,
				}),
				"Could not load entry details",
			);
			if (!isRecord(data) || !Array.isArray(data.entries) || !data.entries.every(isEntryInfo)) {
				throw new Error("The entry lookup returned an unexpected shape");
			}
			return data.entries;
		}),
	);

	const result = new Map<string, EntryInfo>();
	for (const entry of pages.flat()) result.set(entry.key, entry);
	return result;
}

/**
 * Change one comment's status through the moderation endpoint.
 *
 * Unlike the bulk endpoint, this route runs EmDash's moderation service and hooks — which is why
 * moderation from this page uses it. It answers with the updated comment, so the page can apply
 * the server's version instead of guessing.
 */
export async function setCommentStatus(id: string, status: CommentStatus): Promise<Comment> {
	const updated = await parseApiResponse<unknown>(
		await apiFetch(`${API}/admin/comments/${encodeURIComponent(id)}/status`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status }),
		}),
		`Could not move the comment to ${status}`,
	);
	if (!isComment(updated)) throw new Error("The moderation endpoint returned an unexpected shape");
	return updated;
}

/** Hard delete. Requires `comments:delete`; replies are deleted with the parent. */
export async function deleteComment(id: string): Promise<void> {
	await parseApiResponse<unknown>(
		await apiFetch(`${API}/admin/comments/${encodeURIComponent(id)}`, { method: "DELETE" }),
		"Could not delete the comment",
	);
}
