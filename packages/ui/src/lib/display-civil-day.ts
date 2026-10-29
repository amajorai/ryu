// A civil day in the display time zone, as a calendar control sees it.
//
// A date picker (react-day-picker, date-fns) steps and labels plain `Date`s
// whose local year, month and day are the civil date, so a day column is a
// local-midnight `Date` carrying only those three fields. The instants a
// view stores or queries (a run's start, the start of a usage range) are placed
// against those columns through the shared display-zone helpers here, never
// through the `Date` getters, which answer in the machine's zone.

import {
	displayWallClock,
	startOfDisplayCivilDayMs,
} from "@ryu/ui/lib/timezone.ts";

/** The civil day, as a column `Date`, that an instant falls on in the display zone. */
export function displayCivilDay(at: Date | number): Date {
	const { year, month, day } = displayWallClock(at);
	const column = new Date(0);
	column.setFullYear(year, month - 1, day);
	column.setHours(0, 0, 0, 0);
	return column;
}

/** First instant of a day column's civil date in the display zone. */
export function displayDayStart(day: Date): Date {
	return new Date(
		startOfDisplayCivilDayMs(
			day.getFullYear(),
			day.getMonth() + 1,
			day.getDate()
		)
	);
}
