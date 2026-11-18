/**
 * Types and pure helpers shared by the plugin's server route and its React admin page.
 *
 * Nothing here imports `emdash` or React, so both bundles can use it — and the unit tests can
 * import it without a host.
 */

export const COMMENT_STATUSES = ["pending", "approved", "spam", "trash"] as const;

export type CommentStatus = (typeof COMMENT_STATUSES)[number];

/** `all` is a UI-only filter: it means "every status", not a stored status. */
export type StatusFilter = CommentStatus | "all";

export interface Comment {
	id: string;
	collection: string;
	contentId: string;
	parentId: string | null;
	authorName: string;
	authorEmail: string;
	body: string;
	status: CommentStatus;
	createdAt: string;
	updatedAt: string;
}

/**
 * What the plugin route knows about the entry a comment belongs to.
 *
 * `exists: false` covers deleted, trashed, and unreadable entries; the UI keeps the group and
 * falls back to the collection/ID so its comments stay moderateable.
 */
export interface EntryInfo {
	key: string;
	collection: string;
	contentId: string;
	exists: boolean;
	title: string;
	/** Absolute public URL, or null when the entry has no public route (draft, no pattern, …). */
	url: string | null;
	slug: string | null;
	status: string | null;
}

export interface CommentGroup {
	key: string;
	collection: string;
	contentId: string;
	/** Newest first. */
	comments: Comment[];
	entry: EntryInfo | null;
}

/**
 * Stable identity for one (collection, contentId) pair.
 *
 * JSON.stringify on a tuple keeps collections and IDs that contain `/`, `:`, or `?` from
 * colliding with each other — `${collection}/${id}` would merge them.
 */
export function entryKey(collection: string, contentId: string): string {
	return JSON.stringify([collection, contentId]);
}

/** `collection / contentId` —— the label used while the entry lookup is missing or failed. */
export function fallbackTitle(collection: string, contentId: string): string {
	return `${collection} / ${contentId}`;
}

/** Group comments by entry, newest comment last, and keep groups in first-seen order. */
export function groupComments(comments: readonly Comment[], entries: ReadonlyMap<string, EntryInfo> = new Map()): CommentGroup[] {
	const groups = new Map<string, CommentGroup>();
	for (const comment of comments) {
		const key = entryKey(comment.collection, comment.contentId);
		let group = groups.get(key);
		if (!group) {
			const entry = entries.get(key) ?? null;
			group = {
				key,
				collection: comment.collection,
				contentId: comment.contentId,
				comments: [],
				entry: entry ?? null,
			};
			groups.set(key, group);
		}
		group.comments.push(comment);
	}
	for (const group of groups.values()) {
		// Oldest first inside a group so a thread reads in order; the group list itself is
		// ordered by the most recent comment below.
		group.comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}
	return [...groups.values()].sort((a, b) => latestComment(b).localeCompare(latestComment(a)));
}

function latestComment(group: CommentGroup): string {
	return group.comments.at(-1)?.createdAt ?? "";
}

export interface CommentThread {
	comment: Comment;
	/** Direct replies, oldest first. Recursive, because imported data can be deeper than EmDash allows. */
	replies: CommentThread[];
}

/**
 * Build one thread tree per entry-level comment list.
 *
 * `comments` is chronological input (that is what `groupComments` produces). A reply is attached
 * to its parent when the parent is in the same list; a reply whose parent is not — filtered out by
 * the status tab or the search box, deleted, or moderated out of this view — becomes a top-level
 * node and keeps its `parentId`, which is how the page tells "reply whose parent is not shown" from
 * a root comment. Nothing is dropped: self-parents and cycles (possible in imported data) are
 * promoted to roots instead of becoming unreachable.
 */
export function threadComments(comments: readonly Comment[]): CommentThread[] {
	const ordered = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	const nodes = new Map<string, CommentThread>();
	for (const comment of ordered) nodes.set(comment.id, { comment, replies: [] });

	// Resolve links first, then cut the ones that would close a loop.
	const parentOf = new Map<string, string>();
	for (const comment of ordered) {
		const parent = comment.parentId ? nodes.get(comment.parentId) : undefined;
		if (parent && parent.comment.id !== comment.id) parentOf.set(comment.id, parent.comment.id);
	}
	for (const id of [...parentOf.keys()]) {
		const seen = new Set<string>([id]);
		let current = parentOf.get(id);
		while (current) {
			if (seen.has(current)) {
				parentOf.delete(id);
				break;
			}
			seen.add(current);
			current = parentOf.get(current);
		}
	}

	const roots: CommentThread[] = [];
	for (const comment of ordered) {
		const node = nodes.get(comment.id)!;
		const parentId = parentOf.get(comment.id);
		if (parentId) nodes.get(parentId)!.replies.push(node);
		else roots.push(node);
	}
	return roots;
}

/** Comments in a thread tree, parents before children — for counts and tests. */
export function flattenThreads(threads: readonly CommentThread[]): Comment[] {
	const out: Comment[] = [];
	const walk = (nodes: readonly CommentThread[]) => {
		for (const node of nodes) {
			out.push(node.comment);
			walk(node.replies);
		}
	};
	walk(threads);
	return out;
}

/** Distinct (collection, contentId) pairs, in first-seen order — the input for a batch lookup. */
export function distinctEntries(comments: readonly Comment[]): Array<{ collection: string; contentId: string }> {
	const seen = new Set<string>();
	const out: Array<{ collection: string; contentId: string }> = [];
	for (const comment of comments) {
		const key = entryKey(comment.collection, comment.contentId);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ collection: comment.collection, contentId: comment.contentId });
	}
	return out;
}
