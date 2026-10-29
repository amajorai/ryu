// apps/desktop/src/lib/calendar/date-labels.ts
//
// Locale-aware labels for the Calendar page. Day columns are local-midnight
// civil dates (see display-days.ts), so Intl formats them without a timeZone
// option. `locale` is the active i18n locale; undefined uses the runtime
// default.

import { addDays, endOfWeek, startOfDay, startOfWeek } from "date-fns";

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
// 2000-01-02 was a Sunday; the month grid starts its weeks on Sunday.
const FIRST_SUNDAY = new Date(2000, 0, 2);

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

/** Sunday-first short weekday names for the month grid header. */
export function weekdayLabels(locale?: string): string[] {
	const format = formatter(locale, PRESETS.weekdayShort);
	return Array.from({ length: 7 }, (_, index) =>
		format.format(addDays(FIRST_SUNDAY, index))
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
	locale?: string
): string {
	switch (view) {
		case "week":
			return formatRange(startOfWeek(cursor), endOfWeek(cursor), locale);
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
