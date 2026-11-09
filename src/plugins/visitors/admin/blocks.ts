/**
 * Block Kit builders for the visitors admin surfaces.
 *
 * Plain JSON on purpose: the host renders these, so nothing plugin-authored
 * runs in the browser and there is no React entry to bundle. The types come
 * from `@emdash-cms/blocks` as type-only imports, which the compiler erases —
 * the site's runtime gains no new dependency.
 *
 * EmDash does not validate a *native* plugin's block response before the admin
 * renders it (only sandboxed plugins get `validateBlockResponse`), so the shapes
 * here follow the documented schema exactly and `scripts/verify-visitors.mjs`
 * runs them through `validateBlocks()` as the only guard.
 */
import type { Block, TableColumn } from "@emdash-cms/blocks";

import { DAY_OFFSET_MS } from "../lib";
import type { DimRowView, EntryRow, Period, Summary, WidgetSummary } from "../queries";
import { PERIODS } from "../queries";

const numberFormat = new Intl.NumberFormat("en-US");

function num(value: number): string {
	return numberFormat.format(Math.round(value));
}

function percent(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0%";
	return `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`;
}

function periodLabel(period: Period): string {
	return period === 365 ? "12 months" : `${period} days`;
}

/** The views-per-day chart. */
function chartSeries(summary: Summary): Block {
	const toPoint = (day: string, value: number): [number, number] => [
		Date.parse(`${day}T00:00:00.000Z`) - DAY_OFFSET_MS,
		value,
	];

	// One series on purpose. The host's timeseries block stacks multiple bar
	// series (views + visitors drawn as one tall bar, 5 + 4 → 9), and its line
	// mode does not plot these tuples at all — both were verified in the admin.
	// A single views series is what the host renders correctly, so visitors are
	// reported in the KPI cards and the tables instead of a second series.
	return {
		type: "chart",
		config: {
			chart_type: "timeseries",
			style: "bar",
			series: [{ name: "Views", data: summary.series.map((row) => toPoint(row.day, row.views)) }],
			x_axis_name: "Day",
			y_axis_name: "Views",
			height: 280,
		},
	};
}

function trend(windowViews: number, previousViews: number, period: Period): { trend: "up" | "down" | "neutral"; description: string } {
	if (previousViews <= 0) {
		return { trend: "neutral", description: windowViews > 0 ? "no prior period to compare" : "no traffic yet" };
	}
	const change = (windowViews - previousViews) / previousViews;
	if (Math.abs(change) < 0.01) return { trend: "neutral", description: "flat vs previous period" };
	return {
		trend: change > 0 ? "up" : "down",
		description: `${change > 0 ? "+" : ""}${(change * 100).toFixed(0)}% vs the previous ${period} days`,
	};
}

function statsBlock(summary: Summary): Block {
	const { window, previous, period } = summary;
	const viewsTrend = trend(window.views, previous.views, period);
	const perVisit = window.sessions > 0 ? window.views / window.sessions : 0;

	return {
		type: "stats",
		items: [
			{
				label: `Views · last ${periodLabel(period)}`,
				value: num(window.views),
				trend: viewsTrend.trend,
				description: viewsTrend.description,
			},
			{ label: "Visitors", value: num(window.uniques), description: "visitor × page × day" },
			{ label: "Visits", value: num(window.sessions), description: "one per tab session" },
			{
				label: "Views per visit",
				value: perVisit > 0 ? perVisit.toFixed(1) : "—",
				description: window.sessions > 0 ? "views ÷ visits" : "no visits recorded",
			},
		],
	};
}

const ENTRY_COLUMNS: TableColumn[] = [
	{ key: "title", label: "Entry" },
	{ key: "visitors", label: "Visitors", format: "number", sortable: true },
	{ key: "views", label: "Views (all time)", format: "number", sortable: true },
	{ key: "share", label: "Share" },
];

/** `firstColumn` differs per table (Source / Device / Page). */
function dimColumns(firstColumn: string): TableColumn[] {
	return [
		{ key: "label", label: firstColumn },
		{ key: "visitors", label: "Visitors", format: "number", sortable: true },
		{ key: "views", label: "Views (all time)", format: "number", sortable: true },
		{ key: "share", label: "Share" },
	];
}

