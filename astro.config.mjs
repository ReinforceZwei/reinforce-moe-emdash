import { mkdirSync } from "node:fs";
import path from "node:path";
import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig, memoryCache as routeMemoryCache, sessionDrivers } from "astro/config";
import emdash, { s3, local, memoryCache as objectMemoryCache } from "emdash/astro";
import { emdashSmtp } from "emdash-smtp";
import { sqlite } from "emdash/db";
import { loadEnv } from "vite";

// Load dotenv files before `emdash()` reads configuration; exported variables take precedence.
// `.env*` is ignored by Docker, so secrets are not baked into images.
const mode = process.env.NODE_ENV ?? "production";
for (const [key, value] of Object.entries(loadEnv(mode, process.cwd(), ""))) {
	if (process.env[key] === undefined) process.env[key] = value;
}

const databasePath = path.resolve(process.env.EMDASH_DB_PATH || "/app/data/emdash.db");

// Keep sessions beside the database so container recreates don't discard them.
const sessionPath = path.resolve(
	process.env.EMDASH_SESSION_PATH || path.join(path.dirname(databasePath), "sessions"),
);
try {
	mkdirSync(path.dirname(databasePath), { recursive: true });
	mkdirSync(sessionPath, { recursive: true });
} catch (error) {
	// Best effort: `astro build` evaluates this file on machines that have no /app (and no
	// write access to it), and the build must not fail there. At runtime the SQLite open
	// reports the real problem instead.
	console.warn(
		`[emdash] could not create ${path.dirname(databasePath)} or ${sessionPath}: ${error.code}`,
	);
}

// The list is evaluated at build time and cannot come from a runtime variable, so the public host
// is a literal here — a rebuild is what a domain move needs. `siteUrl` itself is deliberately *not*
// set in this config: EmDash reads EMDASH_SITE_URL (then SITE_URL) at request time.
const PUBLIC_HOST = "reinforce.moe";
const allowedDomains = [
	{ hostname: PUBLIC_HOST, protocol: "https" },
	{ hostname: PUBLIC_HOST, protocol: "http" },
];

// Cache tags EmDash bumps when chrome changes (site settings, menu, taxonomy terms, widget
// areas). See the note on `routeRules` below for why pages must name them themselves.
const CHROME_TAGS = [
	"emdash:settings",
	"emdash:menu:primary",
	"emdash:taxonomy:category",
	"emdash:taxonomy:tag",
	"emdash:widget-area:home-left",
	"emdash:widget-area:home-right",
	"emdash:widget-area:home-spotlight",
	"emdash:widget-area:sidebar",
];

