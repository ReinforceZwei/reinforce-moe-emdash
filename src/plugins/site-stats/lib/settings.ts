import { isValidTimeZone } from "./day.ts";
import type { Env } from "./types.ts";

export interface Settings {
	timezone: string;
	siteHosts: string[];
	excludePaths: string[];
	excludeLoggedIn: boolean;
}

export const SETTING_DEFAULTS = {
	timezone: "Asia/Hong_Kong",
	siteHosts: "reinforce.moe",
	excludePaths: "/_emdash\n/search",
	excludeLoggedIn: true,
} as const;

const list = (v: unknown, fallback: string): string[] =>
	String(typeof v === "string" ? v : fallback)
		.split(/[\n,]+/)
		.map((s) => s.trim())
		.filter(Boolean);

// Settings change rarely and a hit reads four of them; keep them for half a minute.
let cached: { at: number; value: Settings } | null = null;
export function resetSettingsCache(): void {
	cached = null;
}

/** Defaults live in the form schema only (they are not persisted), so apply them here too. */
export async function readSettings(env: Pick<Env, "settings">): Promise<Settings> {
	if (cached && Date.now() - cached.at < 30_000) return cached.value;
	const [tz, hosts, paths, loggedIn] = await Promise.all([
		env.settings.get<string>("timezone"),
		env.settings.get<string>("siteHosts"),
		env.settings.get<string>("excludePaths"),
		env.settings.get<boolean>("excludeLoggedIn"),
	]);
	const timezone = typeof tz === "string" && isValidTimeZone(tz) ? tz : SETTING_DEFAULTS.timezone;
	const value: Settings = {
		timezone,
		siteHosts: list(hosts, SETTING_DEFAULTS.siteHosts),
		excludePaths: list(paths, SETTING_DEFAULTS.excludePaths),
		excludeLoggedIn: typeof loggedIn === "boolean" ? loggedIn : SETTING_DEFAULTS.excludeLoggedIn,
	};
	cached = { at: Date.now(), value };
	return value;
}