function entryRows(entries: EntryRow[]): Array<Record<string, unknown>> {
	return entries.map((entry) => ({
		title: entry.title,
		visitors: entry.visitors,
		views: entry.views,
		share: percent(entry.share),
	}));
}

function dimRows(rows: DimRowView[]): Array<Record<string, unknown>> {
	return rows.map((row) => ({
		label: row.label,
		visitors: row.visitors,
		views: row.views,
		share: percent(row.share),
	}));
}

export type SortRequest = { table: string | undefined; key: string; dir: "asc" | "desc" } | null;

function sortEntries(entries: EntryRow[], sort: SortRequest): EntryRow[] {
	if (!sort || sort.table !== "entries") return entries;
	const factor = sort.dir === "asc" ? 1 : -1;
	const key = sort.key as keyof Pick<EntryRow, "visitors" | "views" | "title">;
	return [...entries].sort((a, b) => {
		const left = a[key];
		const right = b[key];
		if (typeof left === "number" && typeof right === "number") return (left - right) * factor;
		return String(left).localeCompare(String(right)) * factor;
	});
}

function sortDims(rows: DimRowView[], sort: SortRequest, table: string): DimRowView[] {
	if (!sort || sort.table !== table) return rows;
	const factor = sort.dir === "asc" ? 1 : -1;
	const key = sort.key as keyof Pick<DimRowView, "visitors" | "views" | "label">;
	return [...rows].sort((a, b) => {
		const left = a[key];
		const right = b[key];
		if (typeof left === "number" && typeof right === "number") return (left - right) * factor;
		return String(left).localeCompare(String(right)) * factor;
	});
}

function periodMenu(period: Period): Block {
	return {
		type: "actions",
		elements: [
			{
				type: "menu",
				action_id: "period",
				label: `Period: ${periodLabel(period)}`,
				items: PERIODS.map((candidate) => ({ label: `Last ${periodLabel(candidate)}`, value: String(candidate) })),
			},
			{
				type: "link",
				label: "Open Google Analytics",
				target: { kind: "external", url: "https://analytics.google.com/analytics/web/" },
				appearance: "secondary",
			},
		],
	};
}

/** The `/visitors` admin page. */
export function overviewBlocks(summary: Summary, sort: SortRequest = null, retention = 400): Block[] {
	if (summary.allTime.views === 0) {
		return [
			{ type: "header", text: "Visitors" },
			periodMenu(summary.period),
			{
				type: "empty",
				title: "No visits recorded yet",
				description:
					"The beacon is installed on every public page. Numbers appear here after the first reader loads one — cached pages still send it.",
			},
		];
	}

	const since = summary.allTime.since
		? new Date(summary.allTime.since + DAY_OFFSET_MS).toISOString().slice(0, 10)
		: null;

	const blocks: Block[] = [
		{ type: "header", text: "Visitors" },
		periodMenu(summary.period),
		statsBlock(summary),
		{
			type: "context",
			text: [
				`Self-hosted count since ${since ?? "install"}: one row per visitor × page × day, so a reader who opens three posts counts three views and three visitors.`,
				"Day boundary 00:00 Asia/Taipei. Your own visits are included — there is no admin opt-out.",
			].join(" "),
		},
		chartSeries(summary),
		{
			type: "context",
			text: `Compared with Google Analytics, expect different numbers: this counts raw server-side hits from a salted per-day hash, GA4 counts a cookie identity and filters differently.`,
		},
	];

	if (summary.entries.length > 0) {
		blocks.push(
			{ type: "header", text: "Top entries" },
			{
				type: "table",
				block_id: "entries",
				columns: ENTRY_COLUMNS,
				rows: entryRows(sortEntries(summary.entries, sort)),
				page_action_id: "sort",
				empty_text: "No entry views in this period.",
			},
		);
	}

	if (summary.sources.length > 0) {
		blocks.push(
			{ type: "header", text: "Where readers came from" },
			{
				type: "table",
				block_id: "sources",
				columns: dimColumns("Source"),
				rows: dimRows(sortDims(summary.sources, sort, "sources")),
				page_action_id: "sort",
				empty_text: "No referrers in this period.",
			},
			{
				type: "context",
				text: `Channels: ${summary.sourceTypes.map((row) => `${row.value} ${num(row.views)}`).join(" · ") || "none"} (all time).`,
			},
		);
	}

	if (summary.devices.length > 0) {
		blocks.push(
			{ type: "header", text: "Devices" },
			{
				type: "table",
				block_id: "devices",
				columns: dimColumns("Device"),
				rows: dimRows(sortDims(summary.devices, sort, "devices")),
				page_action_id: "sort",
				empty_text: "No device data in this period.",
			},
		);
	}

	if (summary.kinds.length > 0) {
		blocks.push(
			{ type: "header", text: "Page kinds" },
			{
				type: "table",
				block_id: "kinds",
				columns: dimColumns("Page"),
				rows: dimRows(sortDims(summary.kinds, sort, "kinds")),
				page_action_id: "sort",
				empty_text: "No traffic in this period.",
			},
			{
				type: "context",
				text: "Listing pages (blog, tag, category, search) map to no entry, so per-entry numbers can never sum to the site total. On this site listings are roughly a third of traffic.",
			},
		);
	}

	const retentionNote =
		retention === 0
			? "Raw IP and referrer are kept on every hit indefinitely (retention 0)."
			: `Raw IP and referrer are kept on every hit for ${retention} days.`;

	blocks.push({
		type: "context",
		text: `All time: ${num(summary.allTime.views)} views · ${num(summary.allTime.uniques)} visitors · ${num(summary.allTime.sessions)} visits. ${retentionNote} Country lives in Google Analytics.`,
	});

	return blocks;
}

