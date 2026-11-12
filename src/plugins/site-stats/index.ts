/**
 * Site stats: first-party page-view counting, modelled on a subset of WP Statistics 14.1.6.
 *
 * - A tiny beacon is injected by `page:fragments`; it posts the page key (baked in at render
 *   time) to a public route, so cached HTML still counts.
 * - Counters are pre-aggregated per day: EmDash storage has no GROUP BY and caps queries at
 *   100 rows, so reads sum a bounded number of small rows instead of scanning raw hits.
 * - Admin UI is Block Kit only (no React, no `admin.entry`).
 */
import { definePlugin } from "emdash";
import { buildBeacon } from "./beacon.ts";
import { handleAdmin, PAGES, type AdminCtx } from "./admin/handler.ts";
import { pageKeyForRender } from "./lib/pagekey.ts";
import { SETTING_DEFAULTS } from "./lib/settings.ts";
import { handleTrack } from "./track.ts";

/** `sendBeacon` with text/plain reaches the route already parsed; a raw string is also handled. */
function toObject(input: unknown): unknown {
	if (typeof input !== "string") return input;
	try {
		return JSON.parse(input);
	} catch {
		return null;
	}
}

export function createPlugin() {
	return definePlugin({
		id: "site-stats",
		version: "0.1.0",
		capabilities: ["hooks.page-fragments:register", "content:read"],
		storage: {
			days: { indexes: ["day"] },
			pages: { indexes: ["day", "key", ["day", "key"]] },
			dims: { indexes: ["day", "kind", ["day", "kind"]] },
			totals: { indexes: ["kind"] },
			seen: { indexes: ["day"] },
		},
		hooks: {
			"page:fragments": async (event) => {
				// Every 404 is rendered by rewriting to /404, and the admin lives under /_emdash.
				if (event.page.path === "/404" || event.page.path.startsWith("/_emdash/")) return null;
				const key = pageKeyForRender({ path: event.page.path, content: event.page.content });
				if (!key) return null;
				return { kind: "inline-script", placement: "body:end", key: "site-stats-beacon", code: buildBeacon(key) };
			},
		},
		routes: {
			track: {
				public: true,
				methods: ["POST"],
				handler: async (ctx) => {
					try {
						return await handleTrack(ctx as never, {
							input: toObject(ctx.input),
							request: ctx.request,
							ip: ctx.requestMeta.ip,
							userAgent: ctx.requestMeta.userAgent,
						});
					} catch (error) {
						// Never fail a page view over a stats problem.
						ctx.log.error("site-stats track failed", { error: String(error) });
						return { ok: true, skipped: "error" };
					}
				},
			},
			admin: {
				handler: async (ctx) => handleAdmin(ctx as unknown as AdminCtx),
			},
		},
		admin: {
			pages: [
				{ path: PAGES.overview, label: "Site stats", icon: "chart" },
				{ path: PAGES.sources, label: "Sources", icon: "chart" },
				{ path: PAGES.technology, label: "Technology", icon: "chart" },
			],
			widgets: [{ id: "site-stats-summary", title: "Site stats", size: "half" }],
			settingsSchema: {
				timezone: {
					type: "string",
					label: "Day boundary timezone",
					description: "IANA name. Days roll over at midnight here. Do not change once data exists: past days would not line up.",
					default: SETTING_DEFAULTS.timezone,
				},
				siteHosts: {
					type: "string",
					label: "Own hostnames",
					description: "One per line. Referrers from these count as internal, not as referral traffic.",
					multiline: true,
					default: SETTING_DEFAULTS.siteHosts,
				},
				excludePaths: {
					type: "string",
					label: "Excluded paths",
					description: "One path prefix per line. Pages under these are not counted.",
					multiline: true,
					default: SETTING_DEFAULTS.excludePaths,
				},
				excludeLoggedIn: {
					type: "boolean",
					label: "Ignore signed-in editors",
					description: "Skip visits from browsers signed in to the admin.",
					default: SETTING_DEFAULTS.excludeLoggedIn,
				},
			},
		},
	});
}
