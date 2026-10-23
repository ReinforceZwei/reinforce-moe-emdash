#!/usr/bin/env node
/**
 * Decode percent-encoded slugs in content tables.
 *
 * Imported content can store browser-encoded slugs (`%e7%ac%ac%e4%b8%80...`)
 * while EmDash treats `ec_<collection>.slug` as the raw Unicode slug: routes
 * call `decodeSlug(Astro.params.slug)` before the database lookup, so an
 * encoded row never matches and the entry 404s.
 *
 * This rewrites `ec_posts.slug`, `ec_pages.slug` and `taxonomies.slug` with
 * their decoded values. It is idempotent, aborts on decoded collisions, and
 * leaves timestamps alone.
 *
 * A database that was seeded and then imported can hold both a raw and an
 * encoded row for the same term (`(name, slug, locale)` only collides after
 * decoding). `--dedupe-orphan-terms` deletes the unreferenced copy so the
 * decode can proceed; without it a collision aborts the run.
 *
 * Usage:
 *   node scripts/backfill-decode-slugs.mjs [db-path] [--dry-run] [--dedupe-orphan-terms]
 *
 *   db-path                  SQLite file, default ./data/emdash.db
 *   --dry-run                report what would change without writing
 *   --dedupe-orphan-terms    drop taxonomy rows that no content references
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const TABLES = [
	{ table: "ec_posts", unique: ["slug", "locale"] },
	{ table: "ec_pages", unique: ["slug", "locale"] },
	{ table: "taxonomies", unique: ["name", "slug", "locale"], terms: true },
];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dedupeOrphanTerms = args.includes("--dedupe-orphan-terms");
const positional = args.find((arg) => !arg.startsWith("--"));
const dbPath = resolve(positional ?? "data/emdash.db");

if (!existsSync(dbPath)) {
	console.error(`backfill: database not found: ${dbPath}`);
	process.exit(1);
}

const db = new DatabaseSync(dbPath);

let updated = 0;
let deleted = 0;
let skipped = 0;
let failed = false;

const termContentRefs = db.prepare("select count(*) as count from content_taxonomies where taxonomy_id = ?");
const termChildRefs = db.prepare("select count(*) as count from taxonomies where parent_id = ?");

/** Number of rows that would dangle if this taxonomy row were removed. */
function termRefCount(row) {
	const key = row.translation_group ?? row.id;
	return termContentRefs.get(key).count + termChildRefs.get(row.id).count;
}

const describeKey = (unique, row) => {
	const extras = unique
		.filter((column) => column !== "slug")
		.map((column) => `${column}=${row[column]}`);
	return [`slug=${JSON.stringify(row.decoded)}`, ...extras].join(", ");
};

db.exec("BEGIN IMMEDIATE");
try {
	for (const { table, unique, terms = false } of TABLES) {
		const extraColumns = unique.filter((column) => column !== "slug");
		const columns = ["id", "slug", ...extraColumns, ...(terms ? ["translation_group"] : [])].join(", ");
		const rows = db.prepare(`select ${columns} from ${table}`).all();

		// Group rows by the unique key they will have once decoded, so a
		// collision is caught before the unique constraint fires mid-transaction.
		const groups = new Map();
		for (const row of rows) {
			let decoded = row.slug;
			if (row.slug.includes("%")) {
				try {
					decoded = decodeURIComponent(row.slug);
				} catch {
					console.warn(`${table}/${row.id}: undecodable slug, leaving as is: ${row.slug}`);
					skipped++;
					continue;
				}
			}

			const key = [decoded, ...extraColumns.map((column) => row[column])].join("\u0000");
			const group = groups.get(key) ?? [];
			group.push({ ...row, decoded });
			groups.set(key, group);
		}

		const changes = [];
		const removals = [];

		for (const group of groups.values()) {
			if (group.length === 1) {
				const [row] = group;
				if (row.decoded !== row.slug) changes.push(row);
				continue;
			}

			const label = `${table}: decoding collides on (${describeKey(unique, group[0])}) between ${group.map((row) => row.id).join(", ")}`;

			if (!terms || !dedupeOrphanTerms) {
				console.error(label);
				failed = true;
				continue;
			}

			const referenced = group.filter((row) => termRefCount(row) > 0);
			const orphans = group.filter((row) => termRefCount(row) === 0);
			if (referenced.length !== 1) {
				console.error(`${label}; cannot pick a survivor (${referenced.length} referenced rows)`);
				failed = true;
				continue;
			}

			removals.push(...orphans);
			if (referenced[0].decoded !== referenced[0].slug) changes.push(referenced[0]);
		}

		if (failed) continue;

		const remove = db.prepare(`delete from ${table} where id = ?`);
		for (const row of removals) {
			console.log(`${dryRun ? "would delete" : "delete"} ${table}/${row.id}: orphaned duplicate ${row.slug}`);
			if (!dryRun) remove.run(row.id);
			deleted++;
		}

		const update = db.prepare(`update ${table} set slug = ? where id = ?`);
		for (const change of changes) {
			console.log(`${dryRun ? "would update" : "update"} ${table}/${change.id}: ${change.slug} -> ${change.decoded}`);
			if (!dryRun) update.run(change.decoded, change.id);
			updated++;
		}
		if (changes.length === 0 && removals.length === 0) console.log(`${table}: nothing to decode`);
	}

	if (failed) {
		db.exec("ROLLBACK");
		process.exit(1);
	}
	db.exec(dryRun ? "ROLLBACK" : "COMMIT");
} catch (error) {
	db.exec("ROLLBACK");
	throw error;
} finally {
	db.close();
}

console.log(
	`${dryRun ? "dry run: " : ""}${updated} slug(s) ${dryRun ? "would be " : ""}updated, ${deleted} duplicate(s) ${
		dryRun ? "would be " : ""
	}deleted, ${skipped} skipped`,
);
