import { mkdirSync } from "node:fs";
import path from "node:path";
import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig, sessionDrivers } from "astro/config";
import emdash, { s3 } from "emdash/astro";
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
	integrations: [
		react(),
		emdash({
			database: sqlite({ url: `file:${databasePath}` }),
			// `siteUrl` is deliberately not set here: EmDash falls back to EMDASH_SITE_URL (then
			// SITE_URL) at runtime, so the image stays portable across environments.
			// Traefik writes X-Forwarded-For; trusting it lets the auth and comment rate limits count
			// per real client IP instead of lumping every visitor into one bucket. Safe here because
			// the app is only reachable through the proxy.
			trustedProxyHeaders: ["x-forwarded-for"],
			// The media base must be known at build time — EmDash bakes image.remotePatterns from
			// it and Astro refuses every host it does not authorise, falling back to a plain,
			// unoptimised <img>. It also has to match the bucket S3_* uploads into, or media the
			// site stores is served from a host that does not have it (404). Hence: env first
			// (`.env` is loaded above), production domain as the default.
			storage: s3({ publicUrl: process.env.S3_PUBLIC_URL || "https://media.reinforce.moe" }),
			// Email delivery (magic links, invites, account recovery). The provider
			// credentials are plugin settings stored in the database — enter the API key on
			// the plugin's admin page — and exactly one provider delivers at a time, so pick
			// it under Settings → Email. Without a provider, invites must be copied by hand.
			plugins: [emdashSmtp()],
		}),
	],
	devToolbar: { enabled: false },
});
