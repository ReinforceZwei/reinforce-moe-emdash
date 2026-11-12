import type { Block, BlockResponse } from "@emdash-cms/blocks";
import { chartBlock, emptyBlock, errorBanner, n } from "../blocks.ts";
import { addDays, dayKey, dayRange } from "../lib/day.ts";
import { isPageKey } from "../lib/pagekey.ts";
import { readSettings } from "../lib/settings.ts";
import { queryAll, type DayPoint } from "../read.ts";
import type { AdminCtx } from "./handler.ts";

/** Per-entry stats track views only; drop the always-zero visitors series. */
function viewsOnly(block: Block): Block {
	const chart = block as unknown as { config: { series: Array<{ name: string }> } };
	chart.config.series = chart.config.series.filter((s) => s.name === "Views");
	return block;
}

/**
 * Per-entry "Views" panel in the content editor. The host attests which saved entry is open
 * (`ctx.ui.entry`); nothing about the entry is trusted from the request body.
 */
export async function panelBlocks(ctx: AdminCtx, now = new Date()): Promise<BlockResponse> {
	try {
		const entry = ctx.ui?.entry;
		const key = entry ? `${entry.collection}:${entry.id}` : "";
		if (!entry || !isPageKey(key)) return { blocks: [errorBanner("Open a saved entry to see its views.")] };

		const { timezone } = await readSettings(ctx);
		const to = dayKey(now, timezone);
		const from = addDays(to, -29);
		const [total, recent] = await Promise.all([
			ctx.storage.totals.get(`e:${key}`),
			queryAll<{ day: string; views?: number }>(ctx.storage.pages, { key, day: { gte: from, lte: to } }),
		]);
		const byDay = new Map(recent.rows.map((r) => [r.day, r.views ?? 0]));
		const points: DayPoint[] = dayRange(from, to).map((day) => ({ day, views: byDay.get(day) ?? 0, uniques: 0 }));
		const sum = (days: number) => points.slice(-days).reduce((acc, p) => acc + p.views, 0);
		const allTime = Number(total?.views ?? 0);

		if (allTime === 0) {
			return { blocks: [emptyBlock("No views yet", "Views appear here once visitors open this entry on the site.")] };
		}
		const blocks: Block[] = [
			{
				type: "stats",
				items: [
					{ label: "All time", value: n(allTime) },
					{ label: "Last 30 days", value: n(sum(30)) },
					{ label: "Last 7 days", value: n(sum(7)) },
				],
			} as Block,
			viewsOnly(chartBlock(points, 160)),
		];
		return { blocks };
	} catch (error) {
		console.error("[site-stats] editor panel failed", error);
		return { blocks: [errorBanner("Could not load views.")] };
	}
}
