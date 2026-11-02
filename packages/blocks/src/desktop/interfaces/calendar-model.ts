import { activeLocale, translate as tr, unitFormatter } from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	type InterfaceEvent,
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { displayWallDate, validDate } from "./calendar-model-dates.ts";

export {
	addDays,
	addMonths,
	type CalendarScale,
	cellDayLabel,
	compactTime,
	DAY_MS,
	displayWallDate,
	hourLabel,
	longDay,
	mediumDay,
	minuteOfDay,
	monthGridDays,
	parseDayKey,
	rangeTitle,
	rangeTitleShort,
	relativeDay,
	sameMonth,
	shiftDay,
	startOfWeek,
	visibleDays,
	WEEK_START,
	weekDays,
	weekdayNames,
	weekdayShort,
} from "./calendar-model-dates.ts";

export {
	CASCADE_MINUTES,
	type DayLayout,
	DEFAULT_COLUMN_PX,
	initialScrollMinute,
	itemLength,
	layoutDay,
	MIN_TEXT_PX,
	moveDayKey,
	offscreenItems,
	type PlacedItem,
	timeZoneLabel,
	type WeekFold,
} from "./calendar-model-layout.ts";

/**
 * Pure view-model for the Calendar interface: date math for the month and
 * week ranges, the per-day agenda (threads and scheduled runs), week-grid
 * placement, and keyboard movement. No React, no DOM, so it tests directly.
 *
 * Instants enter the model through {@link displayWallDate}: a Date whose
 * local fields read the display-timezone preference's wall clock. Every
 * bucket, grid row, and label below then uses the local Date fields as usual
 * and agrees with the zone the rest of Desktop shows times in.
 */

/** Pixel height of one hour in the week grid. */
export const HOUR_PX = 72;
/**
 * Shortest duration a week block is drawn with: half an hour. A thread's
 * latest activity (or a run with no end) is drawn as this long, so every
 * block has room for its title and its time on two lines.
 */
export const MIN_BLOCK_MINUTES = 30;
/** {@link MIN_BLOCK_MINUTES} in pixels on the hour axis. */
export const MIN_BLOCK_PX = (MIN_BLOCK_MINUTES / 60) * HOUR_PX;

export interface ThreadItem {
	/** Stable across renders: `thread:<id>`. */
	key: string;
	kind: "thread";
	start: Date;
	status: ThreadStatus;
	thread: InterfaceThread;
}

export interface RunItem {
	end: Date | null;
	event: InterfaceEvent;
	/** Stable across renders: `run:<id>`. */
	key: string;
	kind: "run";
	start: Date;
}

export type CalendarItem = RunItem | ThreadItem;

/** Statuses and runs the left rail can hide, like a calendar's own list. */
export type CalendarLayer = ThreadStatus | "runs";

// ---------------------------------------------------------------------------
// Agenda
// ---------------------------------------------------------------------------

function aggregateRank(item: CalendarItem): number {
	return item.kind === "run" && (item.event.count ?? 0) > 1 ? 0 : 1;
}

export function byStart(a: CalendarItem, b: CalendarItem): number {
	return (
		a.start.getTime() - b.start.getTime() ||
		// Runs first at the same minute: the schedule fired, then the thread moved.
		Number(a.kind === "thread") - Number(b.kind === "thread") ||
		a.key.localeCompare(b.key)
	);
}

/** Every thread (at its latest activity) and run (at its start), by local day. */
export function calendarItemsByDay(
	snapshot: InterfaceSnapshot,
	hidden: ReadonlySet<CalendarLayer> = new Set()
): Map<string, CalendarItem[]> {
	const days = new Map<string, CalendarItem[]>();
	const push = (item: CalendarItem) => {
		const key = localDayKey(item.start);
		const list = days.get(key);
		if (list) {
			list.push(item);
		} else {
			days.set(key, [item]);
		}
	};
	for (const thread of snapshot.threads) {
		const start = validDate(thread.updatedAt);
		const status = threadStatus(thread);
		if (start && !hidden.has(status)) {
			push({
				key: `thread:${thread.id}`,
				kind: "thread",
				start,
				status,
				thread,
			});
		}
	}
	if (!hidden.has("runs")) {
		for (const event of snapshot.events ?? []) {
			const start = validDate(event.start);
			if (start) {
				push({
					end: validDate(event.end),
					event,
					key: `run:${event.id}`,
					kind: "run",
					start,
				});
			}
		}
	}
	for (const list of days.values()) {
		// Aggregated runs cover the whole day, so they lead it, like all-day events.
		list.sort((a, b) => aggregateRank(a) - aggregateRank(b) || byStart(a, b));
	}
	return days;
}

