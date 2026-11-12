import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyReferrer } from "../../src/plugins/site-stats/lib/referrer.ts";

const HOSTS = ["reinforce.moe"];

test("empty, garbage and non-http referrers are direct", () => {
	assert.deepEqual(classifyReferrer("", HOSTS), { channel: "direct" });
	assert.deepEqual(classifyReferrer("not a url", HOSTS), { channel: "direct" });
	assert.deepEqual(classifyReferrer("android-app://com.google.android.gm", HOSTS), { channel: "direct" });
});

test("own hosts (with or without www) are internal", () => {
	assert.equal(classifyReferrer("https://reinforce.moe/blog/x", HOSTS).channel, "internal");
	assert.equal(classifyReferrer("https://www.reinforce.moe/", HOSTS).channel, "internal");
});

test("search engines yield engine and normalised words", () => {
	assert.deepEqual(classifyReferrer("https://www.google.com/search?q=Hello++World", HOSTS), {
		channel: "search", host: "google.com", engine: "Google", words: "hello world",
	});
	assert.equal(classifyReferrer("https://www.google.com.hk/", HOSTS).engine, "Google");
	assert.equal(classifyReferrer("https://www.google.com/", HOSTS).words, undefined);
	assert.equal(classifyReferrer("https://www.baidu.com/s?wd=%E4%BD%A0%E5%A5%BD", HOSTS).words, "你好");
	assert.equal(classifyReferrer("https://search.yahoo.com/search?p=cats", HOSTS).words, "cats");
	assert.equal(classifyReferrer("https://yandex.ru/search/?text=cats", HOSTS).engine, "Yandex");
	assert.equal(classifyReferrer("https://duckduckgo.com/?q=cats", HOSTS).engine, "DuckDuckGo");
	assert.equal(classifyReferrer("https://www.bing.com/search?q=cats", HOSTS).engine, "Bing");
	assert.equal(classifyReferrer("https://search.naver.com/search.naver?query=cats", HOSTS).words, "cats");
	assert.equal(classifyReferrer("https://search.brave.com/search?q=cats", HOSTS).engine, "Brave");
	assert.equal(classifyReferrer("https://www.ecosia.org/search?q=cats", HOSTS).engine, "Ecosia");
});

test("words that are URLs are dropped and long words are capped", () => {
	assert.equal(classifyReferrer("https://www.google.com/search?q=https://evil.example/x", HOSTS).words, undefined);
	assert.equal(classifyReferrer(`https://www.google.com/search?q=${"a".repeat(300)}`, HOSTS).words?.length, 100);
});

test("any other host is a referral", () => {
	assert.deepEqual(classifyReferrer("https://t.co/abc", HOSTS), { channel: "referral", host: "t.co" });
	assert.equal(classifyReferrer("https://notgoogle.example/search?q=x", HOSTS).channel, "referral");
});
