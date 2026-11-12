/**
 * Public routes always see `ctx.user === null`, so "is an editor browsing?" has to be asked of
 * the auth API. Only a signed-in browser carries the `astro-session` cookie, so anonymous
 * visitors never trigger the lookup. Fails open: if the check errors the hit is counted.
 */
const verdicts = new Map<string, { at: number; signedIn: boolean }>();

export async function isSignedIn(request: Request): Promise<boolean> {
	const cookie = request.headers.get("cookie") ?? "";
	const match = /(?:^|;\s*)astro-session=([^;]+)/.exec(cookie);
	if (!match) return false;
	const token = match[1]!;
	const hit = verdicts.get(token);
	if (hit && Date.now() - hit.at < 60_000) return hit.signedIn;
	try {
		const res = await fetch(new URL("/_emdash/api/auth/me", request.url), {
			headers: { cookie, "x-emdash-request": "1" },
			signal: AbortSignal.timeout(1_500),
		});
		const signedIn = res.status === 200;
		if (verdicts.size > 200) verdicts.clear();
		verdicts.set(token, { at: Date.now(), signedIn });
		return signedIn;
	} catch {
		return false;
	}
}
