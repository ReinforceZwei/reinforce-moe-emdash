/**
 * Outer middleware, wired through `emdash({ middleware: { outer: … } })`.
 *
 * EmDash's own redirect table (`_emdash_redirects`) cannot target another host: its
 * `destination` must be a single-slash site-relative path, and the runtime skips any rule
 * whose destination is not one (`isSiteRelativeDestination`). So an external 301 has to be
 * served from here — this module runs before EmDash initialises its runtime and database,
 * which makes it free for cached paths and safe to keep rules that never touch the DB.
 *
 * /anone moved to GitHub Pages. The exact path stays a real page ("this moved, here is the
 * new link"); everything below it — flippin_platelet.js, wombat.js and the rest of the
 * assets, which old bookmarklets still point at — is redirected.
 */
import type { APIContext, MiddlewareNext } from "astro";

const MOVED_PREFIX = "/anone";
const MOVED_TO = "https://reinforcezwei.github.io/flippin-platelet";

export async function onRequest(context: APIContext, next: MiddlewareNext): Promise<Response> {
	const { pathname, search } = context.url;

	// The landing page at /anone (and its trailing-slash spelling) still renders.
	if (pathname === MOVED_PREFIX || pathname === `${MOVED_PREFIX}/`) {
		return next();
	}

	// /anone/<asset> -> https://…/flippin-platelet/<asset>, keeping the query string.
	if (pathname.startsWith(`${MOVED_PREFIX}/`)) {
		const rest = pathname.slice(MOVED_PREFIX.length);
		return context.redirect(`${MOVED_TO}${rest}${search}`, 301);
	}

	return next();
}
