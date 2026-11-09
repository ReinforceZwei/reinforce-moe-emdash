/**
 * Visitors — a site-owned visitor counter that renders inside the EmDash admin.
 *
 * Replaces WP Statistics without a second service: one inline beacon on every
 * public page posts to a public plugin route, the route dedupes a visitor per
 * page per day and writes counters into plugin storage — the same SQLite file
 * as the CMS, so the existing backup service already covers them.
 *
 * Why a native plugin rather than a sandboxed one: `page:fragments` is trusted
 * only (it injects raw script into every page), and a site-local plugin needs no
 * registry install or admin approval. No `admin.entry` is declared on purpose —
 * with Block Kit pages/widgets/panels and no React entry, nothing
 * plugin-authored runs in the browser and there is no admin bundle to keep in
 * step with EmDash's host-only peers.
 *
 * Counting happens in the browser, never in the fragment hook: public pages are
 * route-cached for 24 h (`astro.config.mjs` routeRules), so a hook-side counter
 * would only ever see cache misses.
 */
import { definePlugin } from "emdash";
import type { RouteContext } from "emdash";

import { adminInteraction, entryPanelInteraction } from "./admin/interactions";
import { buildBeacon } from "./beacon";
import {
	classifyDevice,
	classifyPath,
	classifyReferrer,
	dayKey,
	entryKey as makeEntryKey,
	isBot,
	isPlausibleSessionId,
	normalisePath,
	parseEntryKey,
	safeJson,
} from "./lib";
import { entryKeyForSlug } from "./queries";
import { ensureSalt, pruneVisits, recordVisit, retentionDays, PRUNE_TASK } from "./store";

/** Root-relative: the site's own host, whatever it is at runtime. */
const TRACK_ENDPOINT = "/_emdash/api/plugins/visitors/track";
const TRACK_PATH_PREFIX = "/_emdash/";

/**
 * Identity used when the request carries no client IP.
 *
 * `requestMeta.ip` is header-only: `cf-connecting-ip` on Workers, otherwise the
 * operator-declared trusted proxy headers (`x-forwarded-for` here). `astro dev`
 * has no proxy in front of it, so it reports `null` — dropping those hits would
 * make the plugin look broken locally while production worked. Counting under a
 * shared placeholder keeps local numbers (and any misconfigured deployment)
 * working, at the cost of a coarser visitor key: IP + UA collapse to UA only.
 */
const UNKNOWN_IP = "0.0.0.0";

/** One warning per process, not one per beacon. */
let warnedMissingIp = false;

/** Paths that must never carry a beacon. */
function shouldInject(path: string): boolean {
	// Admin, API and setup routes: `page:fragments` is only called for public
	// pages, but a fragment hook that trusts that would be one routing change
	// away from counting the admin.
	if (path.startsWith(TRACK_PATH_PREFIX)) return false;
	// The SEO debug page is an internal tool and would pollute the numbers.
	if (path === "/seo-debug") return false;
	if (path === "/robots.txt" || path.startsWith("/sitemap")) return false;
	return true;
}

function siteHost(ctx: RouteContext): string {
	const candidates = [ctx.site.url, ctx.request.url];
	for (const candidate of candidates) {
		try {
			return new URL(candidate).host;
		} catch {
			continue;
		}
	}
	return "";
}

/**
 * `/_emdash/api/plugins/visitors/track`
 *
 * Public by design — a beacon cannot authenticate. It never throws: a malformed
 * body, a storage error or a bot returns `{ ok: true }` and the page is
 * unaffected. What it accepts is narrow: the path must classify as a known
 * route, an entry path must resolve to a real entry, and one IP + UA + page can
 * only count once per day.
 */
async function track(ctx: RouteContext): Promise<Record<string, unknown>> {
	try {
		const body = safeJson(ctx.input);
		if (!body) return { ok: true, skipped: "body" };

		const path = normalisePath(body.p);
		if (!path) return { ok: true, skipped: "path" };

		const { ip: reportedIp, userAgent } = ctx.requestMeta;
		// A missing user agent is a scripted client claiming to render nothing —
		// there is no useful fallback for it. A missing IP is different: it just
		// means no trusted proxy header, which is every local `astro dev` request.
		if (!userAgent) return { ok: true, skipped: "meta" };

		const ip = reportedIp ?? UNKNOWN_IP;
		if (!reportedIp && !warnedMissingIp) {
			warnedMissingIp = true;
			ctx.log.warn("visitors: no client IP on the request; counting under 0.0.0.0", {
				hint: "client IPs come from trustedProxyHeaders (x-forwarded-for) or CF-Connecting-IP. `astro dev` has neither.",
			});
		}
		if (isBot(userAgent)) return { ok: true, skipped: "bot" };

		const route = classifyPath(path);
		if (route.kind === "unresolved") return { ok: true, skipped: "unresolved" };

		// The beacon carries the entry key baked in by the fragment hook, which is
		// exact; the slug lookup only runs for HTML cached before the plugin
		// existed, or for a page rendered without a content context.
		let resolved: string | null = null;
		if (route.kind === "entry" || route.kind === "page") {
			const baked = parseEntryKey(body.k);
			resolved = baked
				? makeEntryKey(baked.collection, baked.id)
				: route.collection && route.slug
					? await entryKeyForSlug(ctx, route.collection, route.slug)
					: null;
			// A 404, an unpublished entry or a path that only looks like an entry is
			// dropped rather than attributed to something (no 404 counting).
			if (!resolved) return { ok: true, skipped: "unresolved" };
		}

		const day = dayKey();
		const salt = await ensureSalt(ctx);
		const referrer = typeof body.r === "string" ? body.r.slice(0, 512) : "";
		const { source, sourceType } = classifyReferrer(referrer, siteHost(ctx));

		const result = await recordVisit(ctx, {
			day,
			path,
			entryKey: resolved,
			kind: route.kind,
			listingType: route.listingType,
			ip,
			userAgent,
			referrer,
			source,
			sourceType,
			device: classifyDevice(userAgent),
			sid: isPlausibleSessionId(body.sid) ? body.sid : null,
			salt,
		});

		return { ok: true, unique: result.unique, session: result.newSession };
	} catch (error) {
		ctx.log.error("visitors: track failed", {
			message: error instanceof Error ? error.message : String(error),
		});
		return { ok: true };
	}
}

