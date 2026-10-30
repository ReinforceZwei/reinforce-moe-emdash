/**
 * Keeps responses the route cache must not store out of it.
 *
 * `routeRules` match by path only, so a rule cannot know what the route decided about a
 * particular response. Astro's memory provider stores any `GET` whose `CDN-Cache-Control`
 * carries a positive `max-age`, whatever its status — so without this, a single 304, 404 or
 * 500 could be handed to every later visitor of that URL for the whole TTL:
 *
 *   - 304 (conditional request from a returning visitor). Stored, it would be replayed to
 *     clients that hold no copy, i.e. an empty body for every first-time visitor.
 *   - 404 for a slug that does not exist yet, which a later publish then has to invalidate.
 *   - 500 from a transient failure, pinned for the TTL.
 *
 * The second check respects the response's own instructions. EmDash's image endpoint serves
 * media that `Replace original` may overwrite with `Cache-Control: public, max-age=0,
 * must-revalidate`, and that header means the bytes must not be reused without checking the
 * origin. The route rule for `/_image` is deliberately long-lived for content-addressed
 * transforms, so this is what keeps a replaced original from being served stale for a week.
 * EmDash's own middleware already opts out authenticated users and `private`/`no-store`
 * responses; `no-cache` is intentionally *not* matched here — EmDash sets it on pages that
 * carry a validator, and those are exactly the responses worth caching.
 */
import { defineMiddleware } from "astro:middleware";

/** `max-age=0` or `must-revalidate` anywhere in Cache-Control, on either token boundary. */
const REVALIDATE_ONLY_RE = /(?:^|,)\s*(?:max-age=0|must-revalidate)\b/i;

export const onRequest = defineMiddleware(async (context, next) => {
	const response = await next();

	if (response.status !== 200 || REVALIDATE_ONLY_RE.test(response.headers.get("cache-control") ?? "")) {
		context.cache.set(false);
	}

	return response;
});
