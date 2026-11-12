import { definePlugin } from "emdash";

import { entriesInput, resolveEntries } from "./entries-route.ts";

/**
 * Comments by post: a grouped moderation view over EmDash's built-in comment inbox.
 *
 * The admin page reads comments through the core admin API (it is the only source that has
 * trash and search) and asks this plugin for one batched entry lookup per load, so a large
 * inbox costs one request per 200 entries instead of one per entry. Nothing is stored: the
 * plugin has no collections, no settings, and no database access of its own.
 */
export function createPlugin() {
	return definePlugin({
		id: "comment-groups",
		version: "0.2.0",
		// Resolve entry titles and public URLs for the admin page's group headers.
		capabilities: ["content:read"],
		admin: {
			entry: "/src/plugins/comment-groups/admin.tsx",
			pages: [{ path: "/comments", label: "Comments by post", icon: "message-circle" }],
		},
		routes: {
			entries: {
				// The caller reads comment bodies and author emails through the inbox route, so the
				// batch lookup asks for the same permission rather than something broader.
				permission: "comments:moderate",
				methods: ["POST"],
				input: entriesInput,
				// The host validates `input` against this schema before dispatch; parsing here is what
				// gives the handler a typed value (`ctx.input` is `unknown` in the handler signature).
				handler: async (ctx) => resolveEntries(ctx, entriesInput.parse(ctx.input)),
			},
		},
	});
}
