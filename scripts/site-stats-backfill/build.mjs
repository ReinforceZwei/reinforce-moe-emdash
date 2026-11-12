#!/usr/bin/env node
/**
 * Turn a WP Statistics database (see load-wp-dump.py) into a small aggregate JSON for
 * `scripts/backfill-site-stats.mjs`. Runs on a dev machine, not in the container: it reuses the
 * plugin's own UA, referrer and bot code so imported days are classified exactly like live ones.
 *
 * Only aggregates leave this step: no visitor hashes, no URLs with query strings.
 *
 * Usage: node scripts/site-stats-backfill/build.mjs <wp.db> <out.json> [--site-hosts a,b]
 */
import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { isBotUa } from "../../src/plugins/site-stats/lib/bots.ts";
import { parseUa } from "../../src/plugins/site-stats/lib/ua.ts";
import { classifyReferrer } from "../../src/plugins/site-stats/lib/referrer.ts";

const args = process.argv.slice(2);
const [dbPath, outPath] = args.filter((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--site-hosts");
if (!dbPath || !outPath) throw new Error("usage: build.mjs <wp.db> <out.json> [--site-hosts a,b]");
const hostsIdx = args.indexOf("--site-hosts");
const siteHosts = (hostsIdx >= 0 ? args[hostsIdx + 1] : "reinforce.moe,www.reinforce.moe,wp-migrate.reinforce.moe").split(",");
const PLUGIN_TZ = "Asia/Hong_Kong";

const db = new DatabaseSync(dbPath, { readOnly: true });
const all = (sql, ...p) => db.prepare(sql).all(...p);
const opt = (name) => all("select option_value v from wp_options where option_name=?", name)[0]?.v ?? "";
const dec = (s) => { try { return decodeURIComponent(s).normalize("NFC"); } catch { return s.normalize("NFC"); } };

// WP stores `last_counter` days in the site's local time, so the day keys only line up when
// both zones have the same UTC offset all year (Taipei and Hong Kong are both +08, no DST).
const wpTz = opt("timezone_string") || `UTC${opt("gmt_offset")}`;
const offsets = (tz) => [0, 3, 6, 9].map((m) => new Intl.DateTimeFormat("en", { timeZone: tz, timeZoneName: "longOffset" }).format(new Date(Date.UTC(2025, m, 15))));
if (JSON.stringify(offsets(wpTz)) !== JSON.stringify(offsets(PLUGIN_TZ))) throw new Error(`WP timezone ${wpTz} differs from ${PLUGIN_TZ}: day keys would shift`);

const stats = { visitorsTotal: 0, visitorsKept: 0, dropped: { bot: 0, scanner: 0, unidentifiable: 0 }, pages: { kept: 0, scanner: 0, unmappedType: 0, unmappedId: 0 } };
const days = new Map(); // day -> {views, uniques}
const dims = new Map(); // `${day}|${kind}|${value}` -> count
const bump = (m, k, n = 1) => m.set(k, (m.get(k) ?? 0) + n);

// WP's vocabulary -> the plugin's, for the early rows that never stored a UA string.
const OS = { "OS X": "macOS" };
const DEVICE = { desktop: "desktop", "mobile:smart": "mobile", tablet: "tablet" };
const BROWSER = { Edge: "Microsoft Edge" };

const words = new Map();
for (const r of all("select visitor, words from wp_statistics_search where words is not null and words != ''")) words.set(r.visitor, r.words);

for (const v of all("select ID, last_counter day, referred, agent, platform, device, UAString ua, hits from wp_statistics_visitor")) {
	stats.visitorsTotal++;
	if (/script|%3c|</i.test(v.referred ?? "")) { stats.dropped.scanner++; continue; }
	let info;
	if (v.ua) {
		if (isBotUa(v.ua) || v.device === "bot") { stats.dropped.bot++; continue; }
		info = parseUa(v.ua);
		if (info.browser === "Other" && info.os === "Other") { stats.dropped.unidentifiable++; continue; }
	} else {
		if (v.device === "bot" || !v.agent || /^(Unknown|未知)$/.test(v.agent) || /^(Unknown|未知)$/.test(v.platform)) { stats.dropped.unidentifiable++; continue; }
		info = { browser: BROWSER[v.agent] ?? v.agent, os: OS[v.platform] ?? v.platform, device: DEVICE[v.device] ?? "other" };
	}
	stats.visitorsKept++;
	const d = days.get(v.day) ?? { views: 0, uniques: 0 };
	d.views += v.hits || 1;
	d.uniques += 1;
	days.set(v.day, d);

	// WP records the site's own address as the referrer of a direct visit; a first hit of the day
	// that "came from" the site is a direct visit.
	const ref = classifyReferrer(v.referred ?? "", siteHosts);
	const channel = ref.channel === "internal" ? "direct" : ref.channel;
	const dim = (kind, value) => value && bump(dims, `${v.day}|${kind}|${value}`);
	dim("channel", channel);
	dim("ref", channel === "referral" && ref.host ? ref.host.slice(0, 80) : undefined);
	dim("engine", ref.engine);
	// WP also files on-site search URLs here; only real queries are worth a row.
	const word = words.get(v.ID) ?? ref.words;
	dim("word", word && !/^https?:|reinforce\.moe/i.test(word) ? word.normalize("NFC").trim().slice(0, 80) : undefined);
	dim("browser", info.browser);
	dim("os", info.os);
	dim("device", info.device);
}

// Pages: WP post ids -> decoded slugs (the EmDash slugs); the apply step turns slugs into ids.
const slugById = new Map(all("select ID, post_name, post_type from wp_posts where post_type in ('post','page')").map((r) => [r.ID, { slug: dec(r.post_name), type: r.post_type }]));
const termById = new Map(all("select t.term_id id, t.slug, x.taxonomy from wp_terms t join wp_term_taxonomy x using(term_id)").map((r) => [r.id, { slug: dec(r.slug), taxonomy: r.taxonomy }]));
const pages = new Map(); // `${day}|${kind}|${collection or taxonomy}|${slug}` -> views
for (const p of all("select uri, type, date day, count, id from wp_statistics_pages")) {
	if (/script|%3c|</i.test(p.uri)) { stats.pages.scanner += p.count; continue; }
	let ref;
	if (p.type === "home") ref = p.uri.split("?")[0] === "/" ? { kind: "home" } : null;
	else if (p.type === "post" || p.type === "page") {
		const e = slugById.get(p.id);
		ref = e && e.type === p.type ? { kind: "content", collection: p.type === "post" ? "posts" : "pages", slug: e.slug } : (stats.pages.unmappedId += p.count, null);
		if (!ref) continue;
	} else if (p.type === "category" || p.type === "post_tag") {
		const t = termById.get(p.id);
		ref = t ? { kind: "term", taxonomy: p.type === "category" ? "category" : "tag", slug: t.slug } : (stats.pages.unmappedId += p.count, null);
		if (!ref) continue;
	} else ref = null;
	if (!ref) { stats.pages.unmappedType += p.count; continue; }
	stats.pages.kept += p.count;
	bump(pages, [p.day, ref.kind, ref.collection ?? ref.taxonomy ?? "", ref.slug ?? ""].join("|"), p.count);
}

const sorted = (m) => [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
const out = {
	version: 1,
	generatedAt: new Date().toISOString(),
	source: { wpTimezone: wpTz, pluginTimezone: PLUGIN_TZ, siteHosts },
	stats,
	days: sorted(days).map(([day, d]) => ({ day, ...d })),
	pages: sorted(pages).map(([k, views]) => { const [day, kind, group, slug] = k.split("|"); return { day, kind, group, slug, views }; }),
	dims: sorted(dims).map(([k, count]) => { const [day, kind, ...rest] = k.split("|"); return { day, kind, value: rest.join("|"), count }; }),
};
writeFileSync(outPath, JSON.stringify(out));
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
console.log(JSON.stringify({ stats, days: out.days.length, range: [out.days[0]?.day, out.days.at(-1)?.day], views: sum(out.days, (d) => d.views), uniques: sum(out.days, (d) => d.uniques), pageRows: out.pages.length, pageViews: sum(out.pages, (p) => p.views), dimRows: out.dims.length }, null, 1));
