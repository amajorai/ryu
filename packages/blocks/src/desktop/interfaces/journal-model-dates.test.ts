import { afterEach, describe, expect, test } from "bun:test";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../i18n/src/active-locale.ts";
import { monthWeeks, weekdayOffset, weekOf } from "./journal-model-dates.ts";

const german = {
	direction: "ltr" as const,
	locale: "de",
	translate: (_id: string, _values?: unknown, fallback?: string) =>
		fallback ?? _id,
};

afterEach(() => {
	unregisterActiveI18nRuntime(german);
});

describe("journal weeks follow the locale's first weekday", () => {
	test("weekdayOffset counts from the locale's week start", () => {
		// Monday, 12 January 2026.
		const monday = new Date(2026, 0, 12);
		expect(weekdayOffset(monday, "en-US")).toBe(1);
		expect(weekdayOffset(monday, "de")).toBe(0);
	});

	test("English weeks start on Sunday", () => {
		expect(weekOf("2026-01-14")[0]?.getDate()).toBe(11);
		expect(monthWeeks("2026-02-10")[0]?.[0]?.getDay()).toBe(0);
	});

	test("German weeks and month rows start on Monday", () => {
		registerActiveI18nRuntime(german);
		expect(weekOf("2026-01-14").map((day) => day.getDate())).toEqual([
			12, 13, 14, 15, 16, 17, 18,
		]);
		const weeks = monthWeeks("2026-02-10");
		expect(weeks[0]?.[0]?.getDay()).toBe(1);
		// February 2026 starts on a Sunday: the last column of the first row.
		expect(weeks[0]?.[6]?.getDate()).toBe(1);
		expect(weeks).toHaveLength(5);
	});
});