/** The dashboard card: a quartet and the top three, from `widgetSummary()`. */
export function widgetBlocks(data: WidgetSummary): Block[] {
	if (data.allTime.views === 0) {
		return [
			{
				type: "empty",
				title: "No visits yet",
				description: "Appears after the first reader loads a page.",
				size: "sm",
			},
		];
	}

	const perVisit = data.allTime.sessions > 0 ? data.allTime.views / data.allTime.sessions : 0;

	return [
		{
			type: "stats",
			items: [
				{ label: "Today", value: num(data.today.views) },
				{ label: "Last 7 days", value: num(data.week.views) },
				{ label: "All time", value: num(data.allTime.views) },
				{ label: "Views/visit", value: perVisit > 0 ? perVisit.toFixed(1) : "—" },
			],
		},
		{
			type: "table",
			columns: [
				{ key: "title", label: "Top entry" },
				{ key: "views", label: "Views", format: "number" },
			],
			rows: data.entries.map((entry) => ({ title: entry.title, views: entry.views })),
			page_action_id: "noop",
			empty_text: "No entry views yet.",
		},
	];
}

/** Saved-entry editor panel. */
export function entryPanelBlocks(panel: {
	title: string;
	path: string;
	today: number;
	week: number;
	month: number;
	allTime: number;
}): Block[] {
	const blocks: Block[] = [
		{ type: "header", text: "Views" },
		{
			type: "stats",
			items: [
				{ label: "Today", value: num(panel.today) },
				{ label: "7 days", value: num(panel.week) },
				{ label: "30 days", value: num(panel.month) },
				{ label: "All time", value: num(panel.allTime) },
			],
		},
		{
			type: "context",
			text: "Visitor × page × day, counted from this site's own beacon. A visitor who reads the post today after reading it yesterday counts again.",
		},
	];

	blocks.push({
		type: "actions",
		elements: [
			{
				type: "link",
				label: "All visitors",
				target: { kind: "plugin-page", path: "/visitors" },
				appearance: "secondary",
			},
		],
	});

	return blocks;
}

/** Never throw at the host: a query failure becomes a banner, not a 500. */
export function errorBlocks(message: string): Block[] {
	return [
		{ type: "header", text: "Visitors" },
		{
			type: "banner",
			variant: "error",
			title: "Could not load visitor statistics",
			description: message,
		},
	];
}

