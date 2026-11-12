import { SEARCH_ENGINES } from "./engines.ts";

export type Channel = "direct" | "search" | "referral" | "internal";

export interface ReferrerInfo {
	channel: Channel;
	/** Bare lower-case host for external referrers. */
	host?: string;
	engine?: string;
	/** Normalised search words, when the engine passed them on. */
	words?: string;
}

const MAX_WORDS = 100;

function bareHost(host: string): string {
	return host.toLowerCase().replace(/^www\./, "");
}

function cleanWords(raw: string | null): string | undefined {
	if (!raw) return undefined;
	const words = raw.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
	// Engines occasionally put a URL in the query box; that is not a search phrase.
	if (!words || words.includes("://") || /^www\./.test(words)) return undefined;
	return words.slice(0, MAX_WORDS);
}

export function classifyReferrer(referrer: string, siteHosts: string[]): ReferrerInfo {
	let url: URL;
	try {
		url = new URL(referrer);
	} catch {
		return { channel: "direct" };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return { channel: "direct" };

	const host = bareHost(url.hostname);
	if (!host) return { channel: "direct" };
	if (siteHosts.some((h) => bareHost(h) === host)) return { channel: "internal" };

	for (const engine of SEARCH_ENGINES) {
		if (!engine.host.test(host)) continue;
		let words: string | null = null;
		for (const param of engine.params) {
			words = url.searchParams.get(param);
			if (words) break;
		}
		return { channel: "search", host, engine: engine.name, words: cleanWords(words) };
	}
	return { channel: "referral", host: host.slice(0, 80) };
}
