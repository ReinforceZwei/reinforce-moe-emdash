import { mkdirSync } from "node:fs";
import path from "node:path";
import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig, memoryCache as routeMemoryCache, sessionDrivers } from "astro/config";
import emdash, { s3, local, memoryCache as objectMemoryCache } from "emdash/astro";
import { emdashSmtp } from "emdash-smtp";
import { sqlite } from "emdash/db";
import { loadEnv } from "vite";

// Astro only reads `.env` files *after* it has evaluated this file, so `process.env` is empty
// here and nothing that `emdash()` reads from the environment (`S3_*`, `EMDASH_*`) is set when
// the site runs via `astro dev` on a machine without exported vars — the middleware then fails
// with MISSING_S3_CONFIG. Read the dotenv files ourselves and push them into `process.env` so
// both this config and the server it starts see them.
//
// Real environment variables always win (container/compose supplies them via `env_file:`), and
// `.env*` is in .dockerignore, so an image build never bakes them in.
const mode = process.env.NODE_ENV ?? "production";
for (const [key, value] of Object.entries(loadEnv(mode, process.cwd(), ""))) {
	if (process.env[key] === undefined) process.env[key] = value;
}

// SQLite lives on a mounted directory so the -wal/-shm files sit beside it. The path is
// overridable for local dev (`EMDASH_DB_PATH=./data/emdash.db`), and the directory is created
// here because SQLite creates the database file but never its parent directory — a fresh clone
// has no data/ and the first request would fail with ERR_SQLITE_ERROR 14.
const databasePath = path.resolve(process.env.EMDASH_DB_PATH || "/app/data/emdash.db");

// Sessions (how a signed-in admin stays signed in) live beside the database. Without an
// explicit driver @astrojs/node configures `<cacheDir>/sessions`, i.e.
// /app/node_modules/.astro/sessions — inside the image layer, not the mounted volume — so
// every container recreate (`docker compose up -d`, every image update) discards them and
// the admin comes back with a 401. Pinning the base keeps sessions across deploys; the
// path follows the database so `npm run dev` outside Docker works too.
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

