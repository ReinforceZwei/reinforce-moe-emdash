import { test } from "node:test";
import assert from "node:assert/strict";
import { isExcluded, normalisePath } from "../../src/plugins/site-stats/lib/path.ts";

test("normalisePath strips query/hash/trailing slash and collapses slashes", () => {
	assert.equal(normalisePath("/blog/foo/?utm=1#x"), "/blog/foo");
	assert.equal(normalisePath("//a///b/"), "/a/b");
	assert.equal(normalisePath("/"), "/");
	assert.equal(normalisePath("blog"), "/blog");
});

test("normalisePath decodes percent-encoding to NFC", () => {
	assert.equal(normalisePath("/blog/%E4%BA%8C"), "/blog/二");
	assert.equal(normalisePath("/blog/%E0%A4%A"), "/blog/%E0%A4%A");
});

test("isExcluded matches on segment boundaries only", () => {
	assert.equal(isExcluded("/_emdash/admin", ["/_emdash", "/admin"]), true);
	assert.equal(isExcluded("/admin", ["/admin"]), true);
	assert.equal(isExcluded("/administrator-post", ["/admin"]), false);
	assert.equal(isExcluded("/blog", ["/"]), false);
});
