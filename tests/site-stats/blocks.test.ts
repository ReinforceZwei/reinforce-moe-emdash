import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBlocks } from "@emdash-cms/blocks/server";
import { chartBlock, emptyBlock, errorBanner, rangePicker, statsBlock, tableBlock, truncatedNote } from "../../src/plugins/site-stats/blocks.ts";
import { boundsFor, labelFor, loadDays, loadDim, loadTopPages, queryAll } from "../../src/plugins/site-stats/read.ts";
import { addDays } from "../../src/plugins/site-stats/lib/day.ts";
import { fakeEnv } from "./fake-storage.ts";

const check = (blocks: any[]) => {
	const r = validateBlocks(blocks);
	assert.equal(r.valid, true, JSON.stringify((r as any).errors));
};

test("every block the plugin emits passes validateBlocks", () => {
	const points = [{ day: "2026-11-11", views: 3, uniques: 2 }, { day: "2026-11-12", views: 5, uniques: 4 }];
	check([
		rangePicker("30d"),
		statsBlock({ points, views: 8, uniques: 6, prevViews: 4, prevUniques: 0, todayViews: 5 }),
		chartBlock(points),
		tableBlock("/overview", "Page", [{ name: "Home", count: 5 }]),
		...truncatedNote(true),
		emptyBlock("No data", "Nothing yet"),
		errorBanner("boom"),
	]);
});

test("boundsFor spans the range ending today and the previous period before it", () => {
	const b = boundsFor("7d", new Date("2026-11-12T03:00:00Z"), "Asia/Hong_Kong");
	assert.deepEqual(b, { from: "2026-11-06", to: "2026-11-12", prevFrom: "2026-10-30", prevTo: "2026-11-05", days: 7 });
});

test("loadDays zero-fills, loadTopPages and loadDim sum across days", async () => {
	const env = fakeEnv();
	const { days, pages, dims } = env.storage;
	days.rows.set("d:2026-11-10", { day: "2026-11-10", views: 4, uniques: 3 });
	days.rows.set("d:2026-11-12", { day: "2026-11-12", views: 6 });
	pages.rows.set("p:2026-11-10|home", { day: "2026-11-10", key: "home", views: 1 });
	pages.rows.set("p:2026-11-12|home", { day: "2026-11-12", key: "home", views: 2 });
	pages.rows.set("p:2026-11-12|blog", { day: "2026-11-12", key: "blog", views: 2 });
	pages.rows.set("p:2026-11-01|blog", { day: "2026-11-01", key: "blog", views: 99 });
	dims.rows.set("m:2026-11-10|browser|Chrome", { day: "2026-11-10", kind: "browser", value: "Chrome", count: 2 });
	dims.rows.set("m:2026-11-12|browser|Chrome", { day: "2026-11-12", kind: "browser", value: "Chrome", count: 1 });
	dims.rows.set("m:2026-11-12|os|Windows", { day: "2026-11-12", kind: "os", value: "Windows", count: 9 });

	const d = await loadDays(env, "2026-11-10", "2026-11-12");
	assert.deepEqual(d.points, [
		{ day: "2026-11-10", views: 4, uniques: 3 },
		{ day: "2026-11-11", views: 0, uniques: 0 },
		{ day: "2026-11-12", views: 6, uniques: 0 },
	]);
	assert.deepEqual((await loadTopPages(env, "2026-11-10", "2026-11-12", 10)).rows, [{ key: "home", views: 3 }, { key: "blog", views: 2 }]);
	const b = await loadDim(env, "browser", "2026-11-10", "2026-11-12", 10);
	assert.deepEqual(b.rows, [{ value: "Chrome", count: 3 }]);
	assert.equal(b.total, 3);
});

test("queryAll pages past 100 rows and flags truncation at the cap", async () => {
	const env = fakeEnv();
	for (let i = 0; i < 250; i++) env.storage.pages.rows.set(`p:${i}`, { day: addDays("2026-01-01", 0), key: `k${i}`, views: 1 });
	const all = await queryAll(env.storage.pages, {});
	assert.equal(all.rows.length, 250);
	assert.equal(all.truncated, false);
});

test("labelFor resolves titles and falls back to the key", async () => {
	const content = { get: async (_c: string, id: string) => (id === "A" ? { slug: "a", data: { title: "Hello" } } : id === "B" ? { slug: "b-slug", data: {} } : null) };
	assert.equal(await labelFor("home"), "Home");
	assert.equal(await labelFor("term:tag:go"), "Tag: go");
	assert.equal(await labelFor("posts:A", content), "Hello");
	assert.equal(await labelFor("posts:B", content), "b-slug");
	assert.equal(await labelFor("posts:GONE", content), "posts:GONE");
	assert.equal(await labelFor("posts:A", { get: async () => { throw new Error("x"); } }), "posts:A");
});
