import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { handleTrack, resetSaltCache } from "../../src/plugins/site-stats/track.ts";
import { resetSettingsCache } from "../../src/plugins/site-stats/lib/settings.ts";
import { pruneSeen } from "../../src/plugins/site-stats/counters.ts";
import { fakeEnv } from "./fake-storage.ts";

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const KEY = "posts:01M5Y039AP0GMRVE5NKPPN3K23";
const NOW = () => new Date("2026-11-12T03:00:00Z"); // 11:00 on 2026-11-12 in Hong Kong
const req = new Request("https://reinforce.moe/_emdash/api/plugins/site-stats/track", { method: "POST" });
const hit = (input: unknown, over: Record<string, unknown> = {}) => ({ input, request: req, ip: "203.0.113.9", userAgent: CHROME, ...over });
const deps = { now: NOW, signedIn: async () => false };

beforeEach(() => {
	resetSettingsCache();
	resetSaltCache();
});

test("first hit creates every counter with the creating increment", async () => {
	const env = fakeEnv();
	const out = await handleTrack(env, hit({ k: KEY, p: "/blog/x", r: "https://www.google.com/search?q=emdash" }), deps);
	assert.deepEqual(out, { ok: true, unique: true });
	const s = env.storage;
	assert.deepEqual(s.days.rows.get("d:2026-11-12"), { day: "2026-11-12", views: 1, uniques: 1 });
	assert.deepEqual(s.pages.rows.get(`p:2026-11-12|${KEY}`), { day: "2026-11-12", key: KEY, views: 1 });
	assert.deepEqual(s.totals.rows.get("site"), { kind: "site", views: 1, uniques: 1 });
	assert.deepEqual(s.totals.rows.get(`e:${KEY}`), { kind: "page", key: KEY, views: 1 });
	const dims = [...s.dims.rows.values()].map((d) => `${d.kind}=${d.value}`).sort();
	assert.deepEqual(dims, ["browser=Chrome", "channel=search", "device=desktop", "engine=Google", "os=Windows", "word=emdash"]);
});

test("a repeat view by the same visitor adds a view, not a visitor or dimensions", async () => {
	const env = fakeEnv();
	await handleTrack(env, hit({ k: KEY, p: "/blog/x", r: "" }), deps);
	const dimsAfterFirst = env.storage.dims.rows.size;
	const out = await handleTrack(env, hit({ k: "home", p: "/", r: "https://reinforce.moe/blog/x" }), deps);
	assert.deepEqual(out, { ok: true, unique: false });
	assert.deepEqual(env.storage.days.rows.get("d:2026-11-12"), { day: "2026-11-12", views: 2, uniques: 1 });
	assert.equal(env.storage.totals.rows.get("site")!.views, 2);
	assert.equal(env.storage.totals.rows.get("site")!.uniques, 1);
	assert.equal(env.storage.dims.rows.size, dimsAfterFirst);
	assert.equal(env.storage.pages.rows.size, 2);
});

test("a different visitor is unique and bumps shared dimension counts", async () => {
	const env = fakeEnv();
	await handleTrack(env, hit({ k: KEY, p: "/", r: "" }), deps);
	await handleTrack(env, hit({ k: KEY, p: "/", r: "" }, { ip: "198.51.100.7" }), deps);
	assert.equal(env.storage.days.rows.get("d:2026-11-12")!.uniques, 2);
	assert.equal(env.storage.dims.rows.get("m:2026-11-12|channel|direct")!.count, 2);
});

test("bots, missing ip, invalid body, unresolved key, excluded path and signed-in users write nothing", async () => {
	const env = fakeEnv();
	const cases: Array<[string, any]> = [
		["bot", hit({ k: KEY, p: "/", r: "" }, { userAgent: "Googlebot/2.1 (+http://www.google.com/bot.html)" })],
		["no-ip", hit({ k: KEY, p: "/", r: "" }, { ip: null })],
		["invalid", hit("nope")],
		["unresolved", hit({ k: null, p: "/x", r: "" })],
		["unresolved", hit({ k: "../etc", p: "/x", r: "" })],
		["excluded", hit({ k: KEY, p: "/search", r: "" })],
	];
	for (const [why, input] of cases) assert.equal((await handleTrack(env, input, deps)).skipped, why);
	const signedIn = await handleTrack(env, hit({ k: KEY, p: "/", r: "" }), { ...deps, signedIn: async () => true });
	assert.equal(signedIn.skipped, "signed-in");
	for (const coll of Object.values(env.storage)) assert.equal(coll.rows.size, 0);
});

test("excludeLoggedIn=false counts signed-in users", async () => {
	const env = fakeEnv({ excludeLoggedIn: false });
	const out = await handleTrack(env, hit({ k: KEY, p: "/", r: "" }), { ...deps, signedIn: async () => true });
	assert.equal(out.unique, true);
});

test("the day follows the timezone setting", async () => {
	const env = fakeEnv({ timezone: "UTC" });
	await handleTrack(env, hit({ k: KEY, p: "/", r: "" }), { ...deps, now: () => new Date("2026-11-11T20:00:00Z") });
	assert.ok(env.storage.days.rows.has("d:2026-11-11"));
});

test("pruneSeen deletes only previous days and runs once per day", async () => {
	const env = fakeEnv();
	await env.storage.seen.compareAndSet("v:old", null, { day: "2026-11-10" });
	await env.storage.seen.compareAndSet("v:today", null, { day: "2026-11-12" });
	assert.equal(await pruneSeen(env, "2026-11-12"), 1);
	assert.deepEqual([...env.storage.seen.rows.keys()], ["v:today"]);
	await env.storage.seen.compareAndSet("v:old2", null, { day: "2026-11-10" });
	assert.equal(await pruneSeen(env, "2026-11-12"), 0, "already pruned for this day");
});
