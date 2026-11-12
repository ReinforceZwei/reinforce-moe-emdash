import { test } from "node:test";
import assert from "node:assert/strict";
import { monthEnd, nextMonth, planSegments } from "../../src/plugins/site-stats/lib/month.ts";
import { compactDue, compactMonth, loadDoneMonths, markerId } from "../../src/plugins/site-stats/rollup.ts";
import { loadDim, loadTopPages } from "../../src/plugins/site-stats/read.ts";
import { fakeEnv } from "./fake-storage.ts";

const add = (env: ReturnType<typeof fakeEnv>, day: string, key: string, views: number, dims: Array<[string, string, number]> = []) => {
	env.storage.days.rows.set(`d:${day}`, { day, views });
	env.storage.pages.rows.set(`p:${day}|${key}`, { day, key, views });
	for (const [kind, value, count] of dims) env.storage.dims.rows.set(`m:${day}|${kind}|${value}`, { day, kind, value, count });
};

test("month helpers", () => {
	assert.equal(nextMonth("2026-12"), "2027-01");
	assert.equal(monthEnd("2026-02"), "2026-02-28");
	assert.equal(monthEnd("2028-02"), "2028-02-29");
});

test("planSegments uses months only for whole, finished, marked months", () => {
	const done = new Set(["2026-09", "2026-10"]);
	assert.deepEqual(planSegments("2026-08-20", "2026-11-12", done), [
		{ type: "day", from: "2026-08-20", to: "2026-08-31" },
		{ type: "month", from: "2026-09", to: "2026-10" },
		{ type: "day", from: "2026-11-01", to: "2026-11-12" },
	]);
	// a month that is not marked, or only partly inside the range, is read per day
	assert.deepEqual(planSegments("2026-09-02", "2026-10-31", done), [
		{ type: "day", from: "2026-09-02", to: "2026-09-30" },
		{ type: "month", from: "2026-10", to: "2026-10" },
	]);
	assert.deepEqual(planSegments("2026-09-01", "2026-10-30", done), [
		{ type: "month", from: "2026-09", to: "2026-09" },
		{ type: "day", from: "2026-10-01", to: "2026-10-30" },
	]);
	assert.deepEqual(planSegments("2026-09-01", "2026-09-30", new Set()), [{ type: "day", from: "2026-09-01", to: "2026-09-30" }]);
});

test("compactMonth sums pages and dims and marks the month done last", async () => {
	const env = fakeEnv();
	add(env, "2026-09-03", "home", 4, [["browser", "Chrome", 2]]);
	add(env, "2026-09-20", "home", 6, [["browser", "Chrome", 3], ["browser", "Safari", 1]]);
	add(env, "2026-09-20", "posts:a", 1);
	add(env, "2026-10-01", "home", 99); // other month, untouched
	const res = await compactMonth(env, "2026-09");
	assert.deepEqual(res, { pages: 2, dims: 2 });
	assert.deepEqual(env.storage.pagesm.rows.get("pm:2026-09|home"), { month: "2026-09", key: "home", views: 10 });
	assert.deepEqual(env.storage.dimsm.rows.get("mm:2026-09|browser|Chrome"), { month: "2026-09", kind: "browser", value: "Chrome", count: 5 });
	assert.equal(env.storage.pagesm.rows.has("pm:2026-10|home"), false);
	assert.deepEqual([...(await loadDoneMonths(env))], ["2026-09"]);
	// running it again changes nothing
	await compactMonth(env, "2026-09");
	assert.equal(env.storage.pagesm.rows.size, 2);
});

test("reads match the per-day sums, and ignore rollup rows of an unmarked month", async () => {
	const env = fakeEnv();
	for (const [day, views] of [["2026-08-25", 1], ["2026-09-10", 2], ["2026-09-11", 3], ["2026-10-05", 4], ["2026-11-02", 5]] as const) {
		add(env, day, "home", views, [["os", "Windows", views]]);
	}
	const range = ["2026-08-20", "2026-11-12"] as const;
	const before = await loadTopPages(env, ...range, 5);
	const beforeDim = await loadDim(env, "os", ...range, 5);

	// poisoned rollup rows without a marker must be ignored
	env.storage.pagesm.rows.set("pm:2026-09|home", { month: "2026-09", key: "home", views: 1000 });
	assert.deepEqual(await loadTopPages(env, ...range, 5), before);

	env.storage.pagesm.rows.clear();
	await compactMonth(env, "2026-09");
	await compactMonth(env, "2026-10");
	// remove the per-day rows of the rolled months: the answer must come from the rollup
	for (const id of [...env.storage.pages.rows.keys()]) if (/^p:2026-(09|10)/.test(id)) env.storage.pages.rows.delete(id);
	for (const id of [...env.storage.dims.rows.keys()]) if (/^m:2026-(09|10)/.test(id)) env.storage.dims.rows.delete(id);
	assert.deepEqual(await loadTopPages(env, ...range, 5), before);
	assert.deepEqual(await loadDim(env, "os", ...range, 5), beforeDim);
	// a range that cuts a rolled month in half still reads the per-day rows (gone here, so it is short)
	const cut = await loadTopPages(env, "2026-09-11", "2026-09-30", 5);
	assert.equal(cut.rows.length, 0);
});

test("compactDue rolls up finished months only, in order, a few per run", async () => {
	const env = fakeEnv();
	for (const day of ["2026-05-02", "2026-06-02", "2026-07-02", "2026-08-02", "2026-10-31", "2026-11-12"]) add(env, day, "home", 1);
	// 2026-10 is over, but the grace day has not passed yet
	const first = await compactDue(env, "2026-11-01");
	assert.deepEqual(first, ["2026-05", "2026-06", "2026-07"]);
	assert.equal(await env.kv.get("state:lastCompact"), null, "still behind, so no daily gate");
	const second = await compactDue(env, "2026-11-01");
	assert.deepEqual(second, ["2026-08"], "September had no data; October is inside the grace day");
	assert.equal(await env.kv.get("state:lastCompact"), "2026-11-01");
	assert.deepEqual(await compactDue(env, "2026-11-01"), [], "gated for the rest of the day");
	assert.deepEqual(await compactDue(env, "2026-11-02"), ["2026-10"]);
	assert.deepEqual([...(await loadDoneMonths(env))].sort(), ["2026-05", "2026-06", "2026-07", "2026-08", "2026-10"]);
	assert.equal(env.storage.totals.rows.has(markerId("2026-09")), false);
});

test("an already-marked month (e.g. imported straight into the rollup) is left alone", async () => {
	const env = fakeEnv();
	add(env, "2026-09-02", "home", 1);
	env.storage.totals.rows.set(markerId("2026-09"), { kind: "rollup", month: "2026-09" });
	env.storage.pagesm.rows.set("pm:2026-09|home", { month: "2026-09", key: "home", views: 500 });
	assert.deepEqual(await compactDue(env, "2026-10-05"), []);
	assert.equal(env.storage.pagesm.rows.get("pm:2026-09|home")!.views, 500);
});
