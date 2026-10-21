#!/usr/bin/env node
/**
 * Backfill content publish dates after a seed run.
 *
 * EmDash's seed format has no date fields: `seed/apply.ts` creates every entry that is not a
 * draft with `publishedAt: new Date().toISOString()`, so a freshly seeded site shows every post
 * as published today and sorts the archive by seed order instead of by date. `export-seed` does
 * not emit the timestamps either, so they cannot round-trip through the seed at all.
 *
 * This script applies the separate mapping in `seed/publish-dates.json`
 * (`{ "<collection>": { "<slug>": "<ISO 8601>" } }`, taken from the source site's public dates)
 * to `ec_<collection>.published_at`. It only touches entries whose timestamp differs, so it is
 * idempotent and safe to re-run after another seed.
 *
 * Usage:
 *   node scripts/backfill-publish-dates.mjs [db-path] [options]
 *
 *   db-path            SQLite file, default ./data/emdash.db
 *   --map <path>       mapping file, default ./seed/publish-dates.json
 *   --dry-run          report what would change without writing
 *
 * Run it before restarting the app:
 *   node scripts/backfill-publish-dates.mjs /app/data/emdash.db
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

function option(name, fallback) {
	const index = args.indexOf(name);
	return index === -1 ? fallback : args[index + 1];
}

const positional = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const dbPath = resolve(positional ?? "data/emdash.db");
const mapPath = resolve(option("--map", "seed/publish-dates.json"));

for (const [label, file] of [["database", dbPath], ["mapping", mapPath]]) {
	if (!existsSync(file)) {
		console.error(`backfill: ${label} not found: ${file}`);
		process.exit(1);
	}
}

const mapping = JSON.parse(readFileSync(mapPath, "utf8"));
const db = new DatabaseSync(dbPath);

let updated = 0;
let unchanged = 0;
const missing = [];
const invalid = [];

for (const [collection, entries] of Object.entries(mapping)) {
	if (!entries || typeof entries !== "object") continue;

	// Collection slugs map to table names one to one: posts -> ec_posts.
	const table = `ec_${collection}`;
	let rows;
	try {
		rows = db.prepare(`select slug, published_at from ${table}`).all();
	} catch (error) {
		console.warn(`backfill: skipping "${collection}" (${error.message})`);
		continue;
	}

	const bySlug = new Map(rows.map((row) => [row.slug, row]));
	const update = db.prepare(`update ${table} set published_at = ? where slug = ?`);

	for (const [slug, iso] of Object.entries(entries)) {
		const parsed = new Date(iso);
		if (Number.isNaN(parsed.valueOf())) {
			invalid.push(`${collection}/${slug}: ${iso}`);
			continue;
		}
		const target = parsed.toISOString();

		const row = bySlug.get(slug);
		if (!row) {
			missing.push(`${collection}/${slug}`);
			continue;
		}
		if (row.published_at === target) {
			unchanged++;
			continue;
		}

		const before = row.published_at ?? "(null)";
		console.log(`${dryRun ? "would set" : "set"} ${collection}/${slug}: ${before} -> ${target}`);
		if (!dryRun) update.run(target, slug);
		updated++;
	}
}

if (!dryRun) db.close();

console.log(
	`\nbackfill-publish-dates: ${updated} ${dryRun ? "to update" : "updated"}, ${unchanged} already correct, ${missing.length} missing, ${invalid.length} invalid${dryRun ? " (dry run)" : ""}`,
);
if (missing.length) console.log(`  missing from database: ${missing.join(", ")}`);
if (invalid.length) console.log(`  invalid timestamps: ${invalid.join(", ")}`);
