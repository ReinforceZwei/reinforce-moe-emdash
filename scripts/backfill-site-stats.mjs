#!/usr/bin/env node
/**
 * Import historical stats (from build.mjs) into the site-stats plugin's storage.
 *
 * Runs inside the app image against the live SQLite file, e.g.
 *   docker compose run --rm --no-deps -v "$PWD/backfill:/backfill:ro" app \
 *     node /backfill/backfill-site-stats.mjs /backfill/aggregate.json
 *
 * - Dry run by default. `--apply` writes; `--rollback` undoes a previous `--apply`.
 * - `--apply` first takes a consistent `VACUUM INTO` copy next to the database (or `--backup-dir`).
 * - Only days before the first day the plugin counted live are imported, so nothing is counted twice.
 * - History is written the way the monthly rollup stores it: whole months go straight into
 *   `pagesm`/`dimsm` with a `rollup:YYYY-MM` marker (so long ranges read fast), and per-day page/dim
 *   rows are kept only for the last 400 days and for a month that is still open (the live
 *   compaction rolls that month up later). `days` rows are written for every day.
 * - Imported rows carry `seed: 1`; the all-time totals are incremented atomically and
 *   the exact amounts are kept in a ledger row (`totals/backfill`), so rollback subtracts exactly
 *   what was added. A second `--apply` is refused while a ledger exists.
 * - Safe beside the running site: one short write transaction, WAL, 30 s busy timeout.
 *
 * Usage: node backfill-site-stats.mjs <aggregate.json> [--db /app/data/emdash.db] [--apply|--rollback] [--backup-dir DIR]
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const monthOf = (day) => day.slice(0, 7);
const monthEnd = (m) => { const [y, mo] = m.split("-").map(Number); return addDays(new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10), -1); };
const DAY_ROWS_KEPT = 400; // days of per-day page/dim rows kept: covers the longest range (365d) plus its edge month

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const skip = new Set([opt("--db"), opt("--backup-dir")].filter(Boolean));
const aggPath = argv.find((a) => !a.startsWith("--") && !skip.has(a));
const dbPath = resolve(opt("--db", "/app/data/emdash.db"));
const APPLY = flag("--apply");
const ROLLBACK = flag("--rollback");
if (APPLY && ROLLBACK) throw new Error("--apply and --rollback are exclusive");
if (!ROLLBACK && !aggPath) throw new Error("usage: backfill-site-stats.mjs <aggregate.json> [--db path] [--apply|--rollback]");
if (!existsSync(dbPath)) throw new Error(`database not found: ${dbPath}`);

const PLUGIN = "site-stats";
const db = new DatabaseSync(dbPath, { readOnly: !APPLY && !ROLLBACK });
db.exec("PRAGMA busy_timeout = 30000");
const get = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);
const log = (...a) => console.log(...a);
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);

if (!get("select 1 x from sqlite_master where name = '_plugin_storage'")) throw new Error("no _plugin_storage table: is this the site database?");
const ledger = get("select data from _plugin_storage where plugin_id = ? and collection = 'totals' and id = 'backfill'", PLUGIN);

if (ROLLBACK) {
	if (!ledger) { log("No ledger row: nothing to roll back."); process.exit(0); }
	const L = JSON.parse(ledger.data);
	db.exec("BEGIN IMMEDIATE");
	try {
		const del = (c) => db.prepare("delete from _plugin_storage where plugin_id = ? and collection = ? and json_extract(data, '$.seed') = 1").run(PLUGIN, c).changes;
		const removed = Object.fromEntries(["days", "pages", "dims", "pagesm", "dimsm", "totals"].map((c) => [c, del(c)])); // totals: the rollup markers
		const dec = db.prepare("update _plugin_storage set data = json_set(data, '$.views', coalesce(json_extract(data, '$.views'), 0) - cast(? as integer)) where plugin_id = ? and collection = 'totals' and id = ?");
		db.prepare("update _plugin_storage set data = json_set(data, '$.views', coalesce(json_extract(data, '$.views'), 0) - cast(? as integer), '$.uniques', coalesce(json_extract(data, '$.uniques'), 0) - cast(? as integer)) where plugin_id = ? and collection = 'totals' and id = 'site'").run(L.site.views, L.site.uniques, PLUGIN);
		for (const [key, views] of Object.entries(L.entries)) dec.run(views, PLUGIN, `e:${key}`);
		// Entries that only existed because of the import go away with it.
		const emptied = db.prepare("delete from _plugin_storage where plugin_id = ? and collection = 'totals' and id like 'e:%' and coalesce(json_extract(data, '$.views'), 0) <= 0").run(PLUGIN).changes;
		db.prepare("delete from _plugin_storage where plugin_id = ? and collection = 'totals' and id = 'backfill'").run(PLUGIN);
		db.exec("COMMIT");
		log("Rolled back.", { removed, emptiedTotals: emptied, subtracted: L.site });
	} catch (e) { db.exec("ROLLBACK"); throw e; }
	process.exit(0);
}

if (ledger) throw new Error(`A backfill is already applied (${JSON.parse(ledger.data).at}). Run --rollback first to redo it.`);
const agg = JSON.parse(readFileSync(aggPath, "utf8"));
if (agg.version !== 1) throw new Error(`unsupported aggregate version ${agg.version}`);

// Live data starts on the first day a non-imported `days` row exists.
const live = get("select min(json_extract(data, '$.day')) d from _plugin_storage where plugin_id = ? and collection = 'days' and coalesce(json_extract(data, '$.seed'), 0) = 0", PLUGIN).d;
const cutoff = live ?? "9999-99-99";
const keep = (day) => day < cutoff;
log(`Database: ${dbPath} (${(statSync(dbPath).size / 1e6).toFixed(1)} MB)`);
log(`First live day: ${live ?? "none yet"}; importing days before it. Aggregate: ${agg.days[0]?.day}..${agg.days.at(-1)?.day}`);

// Resolve slugs against this database; unresolved ones are reported, not guessed.
const ids = { posts: new Map(), pages: new Map() };
for (const t of ["posts", "pages"]) for (const r of all(`select id, slug from ec_${t} where deleted_at is null`)) ids[t].set(r.slug, r.id);
const terms = new Set(all("select name, slug from taxonomies where name in ('category','tag')").map((r) => `${r.name}|${r.slug}`));
const unresolved = new Map();
const keyOf = (p) => {
	if (p.kind === "home") return "home";
	if (p.kind === "content") { const id = ids[p.group]?.get(p.slug); return id ? `${p.group}:${id}` : null; }
	if (p.kind === "term") return terms.has(`${p.group}|${p.slug}`) ? `term:${p.group}:${p.slug}` : null;
	return null;
};
const pageRows = new Map(); // `${day}|${key}` -> views
for (const p of agg.pages) {
	if (!keep(p.day)) continue;
	const key = keyOf(p);
	if (!key) { const k = `${p.kind}:${p.group}:${p.slug}`; unresolved.set(k, (unresolved.get(k) ?? 0) + p.views); continue; }
	pageRows.set(`${p.day}|${key}`, (pageRows.get(`${p.day}|${key}`) ?? 0) + p.views);
}
const days = agg.days.filter((d) => keep(d.day));
const dimsAll = agg.dims.filter((d) => keep(d.day));
const entries = {};
for (const [k, v] of pageRows) { const key = k.slice(k.indexOf("|") + 1); entries[key] = (entries[key] ?? 0) + v; }
const site = { views: sum(days, (d) => d.views), uniques: sum(days, (d) => d.uniques) };


// A month goes into the rollup when the import covers all of it; the month the live data starts in
// (or the aggregate ends in) stays per-day and is rolled up later by the plugin.
const lastDay = days.at(-1)?.day ?? agg.days.at(-1).day;
const months = [...new Set(days.map((d) => monthOf(d.day)))].filter((m) => monthEnd(m) < cutoff && monthEnd(m) <= lastDay);
const rolled = new Set(months);
const dayRowFrom = addDays(live ?? addDays(lastDay, 1), -DAY_ROWS_KEPT);
const keepDayRow = (day) => !rolled.has(monthOf(day)) || day >= dayRowFrom;
const markers = new Set(all("select json_extract(data, '$.month') m from _plugin_storage where plugin_id = ? and collection = 'totals' and json_extract(data, '$.kind') = 'rollup'", PLUGIN).map((r) => r.m));
const clash = [...months, ...(live ? [monthOf(live)] : [])].filter((m) => markers.has(m));
if (clash.length) throw new Error(`Rollup markers already exist for ${clash.join(", ")}: those months were rolled up from live data and cannot take an import. Aborting.`);
const pageMonthly = new Map(); // `${month}|${key}` -> views
for (const [k, v] of pageRows) { const i = k.indexOf("|"); const m = monthOf(k); if (rolled.has(m)) pageMonthly.set(`${m}|${k.slice(i + 1)}`, (pageMonthly.get(`${m}|${k.slice(i + 1)}`) ?? 0) + v); }
const dimMonthly = new Map(); // `${month}|${kind}|${value}` -> { kind, value, count }
for (const d of dimsAll) { const m = monthOf(d.day); if (!rolled.has(m)) continue; const k = `${m}|${d.kind}|${d.value}`; const cur = dimMonthly.get(k) ?? { month: m, kind: d.kind, value: d.value, count: 0 }; cur.count += d.count; dimMonthly.set(k, cur); }
const pageDayRows = [...pageRows].filter(([k]) => keepDayRow(k.slice(0, 10)));
const dims = dimsAll.filter((d) => keepDayRow(d.day));

log("\nWould import:");
log(`  days:  ${days.length} rows, ${site.views} views, ${site.uniques} visitors`);
log(`  pages: ${sum(Object.values(entries), (v) => v)} views over ${Object.keys(entries).length} pages`);
log(`  rollup: ${months.length} whole months (${months[0]}..${months.at(-1)}): ${pageMonthly.size} page rows, ${dimMonthly.size} dim rows, ${months.length} markers`);
log(`  per-day: ${pageDayRows.length} page rows, ${dims.length} dim rows (from ${dayRowFrom} and in months not rolled up yet)`);
log(`  skipped (not before the first live day): ${agg.days.length - days.length} days`);
if (unresolved.size) {
	log(`  unresolved pages (no matching slug here): ${unresolved.size}, ${sum([...unresolved.values()], (v) => v)} views`);
	for (const [k, v] of [...unresolved].sort((a, b) => b[1] - a[1]).slice(0, 10)) log(`    ${v}\t${k}`);
}
const top = Object.entries(entries).sort((a, b) => b[1] - a[1]).slice(0, 5);
log("  top pages:", top.map(([k, v]) => `${k}=${v}`).join(", "));

if (!APPLY) { log("\nDry run: nothing written. Re-run with --apply."); process.exit(0); }

const backupDir = resolve(opt("--backup-dir", dirname(dbPath)));
const backup = join(backupDir, `pre-site-stats-backfill-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
log(`\nBackup written: ${backup} (${(statSync(backup).size / 1e6).toFixed(1)} MB)`);

const ins = db.prepare("insert into _plugin_storage (plugin_id, collection, id, data, created_at, updated_at, revision) values (?, ?, ?, ?, ?, ?, ?)");
const now = new Date().toISOString();
const put = (c, id, data) => ins.run(PLUGIN, c, id, JSON.stringify({ ...data, seed: 1 }), now, now, randomUUID());
const UPSERT = "insert into _plugin_storage (plugin_id, collection, id, data, created_at, updated_at, revision) values (?, 'totals', ?, ?, ?, ?, ?) on conflict (plugin_id, collection, id) do update set updated_at = excluded.updated_at, data = ";
const bumpSite = db.prepare(`${UPSERT}json_set(data, '$.views', coalesce(json_extract(data, '$.views'), 0) + cast(? as integer), '$.uniques', coalesce(json_extract(data, '$.uniques'), 0) + cast(? as integer))`);
const bumpEntry = db.prepare(`${UPSERT}json_set(data, '$.views', coalesce(json_extract(data, '$.views'), 0) + cast(? as integer))`);

db.exec("BEGIN IMMEDIATE");
try {
	for (const d of days) put("days", `d:${d.day}`, { day: d.day, views: d.views, uniques: d.uniques });
	for (const [k, views] of pageDayRows) { const i = k.indexOf("|"); put("pages", `p:${k}`, { day: k.slice(0, i), key: k.slice(i + 1), views }); }
	for (const d of dims) put("dims", `m:${d.day}|${d.kind}|${d.value}`, { day: d.day, kind: d.kind, value: d.value, count: d.count });
	for (const [k, views] of pageMonthly) { const i = k.indexOf("|"); put("pagesm", `pm:${k}`, { month: k.slice(0, i), key: k.slice(i + 1), views }); }
	for (const [k, d] of dimMonthly) put("dimsm", `mm:${k}`, d);
	for (const m of months) put("totals", `rollup:${m}`, { kind: "rollup", month: m });
	bumpSite.run(PLUGIN, "site", JSON.stringify({ kind: "site", views: site.views, uniques: site.uniques }), now, now, randomUUID(), site.views, site.uniques);
	for (const [key, views] of Object.entries(entries)) bumpEntry.run(PLUGIN, `e:${key}`, JSON.stringify({ kind: "page", key, views }), now, now, randomUUID(), views);
	ins.run(PLUGIN, "totals", "backfill", JSON.stringify({ kind: "backfill", at: now, source: agg.generatedAt, backup, cutoff, months, site, entries }), now, now, randomUUID());
	db.exec("COMMIT");
} catch (e) { db.exec("ROLLBACK"); throw e; }

const check = get("select (select count(*) from _plugin_storage where plugin_id = ? and collection = 'days' and json_extract(data, '$.seed') = 1) d, (select json_extract(data, '$.views') from _plugin_storage where plugin_id = ? and collection = 'totals' and id = 'site') v, (select json_extract(data, '$.uniques') from _plugin_storage where plugin_id = ? and collection = 'totals' and id = 'site') u", PLUGIN, PLUGIN, PLUGIN);
log("Applied. Seeded days:", check.d, "| all-time totals now: views", check.v, "visitors", check.u);
log("Quick check:", get("pragma quick_check").quick_check);