export default defineConfig({
	output: "server",
	adapter: node({
		mode: "standalone",
	}),
	trailingSlash: "never",
	security: {
		allowedDomains,
	},
	vite: {
		server: {
			allowedHosts: [PUBLIC_HOST, "localhost"],
		},
	},
	// Astro only configures a driver when none is set, so this replaces the adapter's
	// image-layer default (see sessionPath above) rather than conflicting with it.
	session: {
		driver: sessionDrivers.fsLite({ base: sessionPath }),
	},
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	cache: {
		provider: routeMemoryCache({ max: 600 }),
	},
	// Which paths may be cached, for how long, and under which tags. Rules match by *path*,
	// the same `[param]` / `[...rest]` syntax as the file router, and they are independent of
	// the routes that actually exist — so a rule that is too broad silently covers routes it
	// was never meant for.
	//
	// The `emdash:*` entries are EmDash's chrome tags, and they are listed here rather than
	// left to the `cacheHint`s the layout passes to `Astro.cache.set()` — because those hints
	// never arrive. This site streams HTML (`Transfer-Encoding: chunked`): the response and its
	// headers are committed before a layout renders, so a hint set in `Base.astro` lands after
	// the cache entry's tags were already written. Verified by tagging the layout directly: the
	// marker was absent from the stored entry, while a page-frontmatter tag was present. Naming
	// the tags on the rule restores the invalidation EmDash documents (a settings save purges
	// `emdash:settings`, a menu edit `emdash:menu:primary`, and so on), at the cost of purging
	// every cached page on a chrome edit — rare, and pages are cheap to re-render.
	routeRules: {
		"/": { maxAge: 86_400, swr: 604_800, tags: ["posts", "pages", "all", ...CHROME_TAGS] },
		"/blog": { maxAge: 86_400, swr: 604_800, tags: ["posts", "all", ...CHROME_TAGS] },
		"/blog/[slug]": { maxAge: 86_400, swr: 604_800, tags: ["posts", "all", ...CHROME_TAGS] },
		// CMS pages live at the site root, so `/[slug]` is their route. It is a single-segment
		// rule: it can never reach `/_emdash/...` (two or more segments) but it would match
		// `/search`, `/robots.txt` and the sitemaps, which is why each of those gets its own
		// more specific rule below — a literal path outranks a dynamic one.
		"/[slug]": { maxAge: 86_400, swr: 604_800, tags: ["pages", "all", ...CHROME_TAGS] },
		"/category/[slug]": { maxAge: 86_400, swr: 604_800, tags: ["posts", "all", ...CHROME_TAGS] },
		"/tag/[slug]": { maxAge: 86_400, swr: 604_800, tags: ["posts", "all", ...CHROME_TAGS] },
		"/sitemap.xml": { maxAge: 86_400, swr: 604_800, tags: ["posts", "pages", "all"] },
		"/sitemap-[collection].xml": { maxAge: 86_400, swr: 604_800, tags: ["posts", "pages", "all"] },
		"/robots.txt": { maxAge: 86_400, swr: 604_800 },
		// Search results are a per-query render over FTS; caching them would fill the LRU with
		// one-off queries and buy little. `maxAge: 0` opts the path out (the provider only
		// stores responses with a positive max-age) without touching the page.
		"/search": { maxAge: 0 },
		// Image optimisation, i.e. every `/_image?href=…&w=…&f=webp` the pages emit. Astro's
		// route cache does cover it: `/_image` is a normal endpoint route, so it goes through
		// the same handler as a page. Untagged on purpose — the bytes are a pure function of
		// the query string, and url-addressed entries are invalidated by changing the URL
		// (a new media upload mints a new href), not by a content tag.
		//
		// The TTL is long because a cold AVIF encode costs seconds of CPU; the middleware in
		// src/middleware.ts keeps the endpoint's own `must-revalidate` / `max-age=0` responses
		// (EmDash's mutable-media path, and 304s) out of the cache regardless of this rule.
		"/_image": { maxAge: 604_800, swr: 2_592_000 },
	},
	integrations: [
		react(),
		emdash({
			database: sqlite({ url: `file:${databasePath}` }),
			objectCache: objectMemoryCache({
				defaultTtl: 3_600,
				maxEntries: 1_000,
			}),
			trustedProxyHeaders: ["x-forwarded-for"],
			middleware: { outer: "./src/site-redirects.ts" },
			// The media base must be known at build time for Astro remote image optimisation to work
			storage: import.meta.env.PROD
			  ? s3({ publicUrl: process.env.S3_PUBLIC_URL || "https://media.reinforce.moe" })
				: local({ directory: "./uploads", baseUrl: "/_emdash/api/media/file" }),
			plugins: [
				emdashSmtp(),
				{
					id: "comment-groups",
					version: "0.1.0",
					format: "native",
					entrypoint: "/src/plugins/comment-groups/index.ts",
					adminEntry: "/src/plugins/comment-groups/admin.tsx",
					adminPages: [{ path: "/comments", label: "Comments by post", icon: "message-circle" }],
				},
				{
					id: "og-image",
					version: "1.0.0",
					format: "native",
					entrypoint: "/src/plugins/og-image/index.ts",
				},
				{
					id: "site-stats",
					version: "0.1.0",
					format: "native",
					entrypoint: "/src/plugins/site-stats/index.ts",
				},
				{
					id: "file-download",
					version: "1.0.0",
					format: "native",
					entrypoint: "/src/plugins/file-download/index.ts",
					componentsEntry: "/src/plugins/file-download/astro.ts",
				},
			],
		}),
	],
	devToolbar: { enabled: false },
});
