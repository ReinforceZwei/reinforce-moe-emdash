/**
 * Read path for the visitors plugin.
 *
 * Every number the admin shows comes from one of four cheap reads: the `days`
 * rollup (one `getMany` for the chart), the `totals` counters (one `query` per
 * scope), the `dims` counters (one `query` per dimension), and — only for the
 * current period column — a `visits.count()` per displayed row. Nothing here
 * scans the visit log to build a table.
 *
 * Titles are resolved server-side through `ctx.content` so the admin never
 * shows a ULID, and never has to join ids itself.
 */
import type { PluginContext } from "emdash";

import { dayDocId, dayKey, daySpan, entryKey as makeEntryKey, parseEntryKey } from "./lib";
import type { FacetDim, TotalsRow } from "./store";
import { collections } from "./store";

/** Days offered by the period selector. */
export const PERIODS = [7, 30, 90, 365] as const;
export type Period = (typeof PERIODS)[number];

export function normalisePeriod(value: unknown): Period {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
	return (PERIODS as readonly number[]).includes(parsed) ? (parsed as Period) : 30;
}

export interface DayCounts {
	day: string;
	views: number;
	uniques: number;
	sessions: number;
}

export interface Counters {
	views: number;
	uniques: number;
	sessions: number;
}

export interface EntryRow {
	entryKey: string;
	title: string;
	path: string;
	/** Distinct visitor × page × day inside the selected period. */
	visitors: number;
	/** Every hit since the counter started, refreshes included. */
	views: number;
	/** Share of the period's visitors. */
	share: number;
}

export interface DimRowView {
	value: string;
	label: string;
	/** Distinct visitor × page × day inside the selected period. */
	visitors: number;
	/** Every hit since the counter started. */
	views: number;
	share: number;
}

export interface Summary {
	period: Period;
	/** Day-by-day series for the selected period, oldest first. */
	series: DayCounts[];
	window: Counters;
	previous: Counters;
	today: DayCounts;
	allTime: Counters & { since: number | null };
	entries: EntryRow[];
	sources: DimRowView[];
	sourceTypes: { value: string; views: number }[];
	devices: DimRowView[];
	kinds: DimRowView[];
}

const EMPTY_COUNTERS: Counters = { views: 0, uniques: 0, sessions: 0 };
const EMPTY_DAY = (day: string): DayCounts => ({ day, ...EMPTY_COUNTERS });

/** Read the `days` rollup for a list of day keys; missing days are zeros. */
export async function readDays(ctx: PluginContext, days: readonly string[]): Promise<DayCounts[]> {
	const { days: collection } = collections(ctx);
	const found = await collection.getMany(days.map(dayDocId));
	return days.map((day) => {
		const row = found.get(dayDocId(day));
		return row ? { day, views: row.views, uniques: row.uniques, sessions: row.sessions } : EMPTY_DAY(day);
	});
}

function sumDays(rows: readonly DayCounts[]): Counters {
	return rows.reduce<Counters>(
		(total, row) => ({
			views: total.views + row.views,
			uniques: total.uniques + row.uniques,
			sessions: total.sessions + row.sessions,
		}),
		{ ...EMPTY_COUNTERS },
	);
}

export async function readSiteTotals(ctx: PluginContext): Promise<TotalsRow | null> {
	return collections(ctx).totals.get("site");
}

/** Per-entry / per-path counters, most-viewed first. */
export async function readItemTotals(ctx: PluginContext, limit = 25): Promise<TotalsRow[]> {
	const { totals } = collections(ctx);
	const result = await totals.query({
		where: { scope: "entry" },
		orderBy: { views: "desc" },
		limit: Math.min(limit, 100),
	});
	return result.items.map((item) => item.data);
}

/** All-time counters for one dimension, most-viewed first. */
export async function readDims(ctx: PluginContext, dim: FacetDim, limit = 20) {
	const { dims } = collections(ctx);
	const result = await dims.query({ where: { dim }, orderBy: { views: "desc" }, limit: Math.min(limit, 100) });
	return result.items.map((item) => item.data);
}