/** How many threads sit in each status, for the rail's layer list. */
export function statusCounts(
	threads: readonly InterfaceThread[]
): Record<ThreadStatus, number> {
	const counts: Record<ThreadStatus, number> = {
		attention: 0,
		quiet: 0,
		waiting: 0,
		working: 0,
		"your-turn": 0,
	};
	for (const thread of threads) {
		counts[threadStatus(thread)] += 1;
	}
	return counts;
}

/** Upcoming runs, soonest first, starting from now (or just before). */
export function upcomingRuns(
	events: readonly InterfaceEvent[] | undefined,
	now: Date,
	limit = 6
): RunItem[] {
	const runs: RunItem[] = [];
	for (const event of events ?? []) {
		const start = validDate(event.start);
		if (event.kind === "upcoming" && start) {
			runs.push({
				end: null,
				event,
				key: `run:${event.id}`,
				kind: "run",
				start,
			});
		}
	}
	// A run that was due a moment ago may not have been reported yet: keep it.
	const cutoff = now.getTime() - 15 * 60_000;
	return runs
		.filter((run) => run.start.getTime() >= cutoff)
		.sort(byStart)
		.slice(0, limit);
}

/** Aggregated runs stand for many runs across the day, not one moment. */
export function isAggregate(item: CalendarItem): item is RunItem {
	return item.kind === "run" && (item.event.count ?? 0) > 1;
}

export type RunOutcome = "failure" | "ran" | "scheduled" | "success";

export function runOutcome(event: InterfaceEvent): RunOutcome {
	if (event.kind === "upcoming") {
		return "scheduled";
	}
	return event.outcome ?? "ran";
}

export const RUN_OUTCOME_LABELS: Record<RunOutcome, string> = {
	failure: "Failed",
	ran: "Ran",
	scheduled: "Scheduled",
	success: "Succeeded",
};

/** A run outcome's label in the UI language, for copy that interpolates it. */
export function runOutcomeLabel(
	outcome: RunOutcome,
	tl: LiteralMessage
): string {
	switch (outcome) {
		case "failure":
			return tl("Failed");
		case "ran":
			return tl("Ran");
		case "scheduled":
			return tl("Scheduled");
		default:
			return tl("Succeeded");
	}
}

/** "2m", "1h 5m": how long a past run took, when the host knows its end. */
export function runDuration(item: RunItem): string | null {
	if (!item.end) {
		return null;
	}
	const minutes = Math.round(
		(item.end.getTime() - item.start.getTime()) / 60_000
	);
	if (minutes < 0) {
		return null;
	}
	if (minutes < 1) {
		return tr("under a minute");
	}
	const locale = activeLocale();
	const minute = (count: number) =>
		unitFormatter(locale, "minute").format(count);
	if (minutes < 60) {
		return minute(minutes);
	}
	const rest = minutes % 60;
	const hours = unitFormatter(locale, "hour").format(Math.floor(minutes / 60));
	return rest ? `${hours} ${minute(rest)}` : hours;
}

/**
 * How much a month cell wants an item in view: what needs the user first,
 * then everything else in the cell's own order.
 */
function cellRank(item: CalendarItem): number {
	if (item.kind !== "thread") {
		return 2;
	}
	if (item.status === "attention") {
		return 0;
	}
	return item.status === "your-turn" ? 1 : 2;
}

/**
 * The items a month cell shows when it has room for `capacity` rows. The
 * open thread always stays in view, then failures and threads waiting on the
 * user, then the rest by time; what is shown keeps the cell's own order, so a
 * day still reads top to bottom. The rest collapse into "+N more".
 */
export function cellItems(
	items: readonly CalendarItem[],
	capacity: number,
	activeKey: string | null
): { hidden: number; shown: CalendarItem[] } {
	const count = visibleCount(items.length, capacity);
	const ranked = items
		.map((item, index) => ({
			index,
			rank: item.key === activeKey ? -1 : cellRank(item),
		}))
		.sort((a, b) => a.rank - b.rank || a.index - b.index)
		.slice(0, count)
		.map((entry) => entry.index)
		.sort((a, b) => a - b);
	const shown: CalendarItem[] = [];
	for (const index of ranked) {
		const item = items[index];
		if (item) {
			shown.push(item);
		}
	}
	return { hidden: items.length - count, shown };
}

/** How many items fit in a month cell; overflow leaves room for "+N more". */
export function visibleCount(total: number, capacity: number): number {
	if (total <= capacity) {
		return total;
	}
	return Math.max(1, capacity - 1);
}

/** A month cell's chip row: a 20px chip and a 1px gap. */
export const CHIP_ROW_PX = 21;
/** A month cell's date row (26px) and its bottom padding (1px). */
export const CELL_CHROME_PX = 27;

/** How many chip rows (counting "+N more") a month cell of this height holds. */
export function cellCapacity(cellHeight: number): number {
	// The last row needs no gap below it.
	return Math.max(
		1,
		Math.floor((cellHeight - CELL_CHROME_PX + 1) / CHIP_ROW_PX)
	);
}
