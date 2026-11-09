/**
 * Everything the visitors plugin writes, and the document shapes it writes.
 *
 * Counters are split into four collections because they answer different
 * questions at different costs:
 *
 *   visits   one row per visitor × page × day (the raw evidence; prunable)
 *   sessions one row per tab-visit (so views ÷ sessions = pages per visit)
 *   days     per-day rollup, so the chart is one `getMany` and never a scan
 *   totals   monotonic per-entry / per-path / site counters
 *   facets   monthly per-source / per-device / per-kind view counts
 *
 * `visits` is the only collection that grows with traffic, and it is the only
 * one that gets pruned. `days`, `totals` and `facets` are aggregates: bounded
 * by the number of days, entries and dimensions respectively, so they are kept
 * forever and the dashboard stays cheap.
 *
 * Storage queries in EmDash 1.3 may only filter and sort on *declared* indexes
 * (`storage.<collection>.indexes`), which is why every field queried here also
 * appears in the plugin's storage declaration.
 */
import type { PluginContext, StorageCollection } from "emdash";

import { dayDocId, dayKey, facetValueId, sessionHash, visitorHash } from "./lib";
import type { DeviceType, ListingType, SourceType, VisitKind } from "./lib";

export interface VisitRow {
	visitorKey: string;
	day: string;
	path: string;
	entryKey: string | null;
	kind: VisitKind;
	listingType: ListingType | null;
	ip: string;
	referrer: string;
	source: string;
	sourceType: SourceType;
	device: DeviceType;
	ts: number;
}

export interface SessionRow {
	day: string;
	ts: number;
}

export interface DayRow {
	day: string;
	views: number;
	uniques: number;
	sessions: number;
	updatedAt: number;
}

export type TotalScope = "site" | "entry" | "path";

export interface TotalsRow {
	scope: TotalScope;
	views: number;
	uniques: number;
	sessions: number;
	firstSeen: number;
	updatedAt: number;
	entryKey?: string;
	path?: string;
}

export type FacetDim = "source" | "sourceType" | "device" | "kind";

/**
 * All-time counter for one value of one dimension (`google.com`, `mobile`,
 * `tag`, …).
 *
 * One document per value, no time bucketing: the values are a bounded set
 * (a few dozen hosts, four devices, six page kinds), so this table stays tiny
 * while answering "where did readers come from" with a single ordered query.
 * The time-windowed number for a row is then a `visits.count()` over the same
 * value, which is exact and needs no second aggregate to keep in sync.
 */
export interface DimRow {
	dim: FacetDim;
	value: string;
	views: number;
	updatedAt: number;
}

/** Typed view of the declared collections. */
export interface Collections {
	visits: StorageCollection<VisitRow>;
	sessions: StorageCollection<SessionRow>;
	days: StorageCollection<DayRow>;
	totals: StorageCollection<TotalsRow>;
	dims: StorageCollection<DimRow>;
}

export function collections(ctx: PluginContext): Collections {
	return ctx.storage as unknown as Collections;
}

const SALT_KEY = "state:salt";
const PRUNE_TASK = "visitors-prune";
const PRUNE_BATCH = 100;
const PRUNE_MAX_BATCHES = 50;

/**
 * Per-install pepper for the visitor and session hashes.
 *
 * Created by `plugin:install`, but also created lazily here: a native plugin's
 * install hook runs once, only for a config plugin with no state row, so a
 * database restored from a backup taken before the plugin existed (or a dev
 * database where the hook never ran) would otherwise hash with an empty salt.
 */
export async function ensureSalt(ctx: PluginContext): Promise<string> {
	const existing = await ctx.kv.get<string>(SALT_KEY);
	if (typeof existing === "string" && existing.length >= 8) return existing;

	const candidate = crypto.randomUUID().replaceAll("-", "");
	const created = await ctx.kv.compareAndSet(SALT_KEY, null, candidate);
	if (created.applied) return candidate;

	const raced = await ctx.kv.get<string>(SALT_KEY);
	return typeof raced === "string" && raced.length >= 8 ? raced : candidate;
}

/** Site-wide retention in days, from the plugin's settings schema. `0` keeps everything. */
export async function retentionDays(ctx: PluginContext): Promise<number> {
	const value = await ctx.settings.get<number>("retentionDays");
	if (typeof value === "number" && Number.isFinite(value)) {
		const days = Math.trunc(value);
		// 0 (or anything negative) disables pruning: every raw hit is kept, which is
		// what a lossless export to another system needs. Ten years is the ceiling
		// otherwise — past that the setting is almost certainly a typo.
		if (days <= 0) return 0;
		return Math.min(days, 3650);
	}
	return 400;
}

