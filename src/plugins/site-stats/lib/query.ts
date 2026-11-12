import type { Coll, Where } from "./types.ts";

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
