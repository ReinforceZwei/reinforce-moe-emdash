import { normalisePath } from "./path.ts";

/**
 * A page key names what was viewed. Content is `<collection>:<id>`; everything else the site
 * renders is a fixed shape. Keys are baked into the beacon at render time, so the counting
 * route never has to turn a slug into an id.
 */
const KEY = /^(home|blog|[a-z][a-z0-9_]{0,39}:[A-Za-z0-9_-]{1,40}|term:(category|tag):[^\s|]{1,100})$/;

export function isPageKey(value: unknown): value is string {
	return typeof value === "string" && KEY.test(value);
}

export function pageKeyForRender(page: {
	path: string;
	content?: { collection: string; id: string } | null;
}): string | null {
	if (page.content) {
		const key = `${page.content.collection}:${page.content.id}`;
		return isPageKey(key) ? key : null;
	}
	const path = normalisePath(page.path);
	if (path === "/") return "home";
	if (path === "/blog") return "blog";
	const term = /^\/(category|tag)\/([^/]+)$/.exec(path);
	if (term) {
		const key = `term:${term[1]}:${term[2]}`;
		return isPageKey(key) ? key : null;
	}
	return null;
}