interface BumpFields {
	views?: boolean;
	uniques?: boolean;
	sessions?: boolean;
}

/**
 * Increment a `totals` document, creating it on first use.
 *
 * `updateIf` is a single guarded `UPDATE … RETURNING`, so the arithmetic is
 * atomic per document. `applied: false` conflates "row absent" and "guard
 * failed", so the fallback is a create-then-retry: if another request created
 * the row between the update and the insert, the insert reports `applied:
 * false` and the retry lands on the now-existing row instead of losing the
 * hit.
 */
async function bumpTotals(
	ctx: PluginContext,
	id: string,
	seed: () => TotalsRow,
	fields: BumpFields,
): Promise<void> {
	const { totals } = collections(ctx);
	const delta: Record<string, { inc: number }> = {};
	if (fields.views) delta.views = { inc: 1 };
	if (fields.uniques) delta.uniques = { inc: 1 };
	if (fields.sessions) delta.sessions = { inc: 1 };

	const first = await totals.updateIf(id, { where: {}, set: { updatedAt: Date.now() }, delta });
	if (first.applied) return;

	// The create path has to carry the increment itself: `compareAndSet` writes
	// the document as given and does not apply `delta`, so seeding every counter
	// at zero would silently drop the hit that created the row.
	const initial = seed();
	if (fields.views) initial.views = 1;
	if (fields.uniques) initial.uniques = 1;
	if (fields.sessions) initial.sessions = 1;

	const created = await totals.compareAndSet(id, null, initial);
	if (created.applied) return;
	await totals.updateIf(id, { where: {}, set: { updatedAt: Date.now() }, delta });
}

/**
 * Increment the per-day rollup.
 *
 * `uniques` is incremented alongside `views`, so it carries the same
 * definition as the `visits` rows: visitor × page × day. A reader who opens
 * three posts contributes three views and three uniques that day — that is the
 * WP Statistics definition the backfilled series used, and mixing it with a
 * visitor-day-only count would make the two incomparable.
 */
export async function bumpDay(ctx: PluginContext, day: string, fields: BumpFields): Promise<void> {
	const { days } = collections(ctx);
	const id = dayDocId(day);
	const delta: Record<string, { inc: number }> = {};
	if (fields.views) delta.views = { inc: 1 };
	if (fields.uniques) delta.uniques = { inc: 1 };
	if (fields.sessions) delta.sessions = { inc: 1 };

	const first = await days.updateIf(id, { where: {}, set: { updatedAt: Date.now() }, delta });
	if (first.applied) return;
	const created = await days.compareAndSet(id, null, {
		day,
		views: fields.views ? 1 : 0,
		uniques: fields.uniques ? 1 : 0,
		sessions: fields.sessions ? 1 : 0,
		updatedAt: Date.now(),
	});
	if (created.applied) return;
	await days.updateIf(id, { where: {}, set: { updatedAt: Date.now() }, delta });
}

/**
 * Increment the all-time counter for one dimension value.
 *
 * Bounded cardinality is what makes this cheap: one document per referrer host,
 * device class or page kind, created on first sight and incremented with a
 * single guarded UPDATE after that. No per-day rows, so this never grows with
 * traffic and never needs pruning.
 */
async function bumpDim(ctx: PluginContext, dim: FacetDim, value: string): Promise<void> {
	if (!value) return;
	const { dims } = collections(ctx);
	const id = `dim:${dim}:${facetValueId(value)}`;
	const seed = (): DimRow => ({ dim, value, views: 1, updatedAt: Date.now() });
	const first = await dims.updateIf(id, { where: {}, delta: { views: { inc: 1 } } });
	if (first.applied) return;
	const created = await dims.compareAndSet(id, null, seed());
	if (created.applied) return;
	await dims.updateIf(id, { where: {}, delta: { views: { inc: 1 } } });
}

export interface RecordVisitInput {
	day: string;
	path: string;
	entryKey: string | null;
	kind: VisitKind;
	listingType: ListingType | null;
	ip: string;
	userAgent: string;
	referrer: string;
	source: string;
	sourceType: SourceType;
	device: DeviceType;
	sid: string | null;
	/** Salt from `ensureSalt()`. */
	salt: string;
}

