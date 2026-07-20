// apps/desktop/src/lib/calendar/views.ts
//
// View-mode helpers for the Calendar page. The page can show the same scheduled
// runs through four lenses — Month, Week, Day, and Agenda — modelled on the
// origin-space/event-calendar component. Each helper here is pure: given a view
// and the current cursor date it returns the event-fetch window, the day columns
// to render, the toolbar label, and how prev/next/today move the cursor.
//
// Windows are returned half-open as `[start, end)` so they line up directly with
// `buildCalendarEvents(jobs, start, end)` in `./events`.

import {
	addDays,
	addMonths,
	addWeeks,
	endOfMonth,
	endOfWeek,
	format,
	startOfDay,
	startOfMonth,
	startOfWeek,
	subDays,
	subMonths,
	subWeeks,
} from "date-fns";

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

/** The `[start, end)` window of events a view needs for the given cursor. */
export function viewRange(view: CalendarView, cursor: Date): ViewRange {
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
 * The day columns a view renders. Month returns its 6-week (42-cell) grid,
 * Week returns 7 days, Day returns 1, and Agenda returns its full span (so the
 * list can iterate day-by-day and skip empty ones).
 */
export function viewDays(view: CalendarView, cursor: Date): Date[] {
	const { start, end } = viewRange(view, cursor);
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

/** Toolbar label describing the visible period for the current view. */
export function viewLabel(view: CalendarView, cursor: Date): string {
	switch (view) {
		case "month":
			return format(cursor, "MMMM yyyy");
		case "week": {
			const start = startOfWeek(cursor);
			const end = endOfWeek(cursor);
			const sameMonth = start.getMonth() === end.getMonth();
			const sameYear = start.getFullYear() === end.getFullYear();
			if (sameMonth) {
				return `${format(start, "MMM d")} – ${format(end, "d, yyyy")}`;
			}
			if (sameYear) {
				return `${format(start, "MMM d")} – ${format(end, "MMM d, yyyy")}`;
			}
			return `${format(start, "MMM d, yyyy")} – ${format(end, "MMM d, yyyy")}`;
		}
		case "day":
			return format(cursor, "EEEE, MMMM d, yyyy");
		case "agenda": {
			const start = startOfDay(cursor);
			const end = addDays(start, AGENDA_DAYS - 1);
			return `${format(start, "MMM d")} – ${format(end, "MMM d, yyyy")}`;
		}
		default:
			return format(cursor, "MMMM yyyy");
	}
}