export function createPlugin() {
	return definePlugin({
		id: "visitors",
		version: "1.0.0",
		// `hooks.page-fragments:register` is trusted-only and is what allows the
		// beacon; `content:read` resolves titles and slug → entry keys.
		capabilities: ["hooks.page-fragments:register", "content:read"],
		storage: {
			// One row per visitor × page × day. The document id *is* the visitor key,
			// so `compareAndSet` is the dedupe — no unique index needed.
			visits: {
				indexes: ["day", "path", "entryKey", "kind", "listingType", "source", "sourceType", "device"],
			},
			sessions: { indexes: ["day"] },
			days: { indexes: [] },
			totals: { indexes: ["scope", "views", "uniques", "sessions", "entryKey", "path", "updatedAt"] },
			// Storage queries may only filter/sort on declared indexes, which is why
			// every field read here is declared.
			dims: { indexes: ["dim", "views"] },
		},
		hooks: {
			"plugin:install": async (_event, ctx) => {
				await ensureSalt(ctx);
			},
			"plugin:activate": async (_event, ctx) => {
				// Daily prune of the raw hit log. Daily rollups are never pruned, so
				// history survives while personal data does not.
				await ctx.cron?.schedule(PRUNE_TASK, { schedule: "0 3 * * *" });
			},
			"page:fragments": (event) => {
				const { page } = event;
				if (!shouldInject(page.path)) return null;

				const content = page.content;
				const key =
					content && (content.collection === "posts" || content.collection === "pages") && content.id
						? makeEntryKey(content.collection, content.id)
						: null;

				return {
					kind: "inline-script",
					placement: "body:end",
					key: "visitors-beacon",
					code: buildBeacon({ endpoint: TRACK_ENDPOINT, entryKey: key }),
				};
			},
			cron: async (event, ctx) => {
				if (event.name !== PRUNE_TASK) return;
				const keep = await retentionDays(ctx);
				const removed = await pruneVisits(ctx, keep);
				ctx.log.info("visitors: pruned old visit rows", { removed, keepDays: keep });
			},
		},
		routes: {
			track: {
				public: true,
				methods: ["POST"],
				// `sendBeacon` sends text/plain; declaring the body mode is what makes
				// the host hand us a string instead of trying to parse JSON.
				request: { body: "text", maxBytes: 2048 },
				handler: track,
			},
			/** Block Kit interactions for the admin page and the dashboard widget. */
			admin: {
				methods: ["POST"],
				// Any editor may read the stats; `plugins:manage` (the default) would
				// restrict this to admins.
				permission: "content:read",
				handler: adminInteraction,
			},
			/** The saved-entry panel. */
			"editor/views": {
				methods: ["POST"],
				permission: "content:read",
				handler: entryPanelInteraction,
			},
		},
		admin: {
			// No `entry`: declaring pages/widgets/panels without it keeps every
			// surface on Block Kit. Adding `entry` later switches *all* of them to
			// React, which is a rewrite, not an increment.
			pages: [{ path: "/visitors", label: "Visitors", icon: "chart" }],
			widgets: [{ id: "visitors-summary", title: "Visitors", size: "half" }],
			editorPanels: [{ id: "views", title: "Views", route: "editor/views", collections: ["posts", "pages"] }],
			settingsSchema: {
				// No `countAdmins`: the fragment hook cannot see `locals.user` and the
				// admin exposes no cookie the beacon could trust, so signed-in editors
				// are counted like everyone else and the page says so.
				retentionDays: {
					type: "number",
					label: "Keep daily detail (days)",
					description: "Raw hit rows older than this are deleted nightly. Daily totals are kept forever.",
					min: 30,
					max: 730,
					default: 400,
				},
			},
		},
	});
}
