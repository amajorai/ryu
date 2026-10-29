// The usage dashboard's date range, in civil days of the display time zone.
//
// A `UsageDateRange` is two instants, `[from, to)`: the first instant of the
// first day and the first instant of the day after the last. The date picker
// works in day columns (local-midnight `Date`s carrying a civil year, month and
// day), so these helpers convert between the two through the shared
// display-zone helpers. Nothing here reads the `Date` getters on an instant,
// which would answer in the computer's zone rather than the person's.

import {
	displayCivilDay,
	displayDayStart,
} from "@ryu/ui/lib/display-civil-day.ts";
import type { UsageDateRange } from "./usage-analytics.ts";

function addCivilDays(day: Date, days: number): Date {
	const next = new Date(day);
	next.setDate(next.getDate() + days);
	return next;
}

/** The last `days` civil days ending on today in the display zone, today included. */
export function usagePresetRange(
	days: number,
	now: number = Date.now()
): UsageDateRange {
	const today = displayCivilDay(now);
	return {
		from: displayDayStart(addCivilDays(today, -days + 1)),
		to: displayDayStart(addCivilDays(today, 1)),
	};
}

/** The first and last civil day a range covers, as the picker's day columns. */
export function usageRangeDays(range: UsageDateRange): {
	from: Date;
	to: Date;
} {
	return {
		from: displayCivilDay(range.from),
		to: displayCivilDay(range.to.getTime() - 1),
	};
}

/** The range covering the picked civil days, both included; a lone day is one day. */
export function usageRangeFromDays(from: Date, to?: Date): UsageDateRange {
	return {
		from: displayDayStart(from),
		to: displayDayStart(addCivilDays(to ?? from, 1)),
	};
}
