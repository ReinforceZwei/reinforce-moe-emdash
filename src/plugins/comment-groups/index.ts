import { definePlugin } from "emdash";

// The React page calls the existing authenticated admin APIs; this plugin needs
// no server-side capabilities, routes, or access to the database.
export function createPlugin() {
	return definePlugin({
		id: "comment-groups",
		version: "0.1.0",
		admin: {
			entry: "/src/plugins/comment-groups/admin.tsx",
			pages: [{ path: "/comments", label: "Comments by post", icon: "message-circle" }],
		},
	});
}
