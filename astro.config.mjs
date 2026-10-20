import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import emdash, { s3 } from "emdash/astro";
import { sqlite } from "emdash/db";

// SQLite lives on a mounted directory so the -wal/-shm files sit beside it.
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
			database: sqlite({ url: "file:/app/data/emdash.db" }),
			// Hardcoded (not env): EmDash bakes image.remotePatterns at build time and only reads
			// `publicUrl` from this config, never from S3_PUBLIC_URL. Without it Astro refuses the
			// media host and every image falls back to a plain, unoptimised <img>.
			storage: s3({ publicUrl: "https://media.reinforce.moe" }),
		}),
	],
	devToolbar: { enabled: false },
});
