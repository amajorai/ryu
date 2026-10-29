// apps/desktop/src/lib/calendar/views.ts
//
// View-mode helpers for the Calendar page. The page can show the same scheduled
// runs through four lenses — Month, Week, Day, and Agenda — modelled on the
// origin-space/event-calendar component. Each helper here is pure: given a view
// and the current cursor date it returns the event-fetch window, the day columns
// to render, the toolbar label, and how prev/next/today move the cursor.
//
// Windows are returned half-open as `[start, end)` so they line up directly with
// `buildCalendarEvents(jobs, start, end)` in `./events`. The cursor and the day
// columns are civil dates (local-midnight `Date`s carrying only year, month and
// day); the fetch window is the instants those dates begin at in the display
// time zone, so a run is fetched for the day it is filed under.

import {
	addDays,
	addMonths,
	addWeeks,
	endOfMonth,
	endOfWeek,
	startOfDay,
	startOfMonth,
	startOfWeek,
	subDays,
	subMonths,
	subWeeks,
} from "date-fns";
import { calendarViewLabel } from "@/src/lib/calendar/date-labels.ts";
import { displayDayStart } from "@/src/lib/calendar/display-days.ts";

export type CalendarView = "month" | "week" | "day" | "agenda";

export const CALENDAR_VIEWS: { value: CalendarView; label: string }[] = [
	{ value: "month", label: "Month" },
	{ value: "week", label: "Week" },
	{ value: "day", label: "Day" },
	{ value: "agenda", label: "Agenda" },
];

/** How many days forward the Agenda view spans from the cursor. */
export const AGENDA_DAYS = 30;

export interface ViewRange {
	/** Exclusive end instant of the fetch window. */
	end: Date;
	/** Inclusive start instant of the fetch window. */
	start: Date;
}

/** The `[start, end)` civil dates a view shows for the given cursor. */
function civilRange(view: CalendarView, cursor: Date): ViewRange {
	switch (view) {
		case "month": {
			const start = startOfWeek(startOfMonth(cursor));
			// endOfWeek/endOfMonth land on 23:59:59.999; normalise to midnight so
			// the half-open end is exactly the day after the grid's last day (the
			// grid stays a whole number of weeks, e.g. 35 cells, not 36).
			const end = addDays(startOfDay(endOfWeek(endOfMonth(cursor))), 1);
			return { start, end };
		}
		case "week": {
			const start = startOfWeek(cursor);
			return { start, end: addDays(start, 7) };
		}
		case "day": {
			const start = startOfDay(cursor);
			return { start, end: addDays(start, 1) };
		}
		case "agenda": {
			const start = startOfDay(cursor);
			return { start, end: addDays(start, AGENDA_DAYS) };
		}
		default:
			return { start: startOfDay(cursor), end: addDays(startOfDay(cursor), 1) };
	}
}

/**
 * The `[start, end)` window of events a view needs for the given cursor: the
 * display-zone instants at which its first and last-plus-one civil days begin.
 */
export function viewRange(view: CalendarView, cursor: Date): ViewRange {
	const { start, end } = civilRange(view, cursor);
	return { start: displayDayStart(start), end: displayDayStart(end) };
}

/**
 * The day columns a view renders. Month returns its 6-week (42-cell) grid,
 * Week returns 7 days, Day returns 1, and Agenda returns its full span (so the
 * list can iterate day-by-day and skip empty ones).
 */
export function viewDays(view: CalendarView, cursor: Date): Date[] {
	const { start, end } = civilRange(view, cursor);
	const days: Date[] = [];
	for (let d = start; d < end; d = addDays(d, 1)) {
		days.push(d);
	}
	return days;
}

/** Move the cursor one period in `direction` (-1 = back, 1 = forward). */
export function navigate(
	view: CalendarView,
	cursor: Date,
	direction: -1 | 1
): Date {
	const back = direction < 0;
	switch (view) {
		case "month":
			return back ? subMonths(cursor, 1) : addMonths(cursor, 1);
		case "week":
			return back ? subWeeks(cursor, 1) : addWeeks(cursor, 1);
		case "day":
			return back ? subDays(cursor, 1) : addDays(cursor, 1);
		case "agenda":
			return back ? subDays(cursor, AGENDA_DAYS) : addDays(cursor, AGENDA_DAYS);
		default:
			return cursor;
	}
}

/** Toolbar label describing the visible period for the current view, in
 * `locale` (the active i18n locale) through Intl. */
export function viewLabel(
	view: CalendarView,
	cursor: Date,
	locale?: string
): string {
	return calendarViewLabel(view, cursor, AGENDA_DAYS, locale);
}
