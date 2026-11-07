#!/usr/bin/env node
/**
 * End-to-end check for the visitors plugin.
 *
 * Three layers, because each one catches a different class of failure:
 *
 *   1. Block Kit — the builders are bundled with esbuild and every response the
 *      admin can receive is run through `validateBlocks()`. EmDash does not
 *      validate a *native* plugin's block response, so this is the only guard
 *      against a malformed block blanking the admin page.
 *   2. Path classification — the site's real routes must all classify, so a new
 *      route cannot silently stop counting.
 *   3. HTTP + SQLite — a running dev server is asked to track hits and the rows
 *      it wrote are read back from `_plugin_storage`.
 *
 * Usage:
 *   EMDASH_DB_PATH=./.verify/emdash.db npm run dev     # in one shell
 *   npm run verify:visitors                            # in another
 *
 * The HTTP phase writes real rows (with a random test IP) into the configured
 * database, so point the dev server at a scratch copy of the database — never
 * at production.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const BASE_URL = (process.env.VERIFY_BASE_URL ?? "http://localhost:4321").replace(/\/$/, "");
const DB_PATH = process.env.EMDASH_DB_PATH ?? path.resolve("data.db");
const SKIP_HTTP = process.env.VERIFY_SKIP_HTTP === "1";

/** Unique per run so repeated runs never dedupe against each other. */
const RUN = Math.random().toString(36).slice(2, 8);
const TEST_IP = `10.${Math.floor(Math.random() * 200) + 20}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const TEST_UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) visitors-verify/${RUN}`;

let failures = 0;
let checks = 0;

