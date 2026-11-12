import type { Block } from "@emdash-cms/blocks";
import { dayToTs } from "./lib/day.ts";
import { RANGES, type DayPoint, type RangeId } from "./read.ts";

const fmt = new Intl.NumberFormat("en-US");
export const n = (v: number) => fmt.format(v);

function trend(now: number, prev: number): { trend: "up" | "down" | "neutral"; description: string } {
	if (prev === 0) return { trend: "neutral", description: now === 0 ? "No data yet" : "No earlier data to compare" };
	const pct = Math.round(((now - prev) / prev) * 100);
	if (pct === 0) return { trend: "neutral", description: "Same as the previous period" };
	return { trend: pct > 0 ? "up" : "down", description: `${pct > 0 ? "+" : ""}${pct}% vs previous period` };
}

export function rangePicker(range: RangeId): Block {
	return {
		type: "actions",
		block_id: "range-picker",
		elements: [
			{
				type: "select",
				action_id: "range",
				label: "Range",
				options: RANGES.map((r) => ({ label: r.label, value: r.id })),
				initial_value: range,
			},
		],
	};
}

export function truncatedNote(truncated: boolean): Block[] {
	return truncated
		? [{ type: "banner", variant: "alert", description: "This range holds more data than can be summed here; totals are partial." } as Block]
		: [];
}

export interface Summary {
	points: DayPoint[];
	views: number;
	uniques: number;
	prevViews: number;
	prevUniques: number;
	todayViews: number;
}

export function statsBlock(s: Summary): Block {
	const perVisitor = s.uniques ? (s.views / s.uniques).toFixed(1) : "0";
	return {
		type: "stats",
		items: [
			{ label: "Views", value: n(s.views), ...trend(s.views, s.prevViews) },
			{ label: "Visitors", value: n(s.uniques), ...trend(s.uniques, s.prevUniques) },
			{ label: "Views per visitor", value: perVisitor },
			{ label: "Views today", value: n(s.todayViews) },
		],
	} as Block;
}

export function chartBlock(points: DayPoint[], height = 280): Block {
	return {
		type: "chart",
		config: {
			chart_type: "timeseries",
			style: "line",
			series: [
				{ name: "Views", data: points.map((p) => [dayToTs(p.day), p.views]) },
				{ name: "Visitors", data: points.map((p) => [dayToTs(p.day), p.uniques]) },
			],
			x_axis_name: "Day",
			height,
			gradient: true,
		},
	} as Block;
}

export function tableBlock(
	pageActionId: string,
	firstLabel: string,
	rows: Array<{ name: string; count: number }>,
	countLabel = "Views",
): Block {
	return {
		type: "table",
		block_id: `tbl-${pageActionId}`,
		page_action_id: pageActionId,
		columns: [
			{ key: "name", label: firstLabel, format: "text" },
			{ key: "count", label: countLabel, format: "number" },
		],
		rows: rows.map((r) => ({ name: r.name, count: r.count })),
	} as Block;
}

export const emptyBlock = (title: string, description: string): Block =>
	({ type: "empty", title, description }) as Block;

export const errorBanner = (message: string): Block =>
	({ type: "banner", variant: "error", title: "Site stats", description: message }) as Block;
