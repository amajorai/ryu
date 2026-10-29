import { expect, test } from "bun:test";
import {
	calendarViewLabel,
	formatCalendarDate,
	weekdayLabels,
} from "./date-labels.ts";

test("weekday labels follow the locale, Sunday first", () => {
	expect(weekdayLabels("en-US")).toEqual([
		"Sun",
		"Mon",
		"Tue",
		"Wed",
		"Thu",
		"Fri",
		"Sat",
	]);
	const french = weekdayLabels("fr");
	expect(french).toHaveLength(7);
	expect(french[0]).toBe("dim.");
});

test("dates format through Intl in the active locale", () => {
	const day = new Date(2026, 2, 9);
	expect(formatCalendarDate(day, "longDate", "en-US")).toBe("March 9, 2026");
	expect(formatCalendarDate(day, "weekday", "de")).toBe("Montag");
	expect(formatCalendarDate(day, "dayOfMonth", "en-US")).toBe("9");
});

test("view labels localize month names", () => {
	const cursor = new Date(2026, 2, 9);
	expect(calendarViewLabel("month", cursor, 30, "en-US")).toBe("March 2026");
	expect(calendarViewLabel("month", cursor, 30, "es")).toContain("marzo");
	expect(calendarViewLabel("week", cursor, 30, "en-US")).toContain("Mar");
});

test("an invalid locale falls back to the runtime default", () => {
	expect(weekdayLabels("not a locale!")).toHaveLength(7);
});
