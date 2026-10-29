// apps/desktop/src/lib/calendar/display-days.ts
//
// The Calendar page's days are civil dates in the display time zone. A day
// column is a local-midnight `Date` carrying only its year, month and day (so
// date-fns can step and label it), and every instant a run happens at is
// placed against those columns through the shared display-zone helpers, never
// through the `Date` getters, which answer in the machine's zone.

import {
	displayCivilDay,
	displayDayStart,
} from "@ryu/ui/lib/display-civil-day.ts";
import {
	displayWallClock,
	formatTime,
	nextDisplayDayBoundaryMs,
	startOfDisplayDayMs,
} from "@ryu/ui/lib/timezone.ts";

// Shared with every date picker that works in display-zone civil days.
export { displayCivilDay, displayDayStart };

const EVENT_CLOCK = {
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
} as const satisfies Intl.DateTimeFormatOptions;

/** Key naming a civil day column; month is zero-based, like `Date#getMonth`. */
export function civilDayKey(day: Date): string {
	return `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
}

/** Key of the civil day an instant falls on in the display zone. */
export function displayDayKey(at: Date | number): string {
	return civilDayKey(displayCivilDay(at));
}

/** Today's civil day in the display zone, as a column `Date`. */
export function displayToday(now: number = Date.now()): Date {
	return displayCivilDay(now);
}

/** Whether a day column is today's civil date in the display zone. */
export function isDisplayToday(day: Date, now: number = Date.now()): boolean {
	return civilDayKey(day) === displayDayKey(now);
}

/** `[start, end)` instants of a day column's civil date in the display zone. */
export function displayDayBounds(day: Date): { end: Date; start: Date } {
	const start = displayDayStart(day);
	return {
		start,
		end: new Date(nextDisplayDayBoundaryMs(start.getTime())),
	};
}

/**
 * The middle of the display-zone civil day that holds an instant. Collapsed
 * run counts sit here, so they file under that day in every zone, including on
 * a 23 or 25 hour day.
 */
export function displayMidday(at: Date | number): Date {
	const ms = typeof at === "number" ? at : at.getTime();
	const start = startOfDisplayDayMs(ms);
	return new Date(start + (nextDisplayDayBoundaryMs(start) - start) / 2);
}

/** Minutes after the display zone's midnight that the clock reads at an instant. */
export function minutesIntoDisplayDay(at: Date | number): number {
	const { hour, minute } = displayWallClock(at);
	return hour * 60 + minute;
}

/** A run's start as a 24-hour clock label in the display zone and language. */
export function eventClock(at: Date): string {
	return formatTime(at, EVENT_CLOCK);
}
