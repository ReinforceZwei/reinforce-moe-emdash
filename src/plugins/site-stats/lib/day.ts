/**
 * Day bucketing. A "day" is a `YYYY-MM-DD` string in the configured IANA timezone, so a
 * view at 00:30 Hong Kong time lands on the local date, not the UTC one. The string sorts
 * lexicographically, which is what the storage range filters (`gte`/`lte`) rely on.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
	let f = formatters.get(tz);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", {
			timeZone: tz,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		});
		formatters.set(tz, f);
	}
	return f;
}

export function isValidTimeZone(tz: string): boolean {
	try {
		formatter(tz);
		return true;
	} catch {
		return false;
	}
}

export function dayKey(date: Date, tz: string): string {
	const parts = formatter(isValidTimeZone(tz) ? tz : "UTC").formatToParts(date);
	const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
	return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Midnight UTC of a day key, in ms. Used as the x value of chart points. */
export function dayToTs(day: string): number {
	return Date.parse(`${day}T00:00:00Z`);
}

export function addDays(day: string, n: number): string {
	return new Date(dayToTs(day) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Inclusive list of day keys. */
export function dayRange(from: string, to: string): string[] {
	const out: string[] = [];
	for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
	return out;
}
