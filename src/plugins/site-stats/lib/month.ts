import { addDays } from "./day.ts";

/** `YYYY-MM` of a day key. */
export const monthOf = (day: string): string => day.slice(0, 7);
export const monthStart = (month: string): string => `${month}-01`;

export function nextMonth(month: string): string {
	const [y, m] = month.split("-").map(Number) as [number, number];
	return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

export const monthEnd = (month: string): string => addDays(monthStart(nextMonth(month)), -1);

export type Segment = { type: "month"; from: string; to: string } | { type: "day"; from: string; to: string };

/**
 * Split a day range into stretches read from the monthly rollup (whole months that are marked
 * done) and stretches read from the per-day rows (everything else). Adjacent stretches of the
 * same type are merged, so a year is a handful of queries.
 */
export function planSegments(from: string, to: string, done: ReadonlySet<string>): Segment[] {
	const out: Segment[] = [];
	const push = (type: Segment["type"], a: string, b: string) => {
		const last = out.at(-1);
		if (last && last.type === type) last.to = b;
		else out.push({ type, from: a, to: b });
	};
	let cursor = from;
	while (cursor <= to) {
		const month = monthOf(cursor);
		const end = monthEnd(month);
		if (cursor === monthStart(month) && end <= to && done.has(month)) {
			push("month", month, month);
			cursor = addDays(end, 1);
		} else {
			const stop = end < to ? end : to;
			push("day", cursor, stop);
			cursor = addDays(stop, 1);
		}
	}
	return out;
}
