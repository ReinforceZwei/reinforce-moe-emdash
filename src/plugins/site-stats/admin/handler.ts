import type { Block, BlockResponse } from "@emdash-cms/blocks";
import { z } from "zod";
import { chartBlock, emptyBlock, errorBanner, n, rangePicker, statsBlock, tableBlock, truncatedNote, type Summary } from "../blocks.ts";
import { readSettings } from "../lib/settings.ts";
import type { Env } from "../lib/types.ts";
import {
	boundsFor,
	labelFor,
	loadDays,
	loadTopPages,
	parseRange,
	sumUniques,
	sumViews,
	type ContentLookup,
	type RangeId,
} from "../read.ts";

export interface AdminCtx extends Env {
	input: unknown;
	content?: ContentLookup;
	ui?: { surface: string; entry?: { collection: string; id: string } };
}

const Interaction = z
	.object({
		type: z.string(),
		page: z.string().optional(),
		action_id: z.string().optional(),
		value: z.unknown().optional(),
	})
	.passthrough();

const RANGE_KEY = "ui:range";
export const PAGES = {
	overview: "/overview",
} as const;

const pathOf = (p: string | undefined) => (p ?? "").replace(/^\/?/, "/");

async function summarise(env: Env, range: RangeId, now: Date) {
	const { timezone } = await readSettings(env);
	const b = boundsFor(range, now, timezone);
	const [cur, prev] = await Promise.all([loadDays(env, b.from, b.to), loadDays(env, b.prevFrom, b.prevTo)]);
	const summary: Summary = {
		points: cur.points,
		views: sumViews(cur.points),
		uniques: sumUniques(cur.points),
		prevViews: sumViews(prev.points),
		prevUniques: sumUniques(prev.points),
		todayViews: cur.points.at(-1)?.views ?? 0,
	};
	return { b, summary, truncated: cur.truncated || prev.truncated };
}

export async function overviewBlocks(ctx: AdminCtx, range: RangeId, now = new Date()): Promise<Block[]> {
	const { b, summary, truncated } = await summarise(ctx, range, now);
	const top = await loadTopPages(ctx, b.from, b.to, 15);
	const rows = await Promise.all(top.rows.map(async (r) => ({ name: await labelFor(r.key, ctx.content), count: r.views })));
	return [
		{ type: "header", text: "Site stats" } as Block,
		rangePicker(range),
		...truncatedNote(truncated || top.truncated),
		statsBlock(summary),
		summary.views === 0
			? emptyBlock("No visits in this range", "Views appear here once visitors load a page.")
			: chartBlock(summary.points),
		{ type: "header", text: "Top pages" } as Block,
		rows.length ? tableBlock(PAGES.overview, "Page", rows) : emptyBlock("No pages yet", "Nothing has been viewed in this range."),
	];
}

export async function widgetBlocks(ctx: AdminCtx, now = new Date()): Promise<Block[]> {
	const { summary } = await summarise(ctx, "7d", now);
	return [
		{
			type: "stats",
			items: [
				{ label: "Views (7d)", value: n(summary.views) },
				{ label: "Visitors (7d)", value: n(summary.uniques) },
				{ label: "Views today", value: n(summary.todayViews) },
			],
		} as Block,
		chartBlock(summary.points, 140),
	];
}

export async function handleAdmin(ctx: AdminCtx, now = new Date()): Promise<BlockResponse> {
	try {
		const parsed = Interaction.safeParse(ctx.input);
		if (!parsed.success) return { blocks: [errorBanner("Unrecognised request.")] };
		const input = parsed.data;

		if (ctx.ui?.surface === "dashboard-widget") return { blocks: await widgetBlocks(ctx, now) };

		if (input.type === "block_action" && input.action_id === "range") {
			await ctx.kv.set(RANGE_KEY, parseRange(input.value));
		}
		const range = parseRange(await ctx.kv.get(RANGE_KEY));

		switch (pathOf(input.page)) {
			case PAGES.overview:
				return { blocks: await overviewBlocks(ctx, range, now) };
			default:
				return { blocks: [errorBanner(`Unknown page: ${input.page ?? "(none)"}`)] };
		}
	} catch (error) {
		console.error("[site-stats] admin failed", error);
		return { blocks: [errorBanner("Could not load stats. Check the server log.")] };
	}
}
