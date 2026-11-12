import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBlocks } from "@emdash-cms/blocks/server";
import { panelBlocks } from "../../src/plugins/site-stats/admin/panel.ts";
import type { AdminCtx } from "../../src/plugins/site-stats/admin/handler.ts";
import { resetSettingsCache } from "../../src/plugins/site-stats/lib/settings.ts";
import { fakeEnv } from "./fake-storage.ts";

const NOW = new Date("2026-11-12T03:00:00Z");
const ENTRY = { collection: "posts", id: "01M5Y039AP0GMRVE5NKPPN3K23" };
const ctxOf = (env: ReturnType<typeof fakeEnv>, entry: AdminCtx["ui"]): AdminCtx => ({ ...env, input: { type: "panel_load" }, ui: entry });
const panel = { surface: "content-editor-panel", entry: ENTRY };

test("panel sums this entry's views only, by window", async () => {
	resetSettingsCache();
	const env = fakeEnv();
	const key = `${ENTRY.collection}:${ENTRY.id}`;
	env.storage.totals.rows.set(`e:${key}`, { kind: "page", key, views: 100 });
	env.storage.pages.rows.set(`p:2026-11-12|${key}`, { day: "2026-11-12", key, views: 4 });
	env.storage.pages.rows.set(`p:2026-11-01|${key}`, { day: "2026-11-01", key, views: 10 });
	env.storage.pages.rows.set("p:2026-11-12|home", { day: "2026-11-12", key: "home", views: 999 });
	env.storage.pages.rows.set(`p:2026-09-01|${key}`, { day: "2026-09-01", key, views: 50 });
	const res = await panelBlocks(ctxOf(env, panel), NOW);
	assert.equal(validateBlocks(res.blocks as any).valid, true);
	const stats = (res.blocks[0] as any).items.map((i: any) => `${i.label}=${i.value}`);
	assert.deepEqual(stats, ["All time=100", "Last 30 days=14", "Last 7 days=4"]);
});

test("an entry with no views shows the empty state", async () => {
	resetSettingsCache();
	const res = await panelBlocks(ctxOf(fakeEnv(), panel), NOW);
	assert.equal(validateBlocks(res.blocks as any).valid, true);
	assert.equal(res.blocks[0]!.type, "empty");
});

test("a missing or malformed entry identity renders an error banner", async () => {
	resetSettingsCache();
	for (const ui of [undefined, { surface: "content-editor-panel", entry: { collection: "posts", id: "a|b" } }] as any[]) {
		const res = await panelBlocks(ctxOf(fakeEnv(), ui), NOW);
		assert.equal(res.blocks[0]!.type, "banner");
	}
});
