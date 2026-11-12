import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBlocks } from "@emdash-cms/blocks/server";
import { handleAdmin, type AdminCtx } from "../../src/plugins/site-stats/admin/handler.ts";
import { resetSettingsCache } from "../../src/plugins/site-stats/lib/settings.ts";
import { fakeEnv } from "./fake-storage.ts";

const NOW = new Date("2026-11-12T03:00:00Z");
const ctxOf = (env: ReturnType<typeof fakeEnv>, input: unknown, ui?: AdminCtx["ui"]): AdminCtx => ({
	...env,
	input,
	ui,
	content: { get: async (_c, id) => (id === "A" ? { slug: "a", data: { title: "Hello post" } } : null) },
});

function seed(env: ReturnType<typeof fakeEnv>) {
	env.storage.days.rows.set("d:2026-11-12", { day: "2026-11-12", views: 5, uniques: 3 });
	env.storage.days.rows.set("d:2026-11-05", { day: "2026-11-05", views: 2, uniques: 2 });
	env.storage.pages.rows.set("p:2026-11-12|posts:A", { day: "2026-11-12", key: "posts:A", views: 4 });
	env.storage.pages.rows.set("p:2026-11-12|home", { day: "2026-11-12", key: "home", views: 1 });
}

test("overview renders valid blocks with real numbers", async () => {
	resetSettingsCache();
	const env = fakeEnv();
	seed(env);
	const res = await handleAdmin(ctxOf(env, { type: "page_load", page: "/overview" }), NOW);
	assert.equal(validateBlocks(res.blocks as any).valid, true);
	const text = JSON.stringify(res.blocks);
	assert.match(text, /"Views","value":"7"/);
	assert.match(text, /Hello post/);
	assert.match(text, /"type":"chart"/);
});

test("an empty site renders the empty state, not a chart", async () => {
	resetSettingsCache();
	const res = await handleAdmin(ctxOf(fakeEnv(), { type: "page_load", page: "overview" }), NOW);
	assert.equal(validateBlocks(res.blocks as any).valid, true);
	assert.match(JSON.stringify(res.blocks), /No visits in this range/);
	assert.doesNotMatch(JSON.stringify(res.blocks), /"type":"chart"/);
});

test("the range picker persists and a 7d range drops older days", async () => {
	resetSettingsCache();
	const env = fakeEnv();
	seed(env);
	const res = await handleAdmin(ctxOf(env, { type: "block_action", action_id: "range", value: "7d", page: "/overview" }), NOW);
	assert.equal(await env.kv.get("ui:range"), "7d");
	assert.match(JSON.stringify(res.blocks), /"Views","value":"5"/);
});

test("widget surface, garbage input and unknown pages never throw", async () => {
	resetSettingsCache();
	const env = fakeEnv();
	seed(env);
	const widget = await handleAdmin(ctxOf(env, { type: "page_load" }, { surface: "dashboard-widget" }), NOW);
	assert.equal(validateBlocks(widget.blocks as any).valid, true);
	for (const input of [null, "x", 5, { type: "page_load", page: "/nope" }]) {
		const res = await handleAdmin(ctxOf(env, input), NOW);
		assert.equal(res.blocks[0]!.type, "banner");
	}
});