function ok(name, detail = "") {
	checks += 1;
	console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name, detail) {
	checks += 1;
	failures += 1;
	console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

function assert(name, condition, detail = "") {
	if (condition) ok(name, detail);
	else fail(name, detail);
}

// --- 1. Block Kit ------------------------------------------------------------

const scratch = mkdtempSync(path.join(tmpdir(), "visitors-verify-"));

async function bundle(entry, name) {
	const outfile = path.join(scratch, `${name}.mjs`);
	// Rolldown, not esbuild: Astro 7's bundler is what ships in node_modules, and
	// it compiles TypeScript without a config file.
	execFileSync(
		path.resolve("node_modules/.bin/rolldown"),
		[entry, "--file", outfile, "--format", "esm", "--platform", "node"],
		{ stdio: ["ignore", "ignore", "inherit"] },
	);
	return import(`file://${outfile}`);
}

function fixtureSummary() {
	const today = new Date();
	const series = Array.from({ length: 30 }, (_, index) => {
		const day = new Date(today.getTime() - (29 - index) * 86_400_000).toISOString().slice(0, 10);
		return { day, views: 40 + (index % 7) * 3, uniques: 30 + (index % 5), sessions: 20 + (index % 4) };
	});
	return {
		period: 30,
		series,
		window: { views: 1234, uniques: 900, sessions: 500 },
		previous: { views: 1000, uniques: 800, sessions: 450 },
		today: series[series.length - 1],
		allTime: { views: 125_367, uniques: 74_699, sessions: 145_196, since: Date.now() - 3 * 365 * 86_400_000 },
		entries: [
			{ entryKey: "posts:01ABC", title: "A post title", path: "/blog/a-post", visitors: 120, views: 900, share: 0.4 },
			{ entryKey: "posts:01DEF", title: "另一個標題", path: "/blog/another", visitors: 80, views: 400, share: 0.26 },
		],
		sources: [
			{ value: "google.com", label: "google.com", visitors: 300, views: 4000, share: 0.24 },
			{ value: "direct", label: "Direct", visitors: 500, views: 9000, share: 0.4 },
		],
		sourceTypes: [
			{ value: "search", views: 4000 },
			{ value: "direct", views: 9000 },
		],
		devices: [
			{ value: "mobile", label: "mobile", visitors: 600, views: 9000, share: 0.48 },
			{ value: "desktop", label: "desktop", visitors: 500, views: 7000, share: 0.4 },
		],
		kinds: [
			{ value: "entry", label: "entry", visitors: 700, views: 9000, share: 0.56 },
			{ value: "tag", label: "tag", visitors: 300, views: 6000, share: 0.24 },
		],
	};
}

async function checkBlocks() {
	console.log("\nBlock Kit");
	const blocks = await bundle("src/plugins/visitors/admin/blocks.ts", "blocks");
	const server = await import("@emdash-cms/blocks/server");

	const cases = [
		["overview", blocks.overviewBlocks(fixtureSummary())],
		["overview (sorted)", blocks.overviewBlocks(fixtureSummary(), { table: "entries", key: "views", dir: "asc" })],
		[
			"overview (empty state)",
			blocks.overviewBlocks({ ...fixtureSummary(), allTime: { views: 0, uniques: 0, sessions: 0, since: null } }),
		],
		["widget", blocks.widgetBlocks(fixtureSummary())],
		[
			"widget (empty state)",
			blocks.widgetBlocks({ ...fixtureSummary(), allTime: { views: 0, uniques: 0, sessions: 0, since: null } }),
		],
		[
			"entry panel",
			blocks.entryPanelBlocks({ title: "A post", path: "/blog/a-post", today: 3, week: 20, month: 90, allTime: 400 }),
		],
		["error banner", blocks.errorBlocks("storage unavailable")],
	];

	const policy = { pluginPagePaths: ["/visitors"] };
	for (const [name, value] of cases) {
		const result = server.validateBlocks(value, policy);
		assert(`validateBlocks: ${name}`, result.valid, result.valid ? `${value.length} blocks` : JSON.stringify(result.errors));
	}

	// Negative control: proves the validator is actually running rather than
	// accepting everything.
	const broken = server.validateBlocks([{ type: "not_a_block" }]);
	assert("validateBlocks rejects a bogus block", broken.valid === false);

	const bytes = Buffer.byteLength(JSON.stringify(cases[0][1]));
	assert("overview response is inside the 256 KiB budget", bytes < server.BLOCK_RESPONSE_LIMITS.maxBytes, `${bytes} bytes`);
}

// --- 2. Path classification --------------------------------------------------

async function checkClassification() {
	console.log("\nPath classification");
	const lib = await bundle("src/plugins/visitors/lib.ts", "lib");

	const table = [
		["/", "home"],
		["/blog", "listing"],
		["/blog/some-post", "entry"],
		["/blog/%E6%97%A5%E6%9C%AC", "entry"],
		["/about", "page"],
		["/tag/taiwan", "listing"],
		["/category/notes", "listing"],
		["/author/reinforce", "listing"],
		["/search", "listing"],
		["/2024/01/02/old-post", "listing"],
		["/blog/a/b", "unresolved"],
		["/tag/a/b", "unresolved"],
	];

	for (const [input, expected] of table) {
		const normalised = lib.normalisePath(input);
		const info = lib.classifyPath(normalised);
		assert(`classify ${input}`, info.kind === expected, `${normalised} → ${info.kind}`);
	}

	assert("listing types are distinguished", lib.classifyPath("/tag/taiwan").listingType === "tag");
	assert("post slug is decoded", lib.normalisePath("/blog/%E6%97%A5%E6%9C%AC") === "/blog/日本");
	assert("trailing slash folds", lib.normalisePath("/about/") === "/about");
	assert("query string is dropped", lib.normalisePath("/blog/x?utm_source=y") === "/blog/x");

	const referrer = lib.classifyReferrer("https://www.google.com/search?q=x", "reinforce.moe");
	assert("google is search", referrer.sourceType === "search" && referrer.source === "google.com", JSON.stringify(referrer));
	assert("same host is direct", lib.classifyReferrer("https://reinforce.moe/blog/x", "reinforce.moe").sourceType === "direct");
	assert("empty is direct", lib.classifyReferrer("", "reinforce.moe").sourceType === "direct");
	assert("tablet before mobile", lib.classifyDevice("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)") === "tablet");
	assert("iphone is mobile", lib.classifyDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)") === "mobile");
	assert("Googlebot is a bot", lib.isBot("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"));
	assert("a browser is not a bot", !lib.isBot("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36"));
}

// --- 3. HTTP -----------------------------------------------------------------

async function post(body, headers = {}) {
	const response = await fetch(`${BASE_URL}/_emdash/api/plugins/visitors/track`, {
		method: "POST",
		headers: { "content-type": "text/plain", "user-agent": TEST_UA, "x-forwarded-for": TEST_IP, ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
	const text = await response.text();
	let json = null;
	try {
		// The host wraps a route's return value as `{ success, data }`.
		const parsed = JSON.parse(text);
		json = parsed?.data ?? parsed;
	} catch {
		// A non-JSON body (an HTML error page) is reported through `text`.
	}
	return { status: response.status, json, text };
}

async function firstPostPath() {
	const response = await fetch(`${BASE_URL}/blog`);
	const html = await response.text();
	const match = /href="(\/blog\/[^"#?]+)"/.exec(html);
	return match?.[1] ?? null;
}

async function checkHttp() {
	console.log("\nHTTP");
	let reachable = false;
	try {
		const response = await fetch(`${BASE_URL}/`, { redirect: "manual" });
		reachable = response.ok;
	} catch {
		reachable = false;
	}

	if (!reachable) {
		if (SKIP_HTTP) {
			console.log(`  skip  server not reachable at ${BASE_URL} (VERIFY_SKIP_HTTP=1)`);
			return null;
		}
		fail("dev server reachable", `nothing answering at ${BASE_URL}; start \`npm run dev\` or set VERIFY_SKIP_HTTP=1`);
		return null;
	}

	const home = await (await fetch(`${BASE_URL}/`)).text();
	assert("beacon is injected on the home page", home.includes("/_emdash/api/plugins/visitors/track"));
	assert("beacon is guarded against double injection", home.includes("__visitorsSent"));

	const postPath = await firstPostPath();
	if (!postPath) {
		fail("a published post exists", "no /blog/<slug> link found on /blog");
		return {};
	}
	ok("found a published post", postPath);

	const postHtml = await (await fetch(`${BASE_URL}${postPath}`)).text();
	assert(
		"post page bakes its entry key into the beacon",
		/("k":\s*|k: )"posts:[A-Za-z0-9]+"/.test(postHtml),
		"entry key present",
	);

	const admin = await fetch(`${BASE_URL}/_emdash/api/plugins/visitors/admin`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ type: "page_load", page: "/visitors" }),
	});
	assert("admin route is private", admin.status === 401 || admin.status === 403, `status ${admin.status}`);

	const first = await post({ p: postPath, r: "https://www.google.com/", sid: `verify${RUN}a` });
	assert("first hit counts as a visitor", first.json?.ok === true && first.json?.unique === true, JSON.stringify(first.json));

	const again = await post({ p: postPath, r: "https://www.google.com/", sid: `verify${RUN}a` });
	assert(
		"repeat hit counts a view but not a visitor",
		again.json?.ok === true && again.json?.unique === false,
		JSON.stringify(again.json),
	);

	const listingHtml = await (await fetch(`${BASE_URL}/blog`)).text();
	const linkPattern = /href="(\/blog\/[^"#?]+)"/g;
	const paths = new Set();
	for (let match = linkPattern.exec(listingHtml); match; match = linkPattern.exec(listingHtml)) {
		paths.add(match[1]);
	}
	const differentPost = [...paths].find((candidate) => candidate !== postPath) ?? "/tag/verify-listing";

	const second = await post({ p: differentPost, r: "", sid: `verify${RUN}a` });
	assert(
		"a second page in the same visit counts without opening a visit",
		second.json?.ok === true && second.json?.unique === true && second.json?.session === false,
		JSON.stringify(second.json),
	);

	// A new tab on a page not yet seen today: counts, and opens a second visit.
	const newTab = await post({ p: "/", r: "", sid: `verify${RUN}b` });
	assert(
		"a new tab opens a new visit",
		newTab.json?.ok === true && newTab.json?.unique === true && newTab.json?.session === true,
		JSON.stringify(newTab.json),
	);

	const bot = await post({ p: postPath, r: "" }, { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" });
	assert("bot user agent is skipped", bot.json?.skipped === "bot", JSON.stringify(bot.json));

	const missing = await post({ p: "/blog/does-not-exist-verify", r: "" });
	assert("unknown post is not counted", missing.json?.skipped === "unresolved", JSON.stringify(missing.json));

	const listing = await post({ p: "/search?q=test", r: "" });
	assert("listing path counts", listing.json?.ok === true && listing.json?.unique === true, JSON.stringify(listing.json));

	const garbage = await post("not json at all");
	assert("garbage body is ignored, not thrown", garbage.json?.ok === true && garbage.json?.skipped === "body", JSON.stringify(garbage.json));

	return { postPath, differentPost };
}

// --- 4. SQLite ---------------------------------------------------------------

async function checkStorage(context) {
	console.log("\nStorage");
	if (!context?.postPath) {
		console.log("  skip  no HTTP context to verify against");
		return;
	}
	if (!existsSync(DB_PATH)) {
		fail("database file exists", DB_PATH);
		return;
	}

	const { createClient } = await import("@libsql/client");
	const client = createClient({ url: `file:${DB_PATH}` });
	const query = async (sql, args = []) => (await client.execute({ sql, args })).rows;

	try {
		const visits = await query(
			`select id, data from _plugin_storage where plugin_id = 'visitors' and collection = 'visits' and json_extract(data, '$.ip') = ?`,
			[TEST_IP],
		);
		assert("visits rows were written", visits.length >= 3, `${visits.length} rows`);

		const paths = visits.map((row) => JSON.parse(row.data).path);
		assert("one row per page (not per hit)", new Set(paths).size === paths.length, paths.join(", "));
		assert("row carries the raw IP", visits.every((row) => JSON.parse(row.data).ip === TEST_IP));
		assert(
			"row derives its source from document.referrer",
			visits.some((row) => JSON.parse(row.data).source === "google.com" && JSON.parse(row.data).sourceType === "search"),
		);
		assert(
			"entry rows carry an entry key",
			visits.some((row) => typeof JSON.parse(row.data).entryKey === "string" && JSON.parse(row.data).entryKey.startsWith("posts:")),
		);
		assert(
			"listing rows carry a listing type",
			visits.some((row) => JSON.parse(row.data).listingType !== null),
		);

		const today = JSON.parse(visits[0].data).day;
		const days = await query(
			`select data from _plugin_storage where plugin_id = 'visitors' and collection = 'days' and id = ?`,
			[`day:${today}`],
		);
		assert("day rollup exists", days.length === 1);
		const rollup = days.length === 1 ? JSON.parse(days[0].data) : null;
		if (rollup) {
			assert("day rollup counts views", rollup.views >= visits.length, JSON.stringify(rollup));
			assert("day rollup counts uniques", rollup.uniques >= 1, `uniques ${rollup.uniques}`);
			assert("day rollup counts visits", rollup.sessions >= 1, `sessions ${rollup.sessions}`);
			assert(
				"a repeat view raises views above visitors",
				rollup.views > rollup.uniques,
				`views ${rollup.views} / uniques ${rollup.uniques}`,
			);
		}

		const site = await query(
			`select data from _plugin_storage where plugin_id = 'visitors' and collection = 'totals' and id = 'site'`,
		);
		assert("site totals exist", site.length === 1);
		if (site.length === 1) {
			const totals = JSON.parse(site[0].data);
			assert("site totals are ahead of the raw log", totals.views >= visits.length, JSON.stringify(totals));

			// Site totals are the sum of every day rollup. This is what catches a
			// create path that drops its own increment, which is otherwise invisible
			// on a single day (the row that created the counter would read 0).
			const allDays = await query(
				`select data from _plugin_storage where plugin_id = 'visitors' and collection = 'days'`,
			);
			const summed = allDays.reduce(
				(acc, row) => {
					const day = JSON.parse(row.data);
					acc.views += day.views;
					acc.uniques += day.uniques;
					return acc;
				},
				{ views: 0, uniques: 0 },
			);
			assert(
				"site views equal the sum of the day rollups",
				totals.views === summed.views,
				`site ${totals.views} / days ${summed.views}`,
			);
			assert(
				"site visitors equal the sum of the day rollups",
				totals.uniques === summed.uniques,
				`site ${totals.uniques} / days ${summed.uniques}`,
			);
		}

		const dims = await query(
			`select data from _plugin_storage where plugin_id = 'visitors' and collection = 'dims'`,
		);
		assert("dimension counters exist", dims.length >= 4, `${dims.length} rows`);

		const sessions = await query(
			`select data from _plugin_storage where plugin_id = 'visitors' and collection = 'sessions'`,
		);
		assert("two tabs produced two sessions", sessions.length >= 2, `${sessions.length} rows`);

		const salt = await query(
			`select data from _plugin_storage where plugin_id = 'visitors' and collection = 'kv' and id = 'state:salt'`,
		);
		void salt; // kv layout is internal; presence is covered by the hashes working.

		assert("visits are keyed by a 32-char hash", /^[0-9a-f]{32}$/.test(visits[0].id), visits[0].id);
	} finally {
		client.close();
	}
}

// --- main --------------------------------------------------------------------

console.log(`visitors verify — ${BASE_URL} (db ${DB_PATH}, ip ${TEST_IP})`);
try {
	await checkBlocks();
	await checkClassification();
	const context = await checkHttp();
	await checkStorage(context);
} catch (error) {
	fail("unexpected error", error instanceof Error ? error.stack : String(error));
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
