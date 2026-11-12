import { addDays } from "./lib/day.ts";
import { monthEnd, monthOf, monthStart, nextMonth } from "./lib/month.ts";
import type { Env } from "./lib/types.ts";
import { queryAll } from "./lib/query.ts";

/**
 * Monthly rollups. A finished month is summed from its per-day rows into `pagesm` / `dimsm`,
 * then marked done with a `totals` row (`rollup:YYYY-MM`). Readers use a month's rollup only
 * when the marker exists, so a half-written month is never read. The per-day rows are kept.
 *
 * Re-running a month is harmless: rows are insert-if-absent and a finished month's per-day
 * rows no longer change.
 */
export const markerId = (month: string) => `rollup:${month}`;

export async function loadDoneMonths(env: Pick<Env, "storage">): Promise<Set<string>> {
	const { rows } = await queryAll<{ month: string }>(env.storage.totals, { kind: "rollup" });
	return new Set(rows.map((r) => r.month));
}

async function writeAll(coll: Env["storage"]["pagesm"], rows: Array<{ id: string; data: Record<string, unknown> }>) {
	for (let i = 0; i < rows.length; i += 25) {
		await Promise.all(rows.slice(i, i + 25).map((r) => coll.compareAndSet(r.id, null, r.data)));
	}
}

export async function compactMonth(env: Pick<Env, "storage">, month: string): Promise<{ pages: number; dims: number }> {
	const pageSums = new Map<string, number>();
	const dimSums = new Map<string, { kind: string; value: string; count: number }>();
	// A week at a time keeps each read under the query cap; a chunk that still hits it would be
	// frozen wrong, so fail and leave the month for a later run.
	const last = monthEnd(month);
	for (let from = monthStart(month); from <= last; from = addDays(from, 7)) {
		const to = addDays(from, 6) < last ? addDays(from, 6) : last;
		const range = { gte: from, lte: to };
		const [pages, dims] = await Promise.all([
			queryAll<{ key: string; views?: number }>(env.storage.pages, { day: range }),
			queryAll<{ kind: string; value: string; count?: number }>(env.storage.dims, { day: range }),
		]);
		if (pages.truncated || dims.truncated) throw new Error(`rollup ${month}: too many rows to read for ${from}`);
		for (const r of pages.rows) pageSums.set(r.key, (pageSums.get(r.key) ?? 0) + (r.views ?? 0));
		for (const r of dims.rows) {
			const k = `${r.kind}|${r.value}`;
			const cur = dimSums.get(k) ?? { kind: r.kind, value: r.value, count: 0 };
			cur.count += r.count ?? 0;
			dimSums.set(k, cur);
		}
	}
	await writeAll(env.storage.pagesm, [...pageSums].map(([key, views]) => ({ id: `pm:${month}|${key}`, data: { month, key, views } })));
	await writeAll(env.storage.dimsm, [...dimSums].map(([k, d]) => ({ id: `mm:${month}|${k}`, data: { month, ...d } })));
	// The marker goes last: until it exists, readers keep using the per-day rows.
	await env.storage.totals.compareAndSet(markerId(month), null, { kind: "rollup", month });
	return { pages: pageSums.size, dims: dimSums.size };
}

const MAX_MONTHS_PER_RUN = 3;

/**
 * Compact finished months that have per-day rows but no marker. Runs after a counted hit, at
 * most once a day once it has caught up. A month is finished a full day after its last day, so
 * hits still in flight at midnight are in.
 */
export async function compactDue(env: Pick<Env, "storage" | "kv">, today: string): Promise<string[]> {
	if ((await env.kv.get<string>("state:lastCompact")) === today) return [];
	const first = await env.storage.days.query({ orderBy: { day: "asc" }, limit: 1 });
	const start = (first.items[0]?.data as { day?: string } | undefined)?.day;
	if (!start) return [];
	const done = await loadDoneMonths(env);
	const compacted: string[] = [];
	let pending = false;
	for (let m = monthOf(start); addDays(monthEnd(m), 1) < today; m = nextMonth(m)) {
		if (done.has(m)) continue;
		const any = await env.storage.days.query({ where: { day: { gte: monthStart(m), lte: monthEnd(m) } }, limit: 1 });
		if (any.items.length === 0) continue; // nothing was counted that month; there is nothing to roll up
		if (compacted.length >= MAX_MONTHS_PER_RUN) { pending = true; break; }
		await compactMonth(env, m);
		compacted.push(m);
	}
	if (!pending) await env.kv.set("state:lastCompact", today);
	return compacted;
}
