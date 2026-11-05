import { describe, expect, test } from "bun:test";
import { formatPeakDay } from "./profile-settings-peak-day.ts";

describe("formatPeakDay", () => {
	test("formats the UTC day as a localized weekday and date", () => {
		expect(formatPeakDay("2026-03-14", "en")).toBe("Sat, Mar 14, 2026");
		const japanese = formatPeakDay("2026-03-14", "ja");
		expect(japanese).toContain("2026");
		expect(japanese).toContain("土");
		expect(japanese).not.toContain("2026-03-14");
	});

	test("does not shift the day in a timezone west of UTC", () => {
		expect(formatPeakDay("2026-01-01", "en")).toBe("Thu, Jan 1, 2026");
	});

	test("returns a value that is not an ISO day unchanged", () => {
		expect(formatPeakDay("yesterday", "de")).toBe("yesterday");
	});
});
