export interface SearchEngine {
	/** Display name, also the dimension value. */
	name: string;
	/** Matches the bare host (no `www.`). */
	host: RegExp;
	/** Query-string parameters that may carry the search words, in priority order. */
	params: string[];
}

export const SEARCH_ENGINES: SearchEngine[] = [
	{ name: "Google", host: /(^|\.)google\.[a-z.]{2,6}$/, params: ["q"] },
	{ name: "Bing", host: /(^|\.)bing\.com$/, params: ["q"] },
	{ name: "DuckDuckGo", host: /(^|\.)duckduckgo\.com$/, params: ["q"] },
	{ name: "Baidu", host: /(^|\.)baidu\.com$/, params: ["wd", "word"] },
	{ name: "Yahoo", host: /(^|\.)search\.yahoo\.[a-z.]{2,6}$/, params: ["p", "q"] },
	{ name: "Yandex", host: /(^|\.)(yandex\.[a-z.]{2,6}|ya\.ru)$/, params: ["text"] },
	{ name: "Ecosia", host: /(^|\.)ecosia\.org$/, params: ["q"] },
	{ name: "Naver", host: /(^|\.)search\.naver\.com$/, params: ["query"] },
	{ name: "Brave", host: /(^|\.)search\.brave\.com$/, params: ["q"] },
	{ name: "Startpage", host: /(^|\.)startpage\.com$/, params: ["query", "q"] },
	{ name: "Qwant", host: /(^|\.)qwant\.com$/, params: ["q"] },
	{ name: "Sogou", host: /(^|\.)sogou\.com$/, params: ["query"] },
	{ name: "360 Search", host: /(^|\.)so\.com$/, params: ["q"] },
	{ name: "Seznam", host: /(^|\.)seznam\.cz$/, params: ["q"] },
	{ name: "Ask", host: /(^|\.)ask\.com$/, params: ["q"] },
	{ name: "AOL", host: /(^|\.)search\.aol\.com$/, params: ["q", "query"] },
];
