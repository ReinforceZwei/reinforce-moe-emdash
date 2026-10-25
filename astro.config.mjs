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
export default defineConfig({
	output: "server",
	adapter: node({
		mode: "standalone",
	}),
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
