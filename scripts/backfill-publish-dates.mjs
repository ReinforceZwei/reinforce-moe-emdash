#!/usr/bin/env node
/**
 * Backfill content timestamps after a seed run.
 *
 * EmDash's seed format has no date fields: `seed/apply.ts` creates every entry that is not a
 * draft with `publishedAt: new Date()` (and the table defaults set created/updated to the same
 * moment), so a freshly seeded site shows every post as published today and sorts the archive by
 * seed order instead of by date. `export-seed` does not emit the timestamps either, so they cannot
 * round-trip through the seed at all.
 *
 * This script applies the separate mapping in `seed/publish-dates.json` to
 * `ec_<collection>.published_at`, `.created_at` and `.updated_at`. Each entry is either an ISO
 * string (publish date only) or an object:
 *
 *   { "posts": { "<slug>": { "publishedAt": "…", "createdAt": "…", "updatedAt": "…" } } }
 *
 * `createdAt` defaults to `publishedAt`, `updatedAt` to `createdAt`. Only the columns whose value
 * differs are written, so the script is idempotent and safe to re-run after another seed.
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

/** Mapping key -> database column, in dependency order (createdAt/updatedAt default to earlier ones). */
const FIELDS = [
	["publishedAt", "published_at"],
	["createdAt", "created_at"],
	["updatedAt", "updated_at"],
];

const mapping = JSON.parse(readFileSync(mapPath, "utf8"));
const db = new DatabaseSync(dbPath);

const toIso = (value) => {
	const parsed = new Date(value);
	return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
};

let updatedEntries = 0;
let updatedFields = 0;
let unchanged = 0;
const missing = [];
const invalid = [];

for (const [collection, entries] of Object.entries(mapping)) {
	if (!entries || typeof entries !== "object") continue;

	// Collection slugs map to table names one to one: posts -> ec_posts.
	const table = `ec_${collection}`;
	let rows;
	try {
		rows = db.prepare(`select slug, ${FIELDS.map(([, c]) => c).join(", ")} from ${table}`).all();
	} catch (error) {
		console.warn(`backfill: skipping "${collection}" (${error.message})`);
		continue;
	}

	const bySlug = new Map(rows.map((row) => [row.slug, row]));

	for (const [slug, value] of Object.entries(entries)) {
		const spec = typeof value === "string" ? { publishedAt: value } : value ?? {};

		const targets = {};
		for (const [key, column] of FIELDS) {
			const raw = spec[key];
			if (raw === undefined) continue;
			const iso = toIso(raw);
			if (!iso) {
				invalid.push(`${collection}/${slug} ${key}: ${raw}`);
				continue;
			}
			targets[column] = iso;
		}
		// Fallbacks: created follows published, updated follows created.
		targets.created_at ??= targets.published_at;
		targets.updated_at ??= targets.created_at;

		const row = bySlug.get(slug);
		if (!row) {
			missing.push(`${collection}/${slug}`);
			continue;
		}

		const changes = Object.entries(targets).filter(([column, iso]) => row[column] !== iso);
		if (changes.length === 0) {
			unchanged++;
			continue;
		}

		const detail = changes
			.map(([column, iso]) => `${column} ${row[column] ?? "(null)"} -> ${iso}`)
			.join(", ");
		console.log(`${dryRun ? "would set" : "set"} ${collection}/${slug}: ${detail}`);

		if (!dryRun) {
			const setClause = changes.map(([column]) => `${column} = ?`).join(", ");
			db.prepare(`update ${table} set ${setClause} where slug = ?`).run(
				...changes.map(([, iso]) => iso),
				slug,
			);
		}
		updatedEntries++;
		updatedFields += changes.length;
	}
}

if (!dryRun) db.close();

console.log(
	`\nbackfill-publish-dates: ${updatedEntries} entries (${updatedFields} fields) ${dryRun ? "to update" : "updated"}, ${unchanged} already correct, ${missing.length} missing, ${invalid.length} invalid${dryRun ? " (dry run)" : ""}`,
);
if (missing.length) console.log(`  missing from database: ${missing.join(", ")}`);
if (invalid.length) console.log(`  invalid timestamps: ${invalid.join(", ")}`);
