import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
	deleteComment,
	fetchComments,
	fetchEntries,
	fetchStatusComments,
	fetchStatusCounts,
	setCommentStatus,
} from "../src/plugins/comment-groups/data.ts";
import { entriesInput, resolveEntries, type EntryResolverContext } from "../src/plugins/comment-groups/entries-route.ts";
import {
	type Comment,
	distinctEntries,
	entryKey,
	groupComments,
} from "../src/plugins/comment-groups/shared.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

function comment(id: string, overrides: Partial<Comment> = {}): Comment {
	return {
		id,
		collection: "posts",
		contentId: "post-1",
		parentId: null,
		authorName: "Name",
		authorEmail: "a@example.com",
		body: "Hi",
		status: "pending",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function ok(data: unknown): Response {
	return Response.json({ success: true, data });
}

function failure(status: number, message = "failure"): Response {
	return Response.json({ success: false, error: { code: "ERROR", message } }, { status });
}

type Call = { path: string; init: RequestInit };

/** Records every request and answers with `respond`, which sees the parsed URL. */
function intercept(respond: (url: URL) => Response | Promise<Response>): Call[] {
	const calls: Call[] = [];
	globalThis.fetch = async (input, init) => {
		calls.push({ path: String(input), init: init ?? {} });
		return respond(new URL(String(input), "https://example.test"));
	};
	return calls;
}

// ---------------------------------------------------------------------------
// data.ts — inbox reads
// ---------------------------------------------------------------------------

test("walks every page of a status and sends CSRF plus the page size", async () => {
	const calls = intercept((url) => {
		if (!url.pathname.endsWith("/admin/comments")) throw new Error(`unexpected ${url.pathname}`);
		assert.equal(url.searchParams.get("status"), "pending");
		assert.equal(url.searchParams.get("limit"), "100");
		return url.searchParams.has("cursor")
			? ok({ items: [comment("2")] })
			: ok({ items: [comment("1")], nextCursor: "a+b/=" });
	});

	const comments = await fetchStatusComments("pending");

	assert.deepEqual(
		comments.map((item) => item.id),
		["1", "2"],
	);
	assert.equal(calls.length, 2);
	assert.equal(new URL(calls[1]!.path, "https://example.test").searchParams.get("cursor"), "a+b/=");
	for (const call of calls) {
		// `apiFetch()` is what adds this header; a raw fetch would let EmDash reject the write later.
		assert.equal(new Headers(call.init.headers).get("X-EmDash-Request"), "1");
	}
});

test("passes search through the inbox instead of filtering rows on the client", async () => {
	const calls = intercept(() => ok({ items: [] }));
	await fetchComments("pending", { search: "  spam bot  " });
	assert.equal(new URL(calls[0]!.path, "https://example.test").searchParams.get("search"), "spam bot");
});

test("all reads the four inboxes in parallel and deduplicates by comment id", async () => {
	const seen: string[] = [];
	intercept((url) => {
		const status = url.searchParams.get("status") as Comment["status"];
		seen.push(status);
		// The same row can be returned by two reads when it is moderated mid-load.
		return ok({ items: [comment(status, { status }), comment("shared", { status })] });
	});

	const comments = await fetchComments("all");

	assert.deepEqual(seen.sort(), ["approved", "pending", "spam", "trash"]);
	assert.deepEqual(comments.map((item) => item.id).sort(), ["approved", "pending", "shared", "spam", "trash"]);
});

test("a broken page, a cursor loop and a wrong shape all reject", async () => {
	const outcomes: Response[] = [
		failure(500, "database failed"),
		ok({ items: "bad" }),
		ok({ items: [comment("2")], nextCursor: "same" }),
		ok({ items: [], nextCursor: "fresh" }),
		ok({ items: [{ ...comment("1"), status: "unknown" }] }),
	];
	for (const second of outcomes) {
		intercept((url) =>
			url.searchParams.has("cursor") ? second : ok({ items: [comment("1")], nextCursor: "same" }),
		);
		await assert.rejects(fetchStatusComments("pending"), (error: unknown) => error instanceof Error);
	}
});

test("counts parse the four numbers and tolerate a partial payload", async () => {
	intercept(() => ok({ pending: 3, approved: 4, spam: 0, trash: "nope" }));
	assert.deepEqual(await fetchStatusCounts(), { pending: 3, approved: 4, spam: 0, trash: 0 });
});

// ---------------------------------------------------------------------------
// data.ts — batched entry lookup
// ---------------------------------------------------------------------------

test("entry lookups are deduplicated and batched into requests of 200", async () => {
	const calls = intercept(() => ok({ entries: [] }));
	const entries = Array.from({ length: 201 }, (_, index) => ({
		collection: "posts",
		contentId: `p${index}`,
	}));
	// Duplicates collapse before batching, so 201 unique entries stay 201.
	await fetchEntries([...entries, ...entries.slice(0, 5)]);

	assert.equal(calls.length, 2);
	const bodies = calls.map((call) => JSON.parse(String(call.init.body)) as { entries: unknown[] });
	assert.deepEqual(
		bodies.map((body) => body.entries.length),
		[200, 1],
	);
	assert.equal(calls[0]!.init.method, "POST");
	assert.equal(new URL(calls[0]!.path, "https://example.test").pathname, "/_emdash/api/plugins/comment-groups/entries");
});

test("entry results are keyed by entryKey and validated", async () => {
	const key = entryKey("posts", "post-1");
	intercept(() =>
		ok({
			entries: [
				{
					key,
					collection: "posts",
					contentId: "post-1",
					exists: true,
					title: "T",
					url: "https://example.test/blog/t",
					slug: "t",
					status: "published",
				},
			],
		}),
	);
	const resolved = await fetchEntries([{ collection: "posts", contentId: "post-1" }]);
	assert.equal(resolved.get(key)?.title, "T");

	intercept(() => ok({ entries: [{ key, title: "broken" }] }));
	await assert.rejects(fetchEntries([{ collection: "posts", contentId: "post-1" }]), /unexpected shape/);
});

// ---------------------------------------------------------------------------
// data.ts — moderation
// ---------------------------------------------------------------------------

test("status changes escape the id and return the server's row", async () => {
	const calls = intercept(() =>
		ok(comment("id/#?", { status: "approved", updatedAt: "2026-02-02T00:00:00.000Z" })),
	);
	const updated = await setCommentStatus("id/#?", "approved");

	assert.equal(updated.status, "approved");
	assert.equal(updated.updatedAt, "2026-02-02T00:00:00.000Z");
	assert.equal(new URL(calls[0]!.path, "https://example.test").pathname, "/_emdash/api/admin/comments/id%2F%23%3F/status");
	assert.equal(calls[0]!.init.method, "PUT");
	assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { status: "approved" });
	assert.equal(new Headers(calls[0]!.init.headers).get("X-EmDash-Request"), "1");
});

test("delete uses DELETE and surfaces the server's error message", async () => {
	const calls = intercept(() => ok({ deleted: true }));
	await deleteComment("c1");
	assert.equal(calls[0]!.init.method, "DELETE");

	intercept(() => failure(409, "comment is locked"));
	await assert.rejects(deleteComment("c1"), /comment is locked/);
});

// ---------------------------------------------------------------------------
// entries-route.ts — the server half
// ---------------------------------------------------------------------------

function resolverContext(
	overrides: Partial<NonNullable<EntryResolverContext["content"]>> = {},
	warnings: unknown[] = [],
): EntryResolverContext {
	return {
		content: {
			get: async (collection: string, id: string) => ({ slug: `${id}-slug`, status: "published", data: { title: `${collection} title` } }),
			getPublicUrl: async (collection: string, id: string) => `https://example.test/${collection}/${id}-slug`,
			...overrides,
		},
		log: { warn: (message: string, data?: unknown) => warnings.push({ message, data }) },
	};
}

test("resolves titles and the collection's own public URL", async () => {
	const { entries } = await resolveEntries(resolverContext(), {
		entries: [{ collection: "posts", id: "p1" }],
	});

	assert.deepEqual(entries, [
		{
			key: entryKey("posts", "p1"),
			collection: "posts",
			contentId: "p1",
			exists: true,
			title: "posts title",
			url: "https://example.test/posts/p1-slug",
			slug: "p1-slug",
			status: "published",
		},
	]);
});

test("deduplicates repeated entries and keeps first-seen order", async () => {
	let lookups = 0;
	const { entries } = await resolveEntries(
		resolverContext({
			get: async (collection, id) => {
				lookups += 1;
				return { slug: id, status: "published", data: { title: `${collection}/${id}` } };
			},
		}),
		{ entries: [{ collection: "posts", id: "b" }, { collection: "posts", id: "b" }, { collection: "pages", id: "a" }] },
	);

	assert.equal(lookups, 2);
	assert.deepEqual(
		entries.map((entry) => entry.contentId),
		["b", "a"],
	);
});

test("a missing entry, a failing URL lookup and a rejected read all degrade instead of failing the batch", async () => {
	const warnings: unknown[] = [];
	const { entries } = await resolveEntries(
		resolverContext(
			{
				get: async (collection, id) => {
					if (id === "gone") return null;
					if (id === "explodes") throw new Error("row is corrupt");
					return { slug: "ok-slug", status: "draft", data: { title: "" } };
				},
				getPublicUrl: async (_collection, id) => {
					if (id === "nourl") throw new Error("no route");
					return "https://example.test/x";
				},
			},
			warnings,
		),
		{ entries: [{ collection: "posts", id: "gone" }, { collection: "posts", id: "explodes" }, { collection: "posts", id: "nourl" }] },
	);

	assert.deepEqual(
		entries.map((entry) => [entry.contentId, entry.exists, entry.url, entry.title]),
		[
			["gone", false, null, "posts / gone"],
			["explodes", false, null, "posts / explodes"],
			// An untitled draft keeps the fallback label but still resolves (no public URL, no link).
			["nourl", true, null, "posts / nourl"],
		],
	);
	assert.equal(warnings.length, 1);
});

test("no ctx.content degrades to fallbacks rather than throwing", async () => {
	const { entries } = await resolveEntries(
		{ log: { warn: () => {} } },
		{ entries: [{ collection: "posts", id: "p1" }] },
	);
	assert.equal(entries[0]!.exists, false);
	assert.equal(entries[0]!.url, null);
});

test("the input schema caps a batch and rejects empty identifiers", () => {
	assert.equal(entriesInput.safeParse({ entries: Array.from({ length: 200 }, () => ({ collection: "posts", id: "x" })) }).success, true);
	assert.equal(entriesInput.safeParse({ entries: Array.from({ length: 201 }, () => ({ collection: "posts", id: "x" })) }).success, false);
	assert.equal(entriesInput.safeParse({ entries: [{ collection: "", id: "x" }] }).success, false);
});

// ---------------------------------------------------------------------------
// shared.ts — grouping
// ---------------------------------------------------------------------------

test("groupComments orders groups by newest comment and keeps each thread in order", () => {
	const groups = groupComments([
		comment("a1", { contentId: "a", createdAt: "2026-01-01T00:00:00.000Z" }),
		comment("b1", { contentId: "b", createdAt: "2026-02-01T00:00:00.000Z" }),
		comment("a2", { contentId: "a", createdAt: "2026-03-01T00:00:00.000Z" }),
	]);

	assert.deepEqual(
		groups.map((group) => group.contentId),
		["a", "b"],
	);
	assert.deepEqual(
		groups[0]!.comments.map((item) => item.id),
		["a1", "a2"],
	);
	assert.equal(groups[0]!.entry, null);
});

test("entry keys stay distinct when a collection or id contains a separator", () => {
	assert.notEqual(entryKey("a/b", "c"), entryKey("a", "b/c"));
	assert.deepEqual(
		distinctEntries([comment("1", { collection: "a/b", contentId: "c" }), comment("2", { collection: "a", contentId: "b/c" })]),
		[
			{ collection: "a/b", contentId: "c" },
			{ collection: "a", contentId: "b/c" },
		],
	);
});
