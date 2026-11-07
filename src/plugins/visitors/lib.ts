/**
 * Pure helpers for the visitors plugin.
 *
 * Nothing here touches storage or the request, so every rule that decides what
 * counts, how it is bucketed and how it is keyed is testable on its own. The
 * route, the admin queries and the verify script all import from this module,
 * which is what keeps "what the number means" in one place.
 *
 * Hashing uses Web Crypto rather than `node:crypto` so the same code would run
 * on a workerd target; the site is Node today, but there is no reason for a
 * pure helper to pin it there.
 */

export const DAY_MS = 86_400_000;

/**
 * Days roll over at 00:00 Asia/Taipei (UTC+8, no DST).
 *
 * The audience is Taiwanese, so a UTC boundary would move a post published at
 * 23:30 local into the previous day's numbers. No DST means a constant offset
 * is exact, and it avoids pulling a timezone database into the beacon path.
 */
export const DAY_OFFSET_MS = 8 * 3_600_000;

export type VisitKind = "entry" | "page" | "home" | "listing";
export type ListingType = "blog" | "tag" | "category" | "author" | "archive" | "search";
export type SourceType = "search" | "social" | "referral" | "direct";
export type DeviceType = "desktop" | "mobile" | "tablet";

/** What a request path means, before any content lookup. */
export interface PathInfo {
	kind: VisitKind | "unresolved";
	listingType: ListingType | null;
	/** Collection for `/blog/<slug>` (posts) and `/<slug>` (pages). */
	collection: "posts" | "pages" | null;
	/** Decoded slug for a single-entry path. */
	slug: string | null;
}

/** `YYYY-MM-DD` in the site's day timezone. */
export function dayKey(date: Date = new Date()): string {
	return new Date(date.getTime() + DAY_OFFSET_MS).toISOString().slice(0, 10);
}

/** Document id for the `days` collection. */
export function dayDocId(day: string): string {
	return `day:${day}`;
}

/** `YYYY-MM` for a `YYYY-MM-DD` day, used to bucket facet counters. */
export function monthOf(day: string): string {
	return day.slice(0, 7);
}

/**
 * The `count` days ending at `day` (inclusive), oldest first.
 *
 * `count` is capped so a typo in a settings value cannot ask for a decade of
 * ids; the admin only ever asks for 7/30/90/365.
 */
export function daySpan(day: string, count: number): string[] {
	const total = Math.max(1, Math.min(Math.trunc(count), 400));
	const end = Date.parse(`${day}T00:00:00.000Z`);
	const days: string[] = [];
	for (let i = total - 1; i >= 0; i -= 1) {
		days.push(new Date(end - i * DAY_MS).toISOString().slice(0, 10));
	}
	return days;
}

/** The `YYYY-MM` buckets covering `days`. */
export function monthsIn(days: readonly string[]): string[] {
	const months = new Set<string>();
	for (const day of days) months.add(monthOf(day));
	return [...months];
}

/**
 * Normalise a reported pathname into the form used for storage and matching.
 *
 * Percent-decoding matters here: post slugs are CJK, so `/blog/%E6%97%A5` and
 * `/blog/日` are the same page. NFC keeps macOS-submitted and Windows-submitted
 * forms from counting twice. Query strings are dropped because the site's
 * pagination (`?page=2`) and tracking parameters are noise, and one trailing
 * slash is stripped because `/about/` and `/about` are the same document.
 */
export function normalisePath(raw: unknown): string | null {
	if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return null;
	let path = raw.split("?")[0]?.split("#")[0] ?? "";
	if (!path.startsWith("/")) path = `/${path}`;
	try {
		path = decodeURIComponent(path);
	} catch {
		// Malformed percent-encoding: keep the raw form rather than dropping the hit.
	}
	path = path.normalize("NFC").replace(/\/{2,}/g, "/");
	if (path.length > 1) path = path.replace(/\/+$/, "");
	return path || "/";
}

const ARCHIVE_PATH = /^\/(\d{4})\/(\d{2})(\/\d{2})?(\/|$)/;

/**
 * Map a normalised path to its page kind.
 *
 * This is the site's real route table (`src/pages`), not a guess: an unknown
 * shape returns `unresolved`, and the route drops it instead of inventing a
 * bucket. A route added later stops counting until it is classified here,
 * which the verify script catches.
 */
export function classifyPath(path: string): PathInfo {
	const none: PathInfo = { kind: "unresolved", listingType: null, collection: null, slug: null };

	if (path === "/") return { kind: "home", listingType: null, collection: null, slug: null };
	if (path === "/blog") return { kind: "listing", listingType: "blog", collection: null, slug: null };
	if (path === "/search") return { kind: "listing", listingType: "search", collection: null, slug: null };

	const segments = path.split("/").filter(Boolean);

	// `/blog/<slug>` — the only post permalink this site serves.
	if (segments.length === 2 && segments[0] === "blog") {
		return { kind: "entry", listingType: null, collection: "posts", slug: segments[1] ?? null };
	}
	if (segments.length === 2 && segments[0] === "tag") {
		return { kind: "listing", listingType: "tag", collection: null, slug: null };
	}
	if (segments.length === 2 && segments[0] === "category") {
		return { kind: "listing", listingType: "category", collection: null, slug: null };
	}
	if (segments.length === 2 && segments[0] === "author") {
		return { kind: "listing", listingType: "author", collection: null, slug: null };
	}
	if (ARCHIVE_PATH.test(path)) {
		return { kind: "listing", listingType: "archive", collection: null, slug: null };
	}
	// CMS pages live at the site root, so a single segment is a page slug. The
	// caller resolves it: a slug that does not exist is `unresolved`.
	if (segments.length === 1) {
		return { kind: "page", listingType: null, collection: "pages", slug: segments[0] ?? null };
	}
	return none;
}

