/**
 * The inline beacon, as a single IIFE with no dependencies.
 *
 * Rendered into the page by the `page:fragments` hook (kind `inline-script`,
 * placement `body:end`), so it is part of the cached HTML: one script tag per
 * public page, no extra request, and no theme edit.
 *
 * It cannot be a fragment *handler* that counts: public pages are route-cached
 * for 24 hours (`astro.config.mjs` routeRules), so a hook-side counter would
 * only ever see cache misses. Counting has to happen in the browser.
 *
 * Two things are baked in at render time, both site-stable:
 *   - the endpoint, as a root-relative path (host changes are a DNS concern,
 *     not a rebuild) — `ctx.url()` is not reachable from a fragment;
 *   - the entry key for content pages, taken from `page.content`, so the route
 *     never has to turn a slug into a ULID.
 *
 * `text/plain` avoids a CORS preflight; `sendBeacon` with `application/json`
 * is blocked by some browsers.
 *
 * The beacon never sends from a not-found render. `404.astro` (which is also
 * what an unknown category, tag-less slug or bad post slug rewrites to) sets
 * `window.__visitors404` before this fragment runs, so a path that only exists
 * because someone typed it wrong cannot inflate a listing count.
 */

export interface BeaconOptions {
	/** Root-relative tracking endpoint. */
	endpoint: string;
	/** `posts:<ulid>` / `pages:<ulid>` for a content page, otherwise null. */
	entryKey: string | null;
}

export function buildBeacon({ endpoint, entryKey }: BeaconOptions): string {
	// JSON.stringify, not string concatenation: the values are interpolated into
	// JavaScript source, so a quote in either one must not break out of the string.
	const endpointLiteral = JSON.stringify(endpoint);
	const keyLiteral = JSON.stringify(entryKey);

	return `(function () {
	if (window.__visitorsSent) return;
	window.__visitorsSent = true;
	if (window.__visitors404) return;
	if (document.visibilityState === "prerender") return;
	var sid = "";
	try {
		sid = sessionStorage.getItem("v_sid") || "";
		if (!sid) {
			sid = Math.random().toString(36).slice(2) + Date.now().toString(36);
			sessionStorage.setItem("v_sid", sid);
		}
	} catch (e) {}
	var body = JSON.stringify({
		p: location.pathname,
		r: document.referrer || "",
		sid: sid,
		k: ${keyLiteral}
	});
	try {
		if (navigator.sendBeacon) {
			navigator.sendBeacon(${endpointLiteral}, new Blob([body], { type: "text/plain" }));
		} else {
			fetch(${endpointLiteral}, {
				method: "POST",
				body: body,
				keepalive: true,
				headers: { "content-type": "text/plain" }
			});
		}
	} catch (e) {}
})();`;
}
