import { addDays, dayKey, dayRange } from "./lib/day.ts";
import type { Coll, Env, Where } from "./lib/types.ts";

/** Storage returns at most 100 rows a query and has no GROUP BY, so reads page and sum here. */
const PAGE = 100;
const MAX_PAGES = 40;

export async function queryAll<T extends Record<string, any>>(
	coll: Coll,
	where: Where,
): Promise<{ rows: T[]; truncated: boolean }> {
	const rows: T[] = [];
	let cursor: string | undefined;
	for (let i = 0; i < MAX_PAGES; i++) {
		const page = await coll.query({ where, limit: PAGE, cursor });
		for (const item of page.items) rows.push(item.data as T);
		if (!page.hasMore || !page.cursor) return { rows, truncated: false };
		cursor = page.cursor;
	}
	return { rows, truncated: true };
}

export type RangeId = "7d" | "30d" | "90d" | "365d";
export const RANGES: Array<{ id: RangeId; label: string; days: number }> = [
	{ id: "7d", label: "Last 7 days", days: 7 },
	{ id: "30d", label: "Last 30 days", days: 30 },
	{ id: "90d", label: "Last 90 days", days: 90 },
	{ id: "365d", label: "Last 365 days", days: 365 },
];
export const DEFAULT_RANGE: RangeId = "30d";

export function parseRange(value: unknown): RangeId {
	return RANGES.some((r) => r.id === value) ? (value as RangeId) : DEFAULT_RANGE;
}

export interface Bounds {
	from: string;
	to: string;
	prevFrom: string;
	prevTo: string;
	days: number;
}

/** The range ends today (inclusive); the previous range is the same length, directly before. */
export function boundsFor(range: RangeId, now: Date, tz: string): Bounds {
	const days = RANGES.find((r) => r.id === range)!.days;
	const to = dayKey(now, tz);
	const from = addDays(to, -(days - 1));
	return { from, to, prevFrom: addDays(from, -days), prevTo: addDays(from, -1), days };
}

export interface DayPoint {
	day: string;
	views: number;
	uniques: number;
}

export async function loadDays(env: Pick<Env, "storage">, from: string, to: string) {
	const { rows, truncated } = await queryAll<{ day: string; views?: number; uniques?: number }>(env.storage.days, {
		day: { gte: from, lte: to },
	});
	const byDay = new Map(rows.map((r) => [r.day, r]));
	const points: DayPoint[] = dayRange(from, to).map((day) => ({
		day,
		views: byDay.get(day)?.views ?? 0,
		uniques: byDay.get(day)?.uniques ?? 0,
	}));
	return { points, truncated };
}

export const sumViews = (p: DayPoint[]) => p.reduce((n, d) => n + d.views, 0);
export const sumUniques = (p: DayPoint[]) => p.reduce((n, d) => n + d.uniques, 0);

export interface PageRow {
	key: string;
	views: number;
}

export async function loadTopPages(env: Pick<Env, "storage">, from: string, to: string, top: number) {
	const { rows, truncated } = await queryAll<{ key: string; views?: number }>(env.storage.pages, {
		day: { gte: from, lte: to },
	});
	const sums = new Map<string, number>();
	for (const r of rows) sums.set(r.key, (sums.get(r.key) ?? 0) + (r.views ?? 0));
	const list: PageRow[] = [...sums].map(([key, views]) => ({ key, views })).sort((a, b) => b.views - a.views || a.key.localeCompare(b.key));
	return { rows: list.slice(0, top), truncated };
}

/** Sums one dimension (`channel`, `engine`, `browser`, ...) over a day range. */
export async function loadDim(env: Pick<Env, "storage">, kind: string, from: string, to: string, top: number) {
	const { rows, truncated } = await queryAll<{ value: string; count?: number }>(env.storage.dims, {
		kind,
		day: { gte: from, lte: to },
	});
	const sums = new Map<string, number>();
	for (const r of rows) sums.set(r.value, (sums.get(r.value) ?? 0) + (r.count ?? 0));
	const list = [...sums].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
	return { rows: list.slice(0, top), total: list.reduce((n, r) => n + r.count, 0), truncated };
}

export interface ContentLookup {
	get(collection: string, id: string): Promise<{ slug: string | null; data: Record<string, unknown> } | null>;
}

/** Human label for a page key. Unknown or deleted content falls back to its id. */
export async function labelFor(key: string, content?: ContentLookup): Promise<string> {
	if (key === "home") return "Home";
	if (key === "blog") return "Blog";
	const term = /^term:(category|tag):(.+)$/.exec(key);
	if (term) return `${term[1] === "category" ? "Category" : "Tag"}: ${term[2]}`;
	const [collection, id] = key.split(":") as [string, string];
	try {
		const item = await content?.get(collection, id);
		const title = item?.data?.title;
		if (typeof title === "string" && title) return title;
		if (item?.slug) return item.slug;
	} catch {
		/* fall through to the id */
	}
	return key;
}
