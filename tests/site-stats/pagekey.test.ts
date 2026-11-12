import { test } from "node:test";
import assert from "node:assert/strict";
import { isPageKey, pageKeyForRender } from "../../src/plugins/site-stats/lib/pagekey.ts";

test("content wins, then the fixed shapes", () => {
	assert.equal(pageKeyForRender({ path: "/blog/x", content: { collection: "posts", id: "01M5Y039AP0GMRVE5NKPPN3K23" } }), "posts:01M5Y039AP0GMRVE5NKPPN3K23");
	assert.equal(pageKeyForRender({ path: "/" }), "home");
	assert.equal(pageKeyForRender({ path: "/blog/" }), "blog");
	assert.equal(pageKeyForRender({ path: "/category/%E6%97%A5%E8%A8%98" }), "term:category:日記");
	assert.equal(pageKeyForRender({ path: "/tag/x" }), "term:tag:x");
});

test("anything else is not counted", () => {
	for (const path of ["/search", "/seo-debug", "/foo/bar", "/category", "/category/a/b", "/_emdash/admin"]) {
		assert.equal(pageKeyForRender({ path }), null, path);
	}
});

test("isPageKey rejects spoofed shapes", () => {
	assert.equal(isPageKey("posts:abc"), true);
	assert.equal(isPageKey("posts:a|b"), false);
	assert.equal(isPageKey("../x"), false);
	assert.equal(isPageKey("term:category:" + "x".repeat(101)), false);
	assert.equal(isPageKey(null), false);
});
