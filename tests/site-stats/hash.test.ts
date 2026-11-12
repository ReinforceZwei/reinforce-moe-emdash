import { test } from "node:test";
import assert from "node:assert/strict";
import { visitorKey } from "../../src/plugins/site-stats/lib/hash.ts";

test("visitorKey is stable and depends on every input", () => {
	const base = visitorKey("salt", "2026-11-12", "203.0.113.9", "UA");
	assert.equal(base, visitorKey("salt", "2026-11-12", "203.0.113.9", "UA"));
	assert.notEqual(base, visitorKey("other", "2026-11-12", "203.0.113.9", "UA"));
	assert.notEqual(base, visitorKey("salt", "2026-11-13", "203.0.113.9", "UA"));
	assert.notEqual(base, visitorKey("salt", "2026-11-12", "203.0.113.10", "UA"));
	assert.notEqual(base, visitorKey("salt", "2026-11-12", "203.0.113.9", "UA2"));
	assert.match(base, /^[0-9a-f]{24}$/);
	assert.ok(!base.includes("203.0.113.9"));
});
