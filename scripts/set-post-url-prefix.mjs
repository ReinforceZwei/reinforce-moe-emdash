#!/usr/bin/env node
/**
 * Point the posts collection at a different URL prefix, and keep old links working.
 *
 * The route prefix a post is served under comes from two places, and both have to agree:
 *
 *   1. `src/pages/blog/[slug].astro` — Astro's file-based route (a code change: rename the folder
 *      and update the hardcoded links in PostPreview/search/list pagination).
 *   2. `_emdash_collections.url_pattern` — the database copy EmDash uses for entry URLs that the
 *      site does not render itself: `<link rel="canonical">`, the sitemaps, the admin's "View"
 *      link and preview URLs. `seed/seed.json` carries the same value for fresh databases, but a
 *      database that was seeded before the change keeps the old pattern until this script runs.
 *
 * This script performs step 2: it rewrites the collection's `url_pattern` and installs 301
 * redirects from the previous prefix so existing links (and whatever was indexed while the site
 * served the old URLs) keep resolving.
 *
 * Usage:
 *   node scripts/set-post-url-prefix.mjs [db-path] [options]
 *
 *   db-path            SQLite file, default $EMDASH_DB_PATH or ./data/emdash.db
 *   --collection <s>   collection slug, default `posts`
 *   --prefix <p>       new URL prefix, default `/blog`
 *   --from <p>         previous prefix to redirect from, default `/posts`
 *   --no-redirects     only rewrite the pattern
 *   --dry-run          report what would change without writing
 *
 * Run it against the database the app will open, then restart the app:
 *   node scripts/set-post-url-prefix.mjs ./data.db --prefix /blog
 *   node scripts/set-post-url-prefix.mjs /app/data/emdash.db --prefix /blog
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const noRedirects = args.includes("--no-redirects");

function option(name, fallback) {
	const index = args.indexOf(name);
	return index === -1 ? fallback : args[index + 1];
}

/** A prefix is a single path segment set, always with a leading and no trailing slash. */
function normalizePrefix(value, label) {
	const prefix = `/${String(value).replace(/^\/+|\/+$/g, "")}`;
	if (prefix === "/") {
		console.error(`set-url-prefix: ${label} must not be the site root`);
		process.exit(1);
	}
	if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/.test(prefix)) {
		console.error(`set-url-prefix: ${label} is not a valid URL path: ${value}`);
		process.exit(1);
	}
	return prefix;
}

const positional = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const dbPath = resolve(positional ?? process.env.EMDASH_DB_PATH ?? "data/emdash.db");
const collection = option("--collection", "posts");
const toPrefix = normalizePrefix(option("--prefix", "/blog"), "--prefix");
const fromPrefix = normalizePrefix(option("--from", "/posts"), "--from");

if (!existsSync(dbPath)) {
	console.error(`set-url-prefix: database not found: ${dbPath}`);
	process.exit(1);
}
if (toPrefix === fromPrefix) {
	console.error("set-url-prefix: --prefix and --from are the same; nothing to do");
	process.exit(1);
}

const db = new DatabaseSync(dbPath);

const pattern = `${toPrefix}/{slug}`;
const existing = db
	.prepare("SELECT id, url_pattern FROM _emdash_collections WHERE slug = ?")
	.get(collection);

if (!existing) {
	console.error(`set-url-prefix: no collection "${collection}" in ${dbPath}`);
	process.exit(1);
}

console.log(`database:   ${dbPath}`);
console.log(`collection: ${collection}`);
console.log(`url_pattern: ${existing.url_pattern} -> ${pattern}`);

if (existing.url_pattern === pattern) {
	console.log("url_pattern already up to date");
} else if (dryRun) {
	console.log("would update url_pattern");
} else {
	db.prepare(
		"UPDATE _emdash_collections SET url_pattern = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
	).run(pattern, existing.id);
	console.log("updated url_pattern");
}

if (noRedirects) {
	console.log("redirects: skipped (--no-redirects)");
} else {
	// Exact rule for the bare index, catch-all for entries. EmDash matches exact rules first
	// (tolerating a trailing slash) and then patterns in creation order, so both are needed:
	// `/posts/[...path]` does not match `/posts` on its own.
	const rules = [
		{ source: fromPrefix, destination: toPrefix },
		{ source: `${fromPrefix}/[...path]`, destination: `${toPrefix}/[...path]` },
	];

	const find = db.prepare("SELECT id, destination, type, enabled FROM _emdash_redirects WHERE source = ?");
	const insert = db.prepare(
		`INSERT INTO _emdash_redirects (id, source, destination, type, is_pattern, enabled, group_name, auto)
		 VALUES (?, ?, ?, 301, ?, 1, ?, 1)`,
	);

	for (const rule of rules) {
		const isPattern = rule.source.includes("[") ? 1 : 0;
		const found = find.get(rule.source);

		if (found) {
			const same = found.destination === rule.destination && found.type === 301 && found.enabled === 1;
			console.log(`redirect: ${rule.source} -> ${rule.destination} (already present${same ? "" : ", differs"})`);
			if (same || dryRun) continue;
			db.prepare(
				"UPDATE _emdash_redirects SET destination = ?, type = 301, is_pattern = ?, enabled = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
			).run(rule.destination, isPattern, found.id);
			continue;
		}

		if (dryRun) {
			console.log(`would add redirect: ${rule.source} -> ${rule.destination}`);
			continue;
		}
		// The insert triggers bump `_emdash_redirect_state.revision`, which is what makes the
		// running app reload its compiled rule cache — no restart is needed for redirects.
		insert.run(randomUUID(), rule.source, rule.destination, isPattern, `${fromPrefix} prefix move`);
		console.log(`redirect: ${rule.source} -> ${rule.destination} (added)`);
	}
}

db.close();
console.log(dryRun ? "dry run: nothing written" : "done");