const BOT_PATTERN =
	/bot|crawler|spider|crawl|slurp|archiver|facebookexternalhit|embedly|quora link preview|pinterest|vkshare|w3c_validator|whatsapp|telegrambot|discordbot|google-inspectiontool|lighthouse|headlesschrome|phantomjs|python-requests|curl\/|wget\/|go-http-client|axios\/|node-fetch|preview/i;

/** User agents that are not readers. Matched before anything is written. */
export function isBot(userAgent: string): boolean {
	return userAgent.length === 0 || BOT_PATTERN.test(userAgent);
}

/** Rough device split — parity with WP Statistics, not UA parsing in depth. */
export function classifyDevice(userAgent: string): DeviceType {
	if (/ipad|tablet|playbook|silk|kindle|android(?!.*mobile)/i.test(userAgent)) return "tablet";
	if (/mobi|iphone|ipod|android|blackberry|iemobile|opera mini|windows phone/i.test(userAgent)) {
		return "mobile";
	}
	return "desktop";
}

const SEARCH_HOSTS = [
	"google.",
	"bing.com",
	"duckduckgo.com",
	"search.yahoo.",
	"yahoo.com",
	"baidu.com",
	"yandex.",
	"sogou.com",
	"so.com",
	"ecosia.org",
	"brave.com",
	"startpage.com",
	"naver.com",
	"seznam.cz",
];

const SOCIAL_HOSTS = [
	"facebook.com",
	"fb.me",
	"instagram.com",
	"twitter.com",
	"x.com",
	"t.co",
	"threads.net",
	"bsky.app",
	"reddit.com",
	"news.ycombinator.com",
	"pinterest.",
	"t.me",
	"telegram.",
	"discord.com",
	"discordapp.com",
	"mastodon.",
	"plurk.com",
	"weibo.com",
	"pixiv.net",
	"linkedin.com",
	"youtube.com",
	"youtu.be",
	"bilibili.com",
	"medium.com",
	"tumblr.com",
];

export interface ReferrerInfo {
	/** Display host, `www.` stripped. `direct` when there is no usable referrer. */
	source: string;
	sourceType: SourceType;
}

/**
 * Classify `document.referrer`.
 *
 * The `Referer` *header* on a beacon is the page's own URL, so this only ever
 * runs on the body value the script sent. Same-host referrers are internal
 * navigation and count as `direct`, matching WP Statistics: the reader did not
 * arrive from anywhere new.
 */
export function classifyReferrer(referrer: unknown, siteHost: string): ReferrerInfo {
	if (typeof referrer !== "string" || referrer.length === 0) return { source: "direct", sourceType: "direct" };
	let url: URL;
	try {
		url = new URL(referrer);
	} catch {
		return { source: "direct", sourceType: "direct" };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return { source: "direct", sourceType: "direct" };

	const host = url.hostname.toLowerCase().replace(/^www\./, "");
	const self = siteHost.toLowerCase().replace(/^www\./, "");
	if (!host || host === self) return { source: "direct", sourceType: "direct" };

	if (SEARCH_HOSTS.some((candidate) => host.includes(candidate))) return { source: host, sourceType: "search" };
	if (SOCIAL_HOSTS.some((candidate) => host.includes(candidate) || host === candidate)) {
		return { source: host, sourceType: "social" };
	}
	return { source: host, sourceType: "referral" };
}

/** `sessionStorage` id → one "visit" per tab; hashed with the day and the salt. */
export function isPlausibleSessionId(value: unknown): value is string {
	return typeof value === "string" && value.length >= 8 && value.length <= 64 && /^[a-z0-9]+$/i.test(value);
}

/** Entry keys are `${collection}:${id}`; anything else is ignored. */
export function parseEntryKey(value: unknown): { collection: "posts" | "pages"; id: string } | null {
	if (typeof value !== "string") return null;
	const match = /^(posts|pages):([A-Za-z0-9]{1,64})$/.exec(value);
	if (!match) return null;
	return { collection: match[1] as "posts" | "pages", id: match[2] as string };
}

export function entryKey(collection: string, id: string): string {
	return `${collection}:${id}`;
}

/**
 * Facet document ids must survive being used as a storage key and looked up
 * later, so everything outside `[a-z0-9._-]` becomes `_`. Two referrers that
 * collide after sanitising are the same display host in practice.
 */
export function facetValueId(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "_")
		.slice(0, 80);
}

/** SHA-256 hex, first 32 chars — a 128-bit key, plenty for a visitor hash. */
async function sha256Hex(input: string): Promise<string> {
	const bytes = new TextEncoder().encode(input);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Visitor identity for one **page** on one day.
 *
 * The path is in the hash on purpose: counting is per visitor × page × day, so
 * three posts in a day is three views and three per-post uniques. A
 * visitor-day-only key would collapse them onto the landing page and silently
 * undercount every other post.
 */
export async function visitorHash(
	day: string,
	path: string,
	ip: string,
	userAgent: string,
	salt: string,
): Promise<string> {
	return (await sha256Hex(`${day}|${path}|${ip}|${userAgent}|${salt}`)).slice(0, 32);
}

export async function sessionHash(day: string, sid: string, salt: string): Promise<string> {
	return (await sha256Hex(`${day}|${sid}|${salt}`)).slice(0, 32);
}

/** Parse the beacon body without throwing on garbage. */
export function safeJson(raw: unknown): Record<string, unknown> | null {
	if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}