/** Visit rows inside the period for one indexed predicate, e.g. a source host. */
export async function countVisitsSince(
	ctx: PluginContext,
	since: string,
	where: Record<string, string | number>,
): Promise<number> {
	const { visits } = collections(ctx);
	return visits.count({ ...where, day: { gte: since } });
}

// --- titles -----------------------------------------------------------------
//
// One `content.get` per displayed entry, cached in module memory for ten
// minutes. The admin page is the only caller, so a small cache is enough and
// it keeps a 25-row table from costing 25 reads on every interaction.

interface TitleEntry {
	title: string;
	path: string;
	at: number;
}

const titleCache = new Map<string, TitleEntry>();
const TITLE_TTL_MS = 10 * 60_000;

async function resolveTitle(ctx: PluginContext, key: string): Promise<{ title: string; path: string }> {
	const cached = titleCache.get(key);
	if (cached && Date.now() - cached.at < TITLE_TTL_MS) return cached;

	const parsed = parseEntryKey(key);
	if (!ctx.content || !parsed) return { title: key, path: "" };

	try {
		const item = await ctx.content.get(parsed.collection, parsed.id);
		const rawTitle = item?.data?.title;
		const title = typeof rawTitle === "string" && rawTitle.trim().length > 0 ? rawTitle.trim() : (item?.slug ?? key);
		const path =
			item?.slug != null
				? parsed.collection === "posts"
					? `/blog/${encodeURIComponent(item.slug)}`
					: `/${encodeURIComponent(item.slug)}`
				: "";
		const entry = { title, path, at: Date.now() };
		titleCache.set(key, entry);
		return entry;
	} catch {
		// A missing collection or a content read failure must not blank the page.
		return { title: key, path: "" };
	}
}

/**
 * Slug → entry key, for beacons from HTML cached before the plugin existed
 * (the entry key is baked into the script, so this is a fallback only).
 *
 * Cached for five minutes; the site has tens of entries, so one paginated list
 * per collection is cheap, and a newly published post is resolvable within the
 * cache window — well inside the 24 h page cache it would have to outlive.
 */
interface SlugIndex {
	at: number;
	entries: Map<string, string>;
}

const slugIndexes = new Map<string, SlugIndex>();
const SLUG_TTL_MS = 5 * 60_000;

export async function entryKeyForSlug(
	ctx: PluginContext,
	collection: "posts" | "pages",
	slug: string,
): Promise<string | null> {
	if (!ctx.content) return null;

	const cached = slugIndexes.get(collection);
	let index = cached && Date.now() - cached.at < SLUG_TTL_MS ? cached.entries : null;

	if (!index) {
		index = new Map<string, string>();
		let cursor: string | undefined;
		for (let page = 0; page < 20; page += 1) {
			const result = await ctx.content.list(collection, {
				limit: 100,
				...(cursor ? { cursor } : {}),
				where: { status: "published" },
			});
			for (const item of result.items) {
				if (item.slug) index.set(item.slug.normalize("NFC"), makeEntryKey(collection, item.id));
			}
			if (!result.hasMore || !result.cursor) break;
			cursor = result.cursor;
		}
		slugIndexes.set(collection, { at: Date.now(), entries: index });
	}

	return index.get(slug.normalize("NFC")) ?? null;
}

