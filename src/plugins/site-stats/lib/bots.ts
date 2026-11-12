import { isbot } from "isbot";

/** `isbot` plus the generic HTTP clients and headless browsers that scripts and probes use. */
const EXTRA = /headless|phantomjs|puppeteer|playwright|selenium|lighthouse|python-requests|python-urllib|go-http-client|node-fetch|axios|libwww|java\/|okhttp|httpclient|scrapy|wget|curl\//i;

export function isBotUa(ua: string): boolean {
	if (!ua || ua.length < 10) return true;
	return isbot(ua) || EXTRA.test(ua);
}
