/**
 * `POST /_emdash/api/plugins/comment-groups/entries`
 *
 * The admin inbox is paginated by comment, so one load of the grouped page can reference a few
 * hundred distinct entries. Asking the admin content API for each of them is one round trip per
 * entry (`GET /_emdash/api/content/{collection}/{id}`), which dominates load time on a large
 * inbox. This route answers the same question for up to `ENTRY_BATCH_LIMIT` entries in one
 * request, straight from the plugin runtime: title, publish state, slug, and — via
 * `ctx.content.getPublicUrl()` — the URL the *collection's own* `urlPattern` produces, so the
 * plugin stops hard-coding this site's `/blog/{slug}` and `/{slug}` routes.
 *
 * Why not move the comment reads here too: `ctx.comments.list()` has no search and no trash
 * (the plugin comment access excludes trashed rows), while the admin inbox route has both. The
 * grouping work stays on the client; only the per-entry fan-out is collapsed.
 */
import { z } from "zod";

import { entryKey, fallbackTitle, type EntryInfo } from "./shared.ts";

/** Keep one request bounded: 200 entries is ~2 inbox pages of distinct entries. */
export const ENTRY_BATCH_LIMIT = 200;

/** Entries resolved in parallel. Each lookup is two indexed reads, so this stays cheap. */
const CONCURRENCY = 8;

export const entriesInput = z.object({
	entries: z
		.array(
			z.object({
				collection: z.string().min(1).max(128),
				id: z.string().min(1).max(256),
			}),
		)
		.max(ENTRY_BATCH_LIMIT),
});

export type EntriesInput = z.infer<typeof entriesInput>;

/**
 * The slice of `RouteContext` this handler uses. Typing it structurally keeps the handler
 * testable with `node --test` without importing `emdash` (which needs a host to load).
 */
export interface EntryResolverContext {
	content?: {
		get(collection: string, id: string): Promise<{ slug: string | null; status: string; data: Record<string, unknown> } | null>;
		getPublicUrl?(collection: string, id: string): Promise<string | null>;
	};
	log: { warn(message: string, data?: unknown): void };
}

export interface EntriesResponse {
	entries: EntryInfo[];
}

export async function resolveEntries(ctx: EntryResolverContext, input: EntriesInput): Promise<EntriesResponse> {
	const targets: Array<{ key: string; collection: string; id: string }> = [];
	const seen = new Set<string>();
	for (const entry of input.entries) {
		const key = entryKey(entry.collection, entry.id);
		if (seen.has(key)) continue;
		seen.add(key);
		targets.push({ key, collection: entry.collection, id: entry.id });
	}

	const resolved: EntryInfo[] = new Array(targets.length);
	let cursor = 0;
	const worker = async () => {
		while (cursor < targets.length) {
			const index = cursor++;
			resolved[index] = await resolveOne(ctx, targets[index]!);
		}
	};
	await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
	return { entries: resolved };
}

async function resolveOne(
	ctx: EntryResolverContext,
	target: { key: string; collection: string; id: string },
): Promise<EntryInfo> {
	const missing: EntryInfo = {
		key: target.key,
		collection: target.collection,
		contentId: target.id,
		exists: false,
		title: fallbackTitle(target.collection, target.id),
		url: null,
		slug: null,
		status: null,
	};
	// The host only injects `ctx.content` with the `content:read` capability declared, and the
	// route must still answer if that ever changes: a missing context degrades to fallbacks.
	if (!ctx.content) return missing;

	try {
		// The URL lookup reads the same row again and can reject on a collection without a
		// public route; a title with no link is still worth returning.
		const [item, url] = await Promise.all([
			ctx.content.get(target.collection, target.id),
			ctx.content.getPublicUrl
				? ctx.content.getPublicUrl(target.collection, target.id).catch(() => null)
				: Promise.resolve(null),
		]);
		if (!item) return missing;
		const title = typeof item.data?.title === "string" && item.data.title.trim() ? item.data.title : missing.title;
		return {
			key: target.key,
			collection: target.collection,
			contentId: target.id,
			exists: true,
			title,
			url: typeof url === "string" && url ? url : null,
			slug: typeof item.slug === "string" ? item.slug : null,
			status: typeof item.status === "string" ? item.status : null,
		};
	} catch (error) {
		// One bad entry must not fail the batch: the group keeps its fallback label.
		ctx.log.warn(`comment-groups: could not resolve ${target.collection}/${target.id}`, {
			error: error instanceof Error ? error.message : String(error),
		});
		return missing;
	}
}