/** Everything the overview page and the dashboard widget render. */
export async function summary(ctx: PluginContext, period: Period): Promise<Summary> {
	const today = dayKey();
	const windowDays = daySpan(today, period);
	const previousDays = daySpan(dayKey(new Date(Date.now() - period * 86_400_000)), period);

	const [series, previousSeries, site, items] = await Promise.all([
		readDays(ctx, windowDays),
		readDays(ctx, previousDays),
		readSiteTotals(ctx),
		readItemTotals(ctx, 25),
	]);

	const window = sumDays(series);
	const previous = sumDays(previousSeries);
	const todayRow = series.length > 0 ? series[series.length - 1] : EMPTY_DAY(today);

	// Rows are counted for the period, not read from an aggregate: one indexed
	// `COUNT` per displayed row keeps the table exact across any period length.
	const sinceDay = windowDays[0] ?? today;
	const entries: EntryRow[] = [];
	for (const item of items) {
		if (!item.entryKey) continue;
		const visitors = await countVisitsSince(ctx, sinceDay, { entryKey: item.entryKey });
		if (visitors === 0 && item.views === 0) continue;
		const { title, path } = await resolveTitle(ctx, item.entryKey);
		entries.push({
			entryKey: item.entryKey,
			title,
			path: item.path || path,
			visitors,
			views: item.views,
			share: window.uniques > 0 ? visitors / window.uniques : 0,
		});
	}
	entries.sort((a, b) => b.visitors - a.visitors || b.views - a.views);

	const [sourceRows, sourceTypeRows, deviceRows, kindRows] = await Promise.all([
		readDims(ctx, "source", 20),
		readDims(ctx, "sourceType", 10),
		readDims(ctx, "device", 10),
		readDims(ctx, "kind", 10),
	]);

	const dimViews = async (dim: FacetDim, value: string): Promise<number> => {
		if (dim === "kind") {
			// `kind` stores the listing type when there is one, and the page kind
			// otherwise; both live on the visit row under different fields.
			const listing = await countVisitsSince(ctx, sinceDay, { listingType: value });
			if (listing > 0) return listing;
			return countVisitsSince(ctx, sinceDay, { kind: value });
		}
		return countVisitsSince(ctx, sinceDay, { [dim]: value });
	};

	const share = (visitors: number): number => (window.uniques > 0 ? visitors / window.uniques : 0);

	const sources: DimRowView[] = [];
	for (const row of sourceRows.slice(0, 10)) {
		const visitors = await dimViews("source", row.value);
		sources.push({
			value: row.value,
			label: row.value === "direct" ? "Direct" : row.value,
			visitors,
			views: row.views,
			share: share(visitors),
		});
	}

	const devices: DimRowView[] = [];
	for (const row of deviceRows) {
		const visitors = await dimViews("device", row.value);
		devices.push({ value: row.value, label: row.value, visitors, views: row.views, share: share(visitors) });
	}

	const kinds: DimRowView[] = [];
	for (const row of kindRows) {
		const visitors = await dimViews("kind", row.value);
		kinds.push({ value: row.value, label: row.value, visitors, views: row.views, share: share(visitors) });
	}

	const sourceTypes = sourceTypeRows.map((row) => ({ value: row.value, views: row.views }));

	return {
		period,
		series,
		window,
		previous,
		today: todayRow,
		allTime: {
			views: site?.views ?? 0,
			uniques: site?.uniques ?? 0,
			sessions: site?.sessions ?? 0,
			since: site?.firstSeen ?? null,
		},
		entries: entries.slice(0, 12),
		sources,
		sourceTypes,
		devices,
		kinds,
	};
}

export interface EntryPanel {
	path: string;
	title: string;
	today: number;
	week: number;
	month: number;
	allTime: number;
}

/** Per-entry numbers for the editor panel. */
export async function entryPanel(ctx: PluginContext, collection: string, id: string): Promise<EntryPanel> {
	const key = makeEntryKey(collection, id);
	const today = dayKey();
	const [allTimeRow, todayViews, weekViews, monthViews, title] = await Promise.all([
		collections(ctx).totals.get(`entry:${key}`),
		countVisitsSince(ctx, today, { entryKey: key }),
		countVisitsSince(ctx, daySpan(today, 7)[0] ?? today, { entryKey: key }),
		countVisitsSince(ctx, daySpan(today, 30)[0] ?? today, { entryKey: key }),
		resolveTitle(ctx, key),
	]);

	return {
		path: title.path || (allTimeRow?.path ?? ""),
		title: title.title,
		today: todayViews,
		week: weekViews,
		month: monthViews,
		allTime: allTimeRow?.views ?? 0,
	};
}
