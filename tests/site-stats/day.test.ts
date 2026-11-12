import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, dayKey, dayRange, dayToTs, isValidTimeZone } from "../../src/plugins/site-stats/lib/day.ts";

test("dayKey buckets by the configured timezone", () => {
	const at = new Date("2026-11-11T16:30:00Z");
	assert.equal(dayKey(at, "Asia/Hong_Kong"), "2026-11-12");
	assert.equal(dayKey(at, "UTC"), "2026-11-11");
});

test("dayKey falls back to UTC for an invalid timezone", () => {
	assert.equal(dayKey(new Date("2026-11-11T16:30:00Z"), "Not/AZone"), "2026-11-11");
	assert.equal(isValidTimeZone("Not/AZone"), false);
	assert.equal(isValidTimeZone("Asia/Hong_Kong"), true);
});

test("addDays and dayRange are inclusive and cross month/year edges", () => {
	assert.equal(addDays("2026-12-31", 1), "2027-01-01");
	assert.equal(addDays("2026-03-01", -1), "2026-02-28");
	assert.deepEqual(dayRange("2026-11-01", "2026-11-03"), ["2026-11-01", "2026-11-02", "2026-11-03"]);
	assert.equal(dayToTs("1970-01-02"), 86_400_000);
});
