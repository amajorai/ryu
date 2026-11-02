import { expect, test } from "bun:test";
import {
	calendarViewLabel,
	calendarWeekStart,
	formatCalendarDate,
	weekdayLabels,
} from "./date-labels.ts";
import { viewDays } from "./views.ts";

const hasWeekData = Boolean(
	typeof Reflect.get(new Intl.Locale("de"), "getWeekInfo") === "function" ||
		Reflect.get(new Intl.Locale("de"), "weekInfo")
);

test("weekday labels follow the locale, Sunday first", () => {
	expect(weekdayLabels("en-US", 0)).toEqual([
		"Sun",
		"Mon",
		"Tue",
		"Wed",
		"Thu",
		"Fri",
		"Sat",
	]);
	const french = weekdayLabels("fr", 0);
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

test("weeks start on the locale's first day", () => {
	if (!hasWeekData) {
		expect(calendarWeekStart("de")).toBe(0);
		return;
	}
	expect(calendarWeekStart("de")).toBe(1);
	expect(calendarWeekStart("ar")).toBe(6);
	expect(calendarWeekStart("en-US")).toBe(0);
	expect(weekdayLabels("de", calendarWeekStart("de"))[0]).toBe(
		formatCalendarDate(new Date(2026, 5, 8), "weekdayShort", "de")
	);
	expect(weekdayLabels("en-US", calendarWeekStart("en-US"))[0]).toBe("Sun");
});

test("month and week grids begin on the given week start", () => {
	const cursor = new Date(2026, 5, 11); // Thursday June 11, 2026
	const monday = viewDays("month", cursor, 1);
	expect(monday[0]?.getDay()).toBe(1);
	expect(monday.length % 7).toBe(0);
	expect(monday[0]?.getDate()).toBe(1); // June 1 is a Monday
	const saturday = viewDays("week", cursor, 6);
	expect(saturday).toHaveLength(7);
	expect(saturday[0]?.getDay()).toBe(6);
	expect(saturday[0]?.getDate()).toBe(6);
	expect(viewDays("week", cursor, 0)[0]?.getDay()).toBe(0);
	expect(calendarViewLabel("week", cursor, 30, "en-US", 1)).toContain("Jun 8");
});
