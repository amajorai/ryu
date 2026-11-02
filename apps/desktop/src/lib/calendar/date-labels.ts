// apps/desktop/src/lib/calendar/date-labels.ts
//
// Locale-aware labels for the Calendar page. Day columns are local-midnight
// civil dates (see display-days.ts), so Intl formats them without a timeZone
// option. `locale` is the active i18n locale; undefined uses the runtime
// default. Weeks start on the locale's own first day (Monday in German,
// Saturday in Arabic, Sunday in US English), read from Intl week data.

import { activeLocale } from "@ryu/i18n/core";
import { type WeekStart, weekStartForLocale } from "@ryu/i18n/format-intl";
import { addDays, endOfWeek, startOfDay, startOfWeek } from "date-fns";

export type { WeekStart } from "@ryu/i18n/format-intl";

export type CalendarDatePreset =
	| "dayOfMonth"
	| "fullDate"
	| "longDate"
	| "weekday"
	| "weekdayShort";

const PRESETS: Record<CalendarDatePreset, Intl.DateTimeFormatOptions> = {
	dayOfMonth: { day: "numeric" },
	fullDate: { weekday: "long", month: "long", day: "numeric", year: "numeric" },
	longDate: { month: "long", day: "numeric", year: "numeric" },
	weekday: { weekday: "long" },
	weekdayShort: { weekday: "short" },
};

const SHORT_RANGE: Intl.DateTimeFormatOptions = {
	month: "short",
	day: "numeric",
	year: "numeric",
};
const MONTH_YEAR: Intl.DateTimeFormatOptions = {
	month: "long",
	year: "numeric",
};
// 2000-01-02 was a Sunday; adding a week start (0 = Sunday) lands on that day.
const FIRST_SUNDAY = new Date(2000, 0, 2);

/**
 * The first day of the calendar week for `locale` (default: the formatting
 * locale the UI shows, so a regional tag such as `en-GB` counts). Sunday when
 * the engine has no week data.
 */
export function calendarWeekStart(locale?: string): WeekStart {
	return weekStartForLocale(locale ?? activeLocale()) ?? 0;
}

function formatter(
	locale: string | undefined,
	options: Intl.DateTimeFormatOptions
): Intl.DateTimeFormat {
	try {
		return new Intl.DateTimeFormat(locale, options);
	} catch {
		return new Intl.DateTimeFormat(undefined, options);
	}
}

export function formatCalendarDate(
	day: Date,
	preset: CalendarDatePreset,
	locale?: string
): string {
	return formatter(locale, PRESETS[preset]).format(day);
}

/**
 * Short weekday names for the month grid header, starting on `weekStartsOn`
 * (default: the UI locale's first day of the week, as the grid itself).
 */
export function weekdayLabels(
	locale?: string,
	weekStartsOn: WeekStart = calendarWeekStart()
): string[] {
	const format = formatter(locale, PRESETS.weekdayShort);
	return Array.from({ length: 7 }, (_, index) =>
		format.format(addDays(FIRST_SUNDAY, weekStartsOn + index))
	);
}

function formatRange(start: Date, end: Date, locale?: string): string {
	return formatter(locale, SHORT_RANGE).formatRange(start, end);
}

/** Header label for the active calendar view. */
export function calendarViewLabel(
	view: "agenda" | "day" | "month" | "week",
	cursor: Date,
	agendaDays: number,
	locale?: string,
	weekStartsOn: WeekStart = calendarWeekStart()
): string {
	switch (view) {
		case "week":
			return formatRange(
				startOfWeek(cursor, { weekStartsOn }),
				endOfWeek(cursor, { weekStartsOn }),
				locale
			);
		case "day":
			return formatCalendarDate(cursor, "fullDate", locale);
		case "agenda": {
			const start = startOfDay(cursor);
			return formatRange(start, addDays(start, agendaDays - 1), locale);
		}
		default:
			return formatter(locale, MONTH_YEAR).format(cursor);
	}
}
