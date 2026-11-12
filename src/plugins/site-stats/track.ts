import { z } from "zod";
import { pruneSeen, recordHit } from "./counters.ts";
import { dayKey } from "./lib/day.ts";
import { isBotUa } from "./lib/bots.ts";
import { visitorKey } from "./lib/hash.ts";
import { isExcluded, normalisePath } from "./lib/path.ts";
import { isPageKey } from "./lib/pagekey.ts";
import { isSignedIn } from "./lib/session.ts";
import { readSettings } from "./lib/settings.ts";
import type { Env } from "./lib/types.ts";

const Body = z.object({
	k: z.string().max(200).nullable(),
	p: z.string().max(400),
	r: z.string().max(2000).optional().default(""),
});

export interface TrackInput {
	input: unknown;
	request: Request;
	ip: string | null;
	userAgent: string | null;
}

export interface TrackDeps {
	now?: () => Date;
	signedIn?: (request: Request) => Promise<boolean>;
}

let saltCache: string | null = null;
export function resetSaltCache(): void {
	saltCache = null;
}

/** `plugin:install` runs once, so a restored database would otherwise have no salt. */
async function getSalt(env: Pick<Env, "kv">): Promise<string> {
	if (saltCache) return saltCache;
	let salt = await env.kv.get<string>("state:salt");
	if (!salt) {
		await env.kv.set("state:salt", crypto.randomUUID().replaceAll("-", ""));
		salt = await env.kv.get<string>("state:salt");
	}
	saltCache = salt ?? "";
	return saltCache;
}

export async function handleTrack(
	env: Env,
	req: TrackInput,
	deps: TrackDeps = {},
): Promise<{ ok: true; skipped?: string; unique?: boolean }> {
	const parsed = Body.safeParse(req.input);
	if (!parsed.success) return { ok: true, skipped: "invalid" };
	const { k, p, r } = parsed.data;
	if (!isPageKey(k)) return { ok: true, skipped: "unresolved" };

	const ua = req.userAgent ?? "";
	if (isBotUa(ua)) return { ok: true, skipped: "bot" };
	if (!req.ip) return { ok: true, skipped: "no-ip" };

	const settings = await readSettings(env);
	if (isExcluded(normalisePath(p), settings.excludePaths)) return { ok: true, skipped: "excluded" };
	if (settings.excludeLoggedIn && (await (deps.signedIn ?? isSignedIn)(req.request))) {
		return { ok: true, skipped: "signed-in" };
	}

	const day = dayKey((deps.now ?? (() => new Date()))(), settings.timezone);
	const vkey = visitorKey(await getSalt(env), day, req.ip, ua);
	const unique = (await env.storage.seen.compareAndSet(`v:${vkey}`, null, { day })).applied;

	await recordHit(env, { day, key: k, unique, referrer: r, ua, siteHosts: settings.siteHosts });
	await pruneSeen(env, day).catch(() => 0);
	return { ok: true, unique };
}
