import { describe, expect, it } from "bun:test";
import { meetsMinimumAccountAge } from "./age-eligibility.ts";

const today = new Date("2026-10-06T00:00:00Z");

describe("account age calendar boundary", () => {
	it("checks the exact birthday and maximum supported age", () => {
		expect(meetsMinimumAccountAge("2013-10-06", today)).toBe(true);
		expect(meetsMinimumAccountAge("2013-10-07", today)).toBe(false);
		expect(meetsMinimumAccountAge("1906-10-06", today)).toBe(true);
		expect(meetsMinimumAccountAge("1905-10-06", today)).toBe(false);
	});
	it("rejects malformed dates and non-calendar representations", () => {
		for (const value of [
			"2000-02-30",
			"2000-2-03",
			"2000-02-03T00:00:00Z",
			null,
			undefined,
			946_684_800_000,
			{ year: 2000 },
		]) {
			expect(meetsMinimumAccountAge(value, today)).toBe(false);
		}
		expect(meetsMinimumAccountAge("2000-02-29", today)).toBe(true);
	});
});
