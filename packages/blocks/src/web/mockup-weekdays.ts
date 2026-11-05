// packages/blocks/src/web/mockup-weekdays.ts
//
// The month grid the website's Calendar mockup draws. Its weekday header was
// seven hard-coded English initials starting on Monday, so a German reader saw
// "T" for Dienstag and a US reader saw a Monday-first week. The header and the
// day cells now follow the reader's locale: its narrow weekday names and its
// first day of the week, the same rule the Calendar app's own grid uses.

import { type WeekStart, weekStartForLocale } from "@ryu/i18n/format-intl";
import { dateFormatter } from "@ryu/i18n/lite";

/** One day cell in the mockup's month grid. */
export interface MockupDayCell {
	/** Day of the month the cell shows (1-31). */
	day: number;
	/** False for the trailing/leading days of the neighbouring months. */
	inMonth: boolean;
	/** Stable React key. */
	key: string;
}

/** The weekday header and day cells for one month. */
export interface MockupMonthGrid {
	cells: MockupDayCell[];
	weekdays: string[];
}

const DAYS_PER_WEEK = 7;
/** 4 January 2026 was a Sunday; `SUNDAY + n` is weekday `n`. */
const SUNDAY_UTC = Date.UTC(2026, 0, 4);
const DAY_MS = 86_400_000;
/** date-fns' default when the engine has no week data for the locale. */
const FALLBACK_WEEK_START: WeekStart = 0;

/** Narrow weekday names ("S M T W T F S", "M D M D F S S") from `weekStart`. */
export function mockupWeekdays(
	locale: string,
	weekStart: WeekStart = weekStartForLocale(locale) ?? FALLBACK_WEEK_START
): string[] {
	const format = dateFormatter(locale, {
		timeZone: "UTC",
		weekday: "narrow",
	});
	return Array.from({ length: DAYS_PER_WEEK }, (_, index) =>
		format.format(SUNDAY_UTC + ((weekStart + index) % DAYS_PER_WEEK) * DAY_MS)
	);
}

/** A whole-weeks grid for `monthIndex` (0-based) of `year`, starting on the
 *  locale's first weekday and padded with the neighbouring months' days. */
export function mockupMonthGrid(
	locale: string,
	year: number,
	monthIndex: number
): MockupMonthGrid {
	const weekStart = weekStartForLocale(locale) ?? FALLBACK_WEEK_START;
	const firstWeekday = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
	const leading = (firstWeekday - weekStart + DAYS_PER_WEEK) % DAYS_PER_WEEK;
	const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
	const total =
		Math.ceil((leading + daysInMonth) / DAYS_PER_WEEK) * DAYS_PER_WEEK;
	const cells = Array.from({ length: total }, (_, index) => {
		const date = new Date(Date.UTC(year, monthIndex, 1 - leading + index));
		return {
			day: date.getUTCDate(),
			inMonth: date.getUTCMonth() === monthIndex,
			key: date.toISOString().slice(0, 10),
		};
	});
	return { cells, weekdays: mockupWeekdays(locale, weekStart) };
}
