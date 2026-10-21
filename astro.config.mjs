import { mkdirSync } from "node:fs";
import path from "node:path";
import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import emdash, { s3 } from "emdash/astro";
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
try {
	mkdirSync(path.dirname(databasePath), { recursive: true });
} catch (error) {
	// Best effort: `astro build` evaluates this file on machines that have no /app (and no
	// write access to it), and the build must not fail there. At runtime the SQLite open
	// reports the real problem instead.
	console.warn(`[emdash] could not create ${path.dirname(databasePath)}: ${error.code}`);
}

// Media stays on S3 (Cloudflare R2), configured through S3_* environment vars.
export default defineConfig({
	output: "server",
	adapter: node({
		mode: "standalone",
	}),
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [
		react(),
		emdash({
			database: sqlite({ url: `file:${databasePath}` }),
			// Hardcoded (not env): EmDash bakes image.remotePatterns at build time and only reads
			// `publicUrl` from this config, never from S3_PUBLIC_URL. Without it Astro refuses the
			// media host and every image falls back to a plain, unoptimised <img>.
			storage: s3({ publicUrl: "https://media.reinforce.moe" }),
		}),
	],
	devToolbar: { enabled: false },
});
