#!/usr/bin/env node
/**
 * Backfill image dimensions into Portable Text image blocks.
 *
 * EmDash only renders optimised images (`/_image?href=…` + srcset) when the
 * block carries `width`/`height`; without them emdash's <Image>/PT image
 * component silently falls back to a plain <img>. Content imported from the
 * WordPress REST API has `asset._ref`/`asset.url` but no dimensions, so every
 * post image is served unoptimised.
 *
 * This script fills `width`/`height` on image blocks (including gallery blocks)
 * in `ec_posts.content` and `ec_pages.content`, resolving each block against the
 * `media` table by id (`asset._ref`), storage key (`asset.meta.storageKey`) or
 * URL basename. It is idempotent: blocks that already have both dimensions are
 * skipped, so it is safe to re-run after importing more content.
 *
 * Usage:
 *   node scripts/backfill-image-dimensions.mjs [db-path] [--dry-run]
 *
 *   db-path    SQLite file, default ./data/emdash.db
 *   --dry-run  report what would change without writing
 *
 * Run it against the site database *before* restarting the app:
 *   node scripts/backfill-image-dimensions.mjs /app/data/emdash.db
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dbPath = resolve(args.find((a) => !a.startsWith("--")) ?? "data/emdash.db");

if (!existsSync(dbPath)) {
	console.error(`backfill: database not found: ${dbPath}`);
	process.exit(1);
}

const db = new DatabaseSync(dbPath);

/** @returns {{ id: string, storageKey: string|null, url: string|null, width: number|null, height: number|null, alt: string|null }} */
const mediaRows = db
	.prepare("select id, storage_key, width, height, alt from media")
	.all();

const byId = new Map();
const byKey = new Map();
const byBasename = new Map();

for (const row of mediaRows) {
	if (row.width == null || row.height == null) continue; // SVG/PDF or a failed probe
	byId.set(row.id, row);
	if (row.storage_key) {
		byKey.set(row.storage_key, row);
		const name = basename(row.storage_key);
		if (!byBasename.has(name)) byBasename.set(name, row);
	}
}

function lookup(block) {
	const asset = block.asset ?? {};
	const ref = asset._ref ?? asset.id;
	if (typeof ref === "string" && byId.has(ref)) return byId.get(ref);

	const key = asset.meta?.storageKey;
	if (typeof key === "string" && byKey.has(key)) return byKey.get(key);

	if (typeof asset.url === "string" && asset.url) {
		let pathname = asset.url;
		try {
			pathname = new URL(asset.url, "http://localhost").pathname;
		} catch {
			/* keep raw value */
		}
		const name = basename(pathname);
		if (byBasename.has(name)) return byBasename.get(name);
	}
	return null;
}

let blocksSeen = 0;
let blocksFilled = 0;
let blocksUnresolved = 0;

function fillImage(block) {
	if (!block || typeof block !== "object") return;
	if (block.width != null && block.height != null) return;
	if (!block.asset) return;

	blocksSeen++;
	const media = lookup(block);
	if (!media) {
		blocksUnresolved++;
		return;
	}
	block.width = media.width;
	block.height = media.height;
	if (!block.alt && media.alt) block.alt = media.alt;
	blocksFilled++;
}

function walk(node) {
	if (!node || typeof node !== "object") return;
	if (Array.isArray(node)) {
		for (const item of node) walk(item);
		return;
	}
	if (node._type === "image") fillImage(node);
	if (node._type === "gallery" && Array.isArray(node.images)) {
		for (const image of node.images) fillImage(image);
	}
	for (const value of Object.values(node)) walk(value);
}

const tables = db
	.prepare(
		"select name from sqlite_master where type = 'table' and name in ('ec_posts','ec_pages') order by name",
	)
	.all()
	.map((row) => row.name);

let rowsUpdated = 0;

for (const table of tables) {
	const rows = db.prepare(`select id, content from ${table}`).all();
	for (const row of rows) {
		const raw = row.content;
		if (!raw) continue;

		let content;
		try {
			content = typeof raw === "string" ? JSON.parse(raw) : raw;
		} catch {
			console.warn(`backfill: ${table}/${row.id}: content is not JSON, skipped`);
			continue;
		}

		const before = blocksFilled;
		walk(content);
		if (blocksFilled === before) continue;

		rowsUpdated++;
		if (!dryRun) {
			db.prepare(`update ${table} set content = ? where id = ?`).run(
				JSON.stringify(content),
				row.id,
			);
		}
	}
}

db.close();

console.log(
	`backfill: ${dryRun ? "would fill" : "filled"} ${blocksFilled} image block(s) across ${rowsUpdated} row(s)`,
);
console.log(
	`backfill: ${blocksSeen} block(s) lacked dimensions, ${blocksUnresolved} could not be resolved against the media table`,
);
if (dryRun) console.log("backfill: dry run, nothing written");
if (blocksUnresolved > 0) {
	console.log(
		"backfill: unresolved blocks reference media that is not in this database (imported remotely?) - they stay unoptimised",
	);
}
