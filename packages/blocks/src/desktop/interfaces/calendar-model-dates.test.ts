import { afterEach, describe, expect, test } from "bun:test";
// The provider registers its runtime here; a test registers a stand-in.
import {
	registerActiveI18nRuntime,
	unregisterActiveI18nRuntime,
} from "../../../../i18n/src/active-locale.ts";
import {
	monthGridDays,
	startOfWeek,
	weekDays,
	weekStart,
} from "./calendar-model-dates.ts";
import { moveDayKey } from "./calendar-model-layout.ts";

function runtime(locale: string) {
	return {
		direction: "ltr" as const,
		locale,
		translate: (_id: string, _values?: unknown, fallback?: string) =>
			fallback ?? _id,
	};
}

const german = runtime("de");
const american = runtime("en-US");

afterEach(() => {
	unregisterActiveI18nRuntime(german);
	unregisterActiveI18nRuntime(american);
});

// Wednesday, 14 January 2026.
const WEDNESDAY = new Date(2026, 0, 14);

describe("calendar week start", () => {
	test("follows the locale's week data", () => {
		expect(weekStart("en-US")).toBe(0);
		expect(weekStart("de")).toBe(1);
	});

	test("en-US weeks start on Sunday", () => {
		registerActiveI18nRuntime(american);
		expect(startOfWeek(WEDNESDAY).getDate()).toBe(11);
		expect(weekDays(WEDNESDAY)[0]?.getDay()).toBe(0);
	});

	test("German weeks and the month grid start on Monday", () => {
		registerActiveI18nRuntime(german);
		expect(startOfWeek(WEDNESDAY).getDate()).toBe(12);
		expect(weekDays(WEDNESDAY).map((day) => day.getDay())).toEqual([
			1, 2, 3, 4, 5, 6, 0,
		]);
		expect(monthGridDays(WEDNESDAY)[0]?.getDay()).toBe(1);
	});

	test("Home and End go to the locale's week ends", () => {
		registerActiveI18nRuntime(german);
		expect(moveDayKey("2026-01-14", "Home", "week")).toBe("2026-01-12");
		expect(moveDayKey("2026-01-14", "End", "week")).toBe("2026-01-18");
	});
});