// Media stays on S3 (Cloudflare R2), configured through S3_* environment vars.
//
// Reverse proxy (Traefik terminates TLS, forwards Host / X-Forwarded-Host / X-Forwarded-Proto).
// Astro only *reflects* those forwarded headers for hosts listed in `security.allowedDomains`, so
// that list is what makes `Astro.url` report the public origin instead of the internal
// `http://localhost:4321`; without it every canonical, `og:url` and absolute link built from the
// request advertises a host nobody can reach (this reached production once, as `localhost`
// canonicals while Traefik was forwarding the correct headers).
//
// The list is evaluated at build time and cannot come from a runtime variable, so the public host
// is a literal here — a rebuild is what a domain move needs. `siteUrl` itself is deliberately *not*
// set in this config: EmDash reads EMDASH_SITE_URL (then SITE_URL) at request time.
const PUBLIC_HOST = "reinforce.moe";
const allowedDomains = [
	{ hostname: PUBLIC_HOST, protocol: "https" },
	// Plain-HTTP requests are allowed too (probe/health checks, a proxy hop that keeps http on the
	// inside); a host that is not listed is not rejected, its forwarded headers are just ignored.
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
	security: {
		allowedDomains,
	},
	vite: {
		server: {
			// The dev-server counterpart of the same check, so `astro dev` accepts a proxied Host.
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
	// Route cache: stores the *rendered response* per URL, so a hit skips EmDash, SQLite and
	// Astro entirely. `memoryCache()` here is Astro's provider (`astro/config`), not EmDash's
	// object-cache adapter of the same name — it keeps entries inside this Node process, which
	// is the whole deployment (one standalone server, no CDN in front).
	//
	// `max` bounds the LRU in entries, and image responses share it with HTML, so the size is
	// really a memory budget: ~1000 entries of mixed HTML (~40 KB) and WebP/AVIF (~100 KB) can
	// approach 100 MB, and nothing above the default Node heap applies here (the app service
	// sets no mem_limit). 600 keeps the worst case near 60 MB.
	//
	// The cache key is the URL plus its query string (sorted, tracking params dropped by
	// default), so `/_image?href=…&w=640` and `&w=1280` are separate entries as they must be.
	cache: {
		provider: routeMemoryCache({ max: 600 }),
	},
	// Which paths may be cached, for how long, and under which tags. Rules match by *path*,
	// the same `[param]` / `[...rest]` syntax as the file router, and they are independent of
	// the routes that actually exist — so a rule that is too broad silently covers routes it
	// was never meant for. That is why every public path is listed explicitly instead of using
	// a catch-all: `/[...slug]` would also match `/_emdash/api/...` and cache admin responses.
	//
	// Tags are the invalidation channel: EmDash's content API purges `[collection, id]` on
	// publish/unpublish/delete, so tagging a route with the collection name it renders means a
	// publish shows up within seconds even though `maxAge` is a day. The per-entry tags come
	// from the `cacheHint` each page's frontmatter passes to `Astro.cache.set()` — the ids of
	// the entries it rendered — and they merge into the rule's tags.
	//
	// `maxAge` also bounds how stale a failed invalidation can leave a page, and one stale
	// response is served while `swr` refetches in the background.
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
			// Object cache: keeps query results (content reads, site settings, menus, taxonomy
			// terms, widgets) across requests so a render does not hit SQLite for every lookup.
			// Writes bump the namespace epoch, so a publish invalidates the affected queries
			// instead of waiting out `defaultTtl` — the TTL is only a backstop that reclaims
			// keys nobody read again. In-process, like the route cache above.
			//
			// With the route cache on, this layer does less for anonymous traffic than it
			// might look: a render that refills an invalidated route deliberately skips the
			// object cache and reads the database, so it cannot rebuild a page from an older
			// snapshot. What it buys is signed-in editors, previews and the admin.
			objectCache: objectMemoryCache({
				defaultTtl: 3_600,
				maxEntries: 1_000,
			}),
			// `siteUrl` is deliberately not set here: EmDash falls back to EMDASH_SITE_URL (then
			// SITE_URL) at runtime, so the image stays portable across environments.
			// Traefik writes X-Forwarded-For; trusting it lets the auth and comment rate limits count
			// per real client IP instead of lumping every visitor into one bucket. Safe here because
			// the app is only reachable through the proxy.
			trustedProxyHeaders: ["x-forwarded-for"],
			// Redirects the redirect table cannot express. Its destinations must be site-relative,
			// so a move to another host (/anone -> GitHub Pages) is served by this outer
			// middleware instead; it runs before EmDash's own middleware and before the database
			// is opened, and is evaluated at build time, so changing it means a rebuild.
			middleware: { outer: "./src/site-redirects.ts" },
			// The media base must be known at build time — EmDash bakes image.remotePatterns from
			// it and Astro refuses every host it does not authorise, falling back to a plain,
			// unoptimised <img>. It also has to match the bucket S3_* uploads into, or media the
			// site stores is served from a host that does not have it (404). Hence: env first
			// (`.env` is loaded above), production domain as the default.
			storage: import.meta.env.PROD
			  ? s3({ publicUrl: process.env.S3_PUBLIC_URL || "https://media.reinforce.moe" })
				: local({ directory: "./uploads", baseUrl: "/_emdash/api/media/file" }),
			// Email delivery (magic links, invites, account recovery). The provider
			// credentials are plugin settings stored in the database — enter the API key on
			// the plugin's admin page — and exactly one provider delivers at a time, so pick
			// it under Settings → Email. Without a provider, invites must be copied by hand.
			plugins: [emdashSmtp()],
		}),
	],
	devToolbar: { enabled: false },
});