export interface RecordVisitResult {
	/** True when this was the first hit for this visitor × page × day. */
	unique: boolean;
	/** True when this hit opened a new visit (tab session). */
	newSession: boolean;
}

/**
 * The whole write path for one beacon.
 *
 * Two counters, not one: **views** counts every accepted hit (a refresh is a
 * view), **uniques** counts a visitor × page × day once. Without the split the
 * dashboard would show the same number twice — dedupe means "one row per
 * visitor-page-day", so a single counter could only ever be that row count.
 *
 * Cost: ~7 writes on every hit (site, item, day rollups + four dimensions),
 * plus three more when the hit is new (the `uniques` counters), plus a session
 * row and two more counters when a tab opens. The raw log still grows by one
 * row per visitor-page-day at most, which is what keeps retention cheap.
 */
export async function recordVisit(ctx: PluginContext, input: RecordVisitInput): Promise<RecordVisitResult> {
	const { visits, sessions } = collections(ctx);

	const siteSeed = (): TotalsRow => ({
		scope: "site",
		views: 0,
		uniques: 0,
		sessions: 0,
		firstSeen: Date.now(),
		updatedAt: Date.now(),
	});
	const itemId = input.entryKey ? `entry:${input.entryKey}` : `path:${input.path}`;
	const itemSeed = (): TotalsRow =>
		input.entryKey
			? {
					scope: "entry",
					entryKey: input.entryKey,
					path: input.path,
					views: 0,
					uniques: 0,
					sessions: 0,
					firstSeen: Date.now(),
					updatedAt: Date.now(),
				}
			: {
					scope: "path",
					path: input.path,
					views: 0,
					uniques: 0,
					sessions: 0,
					firstSeen: Date.now(),
					updatedAt: Date.now(),
				};

	// Views first, and unconditionally: a repeat view of a page already seen
	// today is still a view, it just is not a new visitor.
	await Promise.all([
		bumpTotals(ctx, "site", siteSeed, { views: true }),
		bumpTotals(ctx, itemId, itemSeed, { views: true }),
		bumpDay(ctx, input.day, { views: true }),
		bumpDim(ctx, "source", input.source),
		bumpDim(ctx, "sourceType", input.sourceType),
		bumpDim(ctx, "device", input.device),
		bumpDim(ctx, "kind", input.listingType ?? input.kind),
	]);

	const visitorKey = await visitorHash(input.day, input.path, input.ip, input.userAgent, input.salt);
	const created = await visits.compareAndSet(visitorKey, null, {
		visitorKey,
		day: input.day,
		path: input.path,
		entryKey: input.entryKey,
		kind: input.kind,
		listingType: input.listingType,
		ip: input.ip,
		referrer: input.referrer,
		source: input.source,
		sourceType: input.sourceType,
		device: input.device,
		ts: Date.now(),
	} satisfies VisitRow);

	// Already seen today: the view is counted, the visitor is not.
	if (!created.applied) return { unique: false, newSession: false };

	await Promise.all([
		bumpTotals(ctx, "site", siteSeed, { uniques: true }),
		bumpTotals(ctx, itemId, itemSeed, { uniques: true }),
		bumpDay(ctx, input.day, { uniques: true }),
	]);

	let newSession = false;
	if (input.sid) {
		const sessionKey = await sessionHash(input.day, input.sid, input.salt);
		const opened = await sessions.compareAndSet(sessionKey, null, { day: input.day, ts: Date.now() });
		if (opened.applied) {
			newSession = true;
			await bumpTotals(ctx, "site", siteSeed, { sessions: true });
			await bumpDay(ctx, input.day, { sessions: true });
		}
	}

	return { unique: true, newSession };
}

/** Delete `visits` rows older than the retention window, in bounded batches. */
export async function pruneVisits(ctx: PluginContext, keepDays: number): Promise<number> {
	// `0` means keep everything — no query, no delete.
	if (keepDays <= 0) return 0;

	const { visits } = collections(ctx);
	const cutoff = dayKey(new Date(Date.now() - keepDays * 86_400_000));
	let removed = 0;

	for (let batch = 0; batch < PRUNE_MAX_BATCHES; batch += 1) {
		const page = await visits.query({
			where: { day: { lt: cutoff } },
			orderBy: { day: "asc" },
			limit: PRUNE_BATCH,
		});
		if (page.items.length === 0) break;
		removed += await visits.deleteMany(page.items.map((item) => item.id));
		if (!page.hasMore && page.items.length < PRUNE_BATCH) break;
	}
	return removed;
}

export { PRUNE_TASK };
