import { classifyReferrer } from "./lib/referrer.ts";
import { parseUa } from "./lib/ua.ts";
import type { Coll, DimKind, Env } from "./lib/types.ts";

/**
 * Atomic counter bump. `updateIf` never inserts, and the create path (`compareAndSet`) does not
 * apply `delta`, so the creating write seeds the increment itself. If another request created
 * the document in between, the second `updateIf` lands on it.
 */
export async function bump(
	coll: Coll,
	id: string,
	base: Record<string, unknown>,
	delta: Record<string, number>,
): Promise<void> {
	const deltas = Object.fromEntries(Object.entries(delta).map(([k, n]) => [k, { inc: n }]));
	if ((await coll.updateIf(id, { where: {}, delta: deltas })).applied) return;
	if ((await coll.compareAndSet(id, null, { ...base, ...delta })).applied) return;
	await coll.updateIf(id, { where: {}, delta: deltas });
}

export interface Hit {
	day: string;
	key: string;
	/** First hit of this visitor today. */
	unique: boolean;
	referrer: string;
	ua: string;
	siteHosts: string[];
}

const clean = (v: string, max: number) => v.normalize("NFC").trim().slice(0, max);

/**
 * Views count every accepted load; visitors, referrers and technology count once per
 * visitor-day (the first hit), which is how WP Statistics defines a visitor record.
 */
export async function recordHit(env: Pick<Env, "storage">, hit: Hit): Promise<void> {
	const { days, pages, dims, totals } = env.storage;
	const u = hit.unique ? 1 : 0;
	const work: Array<Promise<void>> = [
		bump(days, `d:${hit.day}`, { day: hit.day }, { views: 1, ...(u ? { uniques: 1 } : {}) }),
		bump(pages, `p:${hit.day}|${hit.key}`, { day: hit.day, key: hit.key }, { views: 1 }),
		bump(totals, "site", { kind: "site" }, { views: 1, ...(u ? { uniques: 1 } : {}) }),
		bump(totals, `e:${hit.key}`, { kind: "page", key: hit.key }, { views: 1 }),
	];

	if (hit.unique) {
		const dim = (kind: DimKind, value: string | undefined) => {
			if (!value) return;
			work.push(bump(dims, `m:${hit.day}|${kind}|${value}`, { day: hit.day, kind, value }, { count: 1 }));
		};
		const ref = classifyReferrer(hit.referrer, hit.siteHosts);
		dim("channel", ref.channel);
		dim("ref", ref.host && ref.channel === "referral" ? clean(ref.host, 80) : undefined);
		dim("engine", ref.engine);
		dim("word", ref.words);
		const ua = parseUa(hit.ua);
		dim("browser", ua.browser);
		dim("os", ua.os);
		dim("device", ua.device);
	}
	await Promise.all(work);
}

/** Dedupe rows embed the day, so once the day is over they can never match again. */
export async function pruneSeen(
	env: Pick<Env, "storage" | "kv">,
	today: string,
): Promise<number> {
	if ((await env.kv.get<string>("state:lastPrune")) === today) return 0;
	let removed = 0;
	for (let i = 0; i < 5; i++) {
		const page = await env.storage.seen.query({ where: { day: { lt: today } }, orderBy: { day: "asc" }, limit: 100 });
		if (page.items.length === 0) break;
		removed += await env.storage.seen.deleteMany(page.items.map((r) => r.id));
		if (page.items.length < 100) break;
	}
	// Only mark the day done once the backlog is clear, so a big backlog drains over several hits.
	const left = await env.storage.seen.query({ where: { day: { lt: today } }, limit: 1 });
	if (left.items.length === 0) await env.kv.set("state:lastPrune", today);
	return removed;
}
