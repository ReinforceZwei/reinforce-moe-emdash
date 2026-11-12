import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUa } from "../../src/plugins/site-stats/lib/ua.ts";
import { isBotUa } from "../../src/plugins/site-stats/lib/bots.ts";

const CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const SAFARI_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const FIREFOX_ANDROID = "Mozilla/5.0 (Android 14; Mobile; rv:128.0) Gecko/128.0 Firefox/128.0";

test("parseUa returns coarse names", () => {
	assert.deepEqual(parseUa(CHROME_WIN), { browser: "Chrome", os: "Windows", device: "desktop" });
	assert.deepEqual(parseUa(SAFARI_IOS), { browser: "Safari", os: "iOS", device: "mobile" });
	assert.deepEqual(parseUa(FIREFOX_ANDROID), { browser: "Firefox", os: "Android", device: "mobile" });
	assert.equal(parseUa("zzz").browser, "Other");
});

test("isBotUa catches crawlers, scripts and headless browsers but not people", () => {
	for (const ua of [
		"Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
		"Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
		"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/151.0.7922.34 Safari/537.36",
		"curl/8.18.0",
		"python-requests/2.31.0",
		"",
	]) assert.equal(isBotUa(ua), true, ua);
	assert.equal(isBotUa(CHROME_WIN), false);
	assert.equal(isBotUa(SAFARI_IOS), false);
});
