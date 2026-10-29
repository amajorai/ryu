import { resolveTimeZone } from "@ryu/ui/lib/timezone.ts";
import {
	type CalendarParams,
	type InterfaceEvent,
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

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

export type CalendarScale = CalendarParams["scale"];

/** Weeks start on Sunday, like the reference calendars' default. */
const WEEK_START = 0;
const DAY_MS = 86_400_000;
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
// Dates
// ---------------------------------------------------------------------------

/** Local midnight for a `YYYY-MM-DD` key (falls back to today when malformed). */
export function parseDayKey(key: string): Date {
	const [year, month, day] = key.split("-").map(Number);
	if (!(year && month && day)) {
		const today = displayWallDate(Date.now());
		return new Date(today.getFullYear(), today.getMonth(), today.getDate());
	}
	return new Date(year, month - 1, day);
}

export function addDays(date: Date, days: number): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** The same day of another month, clamped to that month's last day. */
export function addMonths(date: Date, months: number): Date {
	const first = new Date(date.getFullYear(), date.getMonth() + months, 1);
	const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
	return new Date(
		first.getFullYear(),
		first.getMonth(),
		Math.min(date.getDate(), last.getDate())
	);
}

export function startOfWeek(date: Date): Date {
	const offset = (date.getDay() - WEEK_START + 7) % 7;
	return addDays(date, -offset);
}

/** Six full weeks around the month of `anchor`, so the grid never jumps. */
export function monthGridDays(anchor: Date): Date[] {
	const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
	const start = startOfWeek(first);
	return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}

export function weekDays(anchor: Date): Date[] {
	const start = startOfWeek(anchor);
	return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

export function visibleDays(scale: CalendarScale, anchor: Date): Date[] {
	return scale === "month" ? monthGridDays(anchor) : weekDays(anchor);
}

/** Previous/next page: a month (same day, clamped) or a week. */
export function shiftDay(
	scale: CalendarScale,
	key: string,
	step: -1 | 1
): string {
	const date = parseDayKey(key);
	return localDayKey(
		scale === "month" ? addMonths(date, step) : addDays(date, step * 7)
	);
}

export function sameMonth(a: Date, b: Date): boolean {
	return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

const MONTH_YEAR = new Intl.DateTimeFormat(undefined, {
	month: "long",
	year: "numeric",
});
const MONTH_SHORT = new Intl.DateTimeFormat(undefined, { month: "short" });
const MONTH_SHORT_YEAR = new Intl.DateTimeFormat(undefined, {
	month: "short",
	year: "numeric",
});
const WEEKDAY_SHORT = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const WEEKDAY_NARROW = new Intl.DateTimeFormat(undefined, {
	weekday: "narrow",
});
const DAY_LONG = new Intl.DateTimeFormat(undefined, {
	day: "numeric",
	month: "long",
	weekday: "long",
});
const DAY_MEDIUM = new Intl.DateTimeFormat(undefined, {
	day: "numeric",
	month: "short",
	weekday: "short",
});

/**
 * The header's range label: "October 2026" for a month, and for a week the
 * month it sits in, or both months ("Sep – Oct 2026") when it straddles two.
 */
export function rangeTitle(scale: CalendarScale, anchor: Date): string {
	const first = startOfWeek(anchor);
	const last = addDays(first, 6);
	if (scale === "month" || sameMonth(first, last)) {
		return MONTH_YEAR.format(anchor);
	}
	if (first.getFullYear() === last.getFullYear()) {
		return `${MONTH_SHORT.format(first)} – ${MONTH_SHORT_YEAR.format(last)}`;
	}
	return `${MONTH_SHORT_YEAR.format(first)} – ${MONTH_SHORT_YEAR.format(last)}`;
}

/** A narrow header's range label: "Oct 2026", or "Sep – Oct" for a straddling week. */
export function rangeTitleShort(scale: CalendarScale, anchor: Date): string {
	const first = startOfWeek(anchor);
	const last = addDays(first, 6);
	if (scale === "month" || sameMonth(first, last)) {
		return MONTH_SHORT_YEAR.format(anchor);
	}
	return `${MONTH_SHORT.format(first)} – ${MONTH_SHORT.format(last)}`;
}

/** Column headings in week order, short ("Sun") and narrow ("S"). */
export function weekdayNames(): { narrow: string; short: string }[] {
	return weekDays(new Date(2026, 0, 4)).map((day) => ({
		narrow: WEEKDAY_NARROW.format(day),
		short: WEEKDAY_SHORT.format(day),
	}));
}

export function weekdayShort(date: Date): string {
	return WEEKDAY_SHORT.format(date);
}

/** "Tuesday, October 13" */
export function longDay(date: Date): string {
	return DAY_LONG.format(date);
}

/** "Tue, Oct 13" */
export function mediumDay(date: Date): string {
	return DAY_MEDIUM.format(date);
}

/** A month cell's number: "Oct 1" on the first of a month, else "13". */
export function cellDayLabel(date: Date): string {
	return date.getDate() === 1
		? `${MONTH_SHORT.format(date)} 1`
		: String(date.getDate());
}

/** Compact clock time, calendar style: "9am", "9:16am", "12pm". */
export function compactTime(date: Date): string {
	const hours = date.getHours();
	const minutes = date.getMinutes();
	const suffix = hours < 12 ? "am" : "pm";
	const hour = hours % 12 || 12;
	return minutes === 0
		? `${hour}${suffix}`
		: `${hour}:${String(minutes).padStart(2, "0")}${suffix}`;
}

/** Hour-axis label: "1 AM" … "11 PM" (the first row, midnight, is unlabeled). */
export function hourLabel(hour: number): string {
	const suffix = hour < 12 ? "AM" : "PM";
	return `${hour % 12 || 12} ${suffix}`;
}

/** "Today", "Tomorrow", "Yesterday", or "Fri, Oct 16". */
export function relativeDay(date: Date, now: Date): string {
	const diff = Math.round(
		(parseDayKey(localDayKey(date)).getTime() -
			parseDayKey(localDayKey(now)).getTime()) /
			DAY_MS
	);
	if (diff === 0) {
		return "Today";
	}
	if (diff === 1) {
		return "Tomorrow";
	}
	if (diff === -1) {
		return "Yesterday";
	}
	return mediumDay(date);
}

export function minuteOfDay(date: Date): number {
	return date.getHours() * 60 + date.getMinutes();
}

const wallFormatters = new Map<string, Intl.DateTimeFormat>();

function wallFormatter(timeZone: string): Intl.DateTimeFormat {
	let formatter = wallFormatters.get(timeZone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-US", {
			calendar: "iso8601",
			day: "2-digit",
			hour: "2-digit",
			hourCycle: "h23",
			minute: "2-digit",
			month: "2-digit",
			numberingSystem: "latn",
			second: "2-digit",
			timeZone,
			year: "numeric",
		});
		wallFormatters.set(timeZone, formatter);
	}
	return formatter;
}

/**
 * An instant as the display zone's wall clock: a Date whose local
 * year/month/day/hour/minute read what the user's display-timezone preference
 * shows for `ms`. With the "system" preference (or an unusable zone) it is the
 * instant itself. Only for bucketing and labelling; never send it anywhere.
 */
export function displayWallDate(ms: number): Date {
	const timeZone = resolveTimeZone();
	if (!timeZone) {
		return new Date(ms);
	}
	try {
		const parts = wallFormatter(timeZone).formatToParts(new Date(ms));
		const read = (type: Intl.DateTimeFormatPartTypes) =>
			Number(parts.find((part) => part.type === type)?.value);
		const wall = new Date(0);
		wall.setFullYear(read("year"), read("month") - 1, read("day"));
		wall.setHours(
			read("hour") % 24,
			read("minute"),
			read("second"),
			((ms % 1000) + 1000) % 1000
		);
		return Number.isNaN(wall.getTime()) ? new Date(ms) : wall;
	} catch {
		return new Date(ms);
	}
}

function validDate(iso: string | null | undefined): Date | null {
	if (!iso) {
		return null;
	}
	const time = Date.parse(iso);
	return Number.isNaN(time) ? null : displayWallDate(time);
}

// ---------------------------------------------------------------------------
// Agenda
// ---------------------------------------------------------------------------

function aggregateRank(item: CalendarItem): number {
	return item.kind === "run" && (item.event.count ?? 0) > 1 ? 0 : 1;
}

function byStart(a: CalendarItem, b: CalendarItem): number {
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
		return "under a minute";
	}
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const rest = minutes % 60;
	return rest ? `${Math.floor(minutes / 60)}h ${rest}m` : `${minutes / 60}h`;
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

// ---------------------------------------------------------------------------
// Week grid placement
// ---------------------------------------------------------------------------
export interface PlacedItem {
	/** Where the block's drawn box ends: its top plus its (minimum) duration. */
	endMinute: number;
	item: CalendarItem;
	/** Zero-based place within its row of near-simultaneous blocks. */
	lane: number;
	/** Blocks its row shows side by side. */
	lanes: number;
	/** Left edge in px, from the column's block area. */
	left: number;
	/**
	 * Where a later block cascading over this one starts (else its end):
	 * the part of it left in view, which decides how many lines it shows.
	 */
	openUntilMinute: number;
	/** The item's own time, which its label always shows. */
	startMinute: number;
	/** Whether the block is wide enough to carry words; else it is a bare tint. */
	text: boolean;
	/** Where the block is drawn: its start, kept inside the day. */
	topMinute: number;
	/** Width in px. */
	width: number;
}

/**
 * The rest of a crowded row, folded away: "+N", which opens the day's
 * agenda. It sits at the right edge of the row it folds.
 */
export interface WeekFold {
	endMinute: number;
	items: CalendarItem[];
	key: string;
	left: number;
	topMinute: number;
	width: number;
}

export interface DayLayout {
	blocks: PlacedItem[];
	folds: WeekFold[];
}

const DAY_MINUTES = 24 * 60;
/**
 * Boxes are drawn with a 2px gap below them, so blocks closer than this in
 * time only touch on screen: they do not overlap.
 */
const TOUCH_MINUTES = 2;
/**
 * A block that starts at least this long after one it overlaps (18px, a
 * title line) cascades over it, the reference calendars' way: the earlier
 * title stays readable above it. Closer starts share a row side by side.
 */
export const CASCADE_MINUTES = 15;
/** How far each cascaded block steps in from the one under it. */
const CASCADE_STEP_PX = 12;
/** Narrowest block that carries text; anything narrower is folded or bare. */
export const MIN_TEXT_PX = 64;
/** Width of a row's "+N" fold. */
const FOLD_PX = 24;
/** The block area's width before the grid has been measured. */
export const DEFAULT_COLUMN_PX = 140;

/** A block's drawn length: its real duration, never under half an hour. */
export function itemLength(item: CalendarItem): number {
	if (item.kind === "run" && item.end) {
		return Math.max(
			MIN_BLOCK_MINUTES,
			Math.round((item.end.getTime() - item.start.getTime()) / 60_000)
		);
	}
	return MIN_BLOCK_MINUTES;
}

function overlaps(
	a: { endMinute: number; topMinute: number },
	b: { endMinute: number; topMinute: number }
): boolean {
	return (
		a.topMinute < b.endMinute - TOUCH_MINUTES &&
		b.topMinute < a.endMinute - TOUCH_MINUTES
	);
}

interface Span {
	endMinute: number;
	item: CalendarItem;
	startMinute: number;
	topMinute: number;
}

interface Row {
	depth: number;
	entries: Span[];
	topMinute: number;
}

/**
 * Group a day's spans into rows: a span joins the latest row when it starts
 * within {@link CASCADE_MINUTES} of it (their titles would collide), else it
 * opens a row one cascade step deeper than the deepest row it overlaps.
 */
function dayRows(spans: readonly Span[]): Row[] {
	const rows: Row[] = [];
	for (const span of spans) {
		const last = rows.at(-1);
		if (
			last &&
			span.topMinute - last.topMinute < CASCADE_MINUTES &&
			last.entries.some((other) => overlaps(other, span))
		) {
			last.entries.push(span);
			continue;
		}
		let depth = 0;
		for (const row of rows) {
			if (row.entries.some((other) => overlaps(other, span))) {
				depth = Math.max(depth, row.depth + 1);
			}
		}
		rows.push({ depth, entries: [span], topMinute: span.topMinute });
	}
	return rows;
}

/**
 * Lay one day's timed items out like a calendar: each at its start and as
 * tall as it lasts (half an hour at least). A later item that overlaps an
 * earlier one cascades over it, stepped in so the earlier title stays in
 * view; items starting within a few minutes of each other share their row
 * side by side. No block that carries text is narrower than
 * {@link MIN_TEXT_PX}: what a row cannot fit folds into a "+N" at its edge,
 * keeping `keepKey` (the open thread) in view.
 */
export function layoutDay(
	items: readonly CalendarItem[],
	width: number = DEFAULT_COLUMN_PX,
	keepKey: string | null = null
): DayLayout {
	const spans: Span[] = [...items].sort(byStart).map((item) => {
		const length = itemLength(item);
		// Keep a block that starts late in the day inside the day.
		const topMinute = Math.min(minuteOfDay(item.start), DAY_MINUTES - length);
		return {
			endMinute: topMinute + length,
			item,
			startMinute: minuteOfDay(item.start),
			topMinute,
		};
	});
	// Never step in so far that the row is left too narrow for words.
	const maxDepth = Math.max(
		0,
		Math.floor((width - MIN_TEXT_PX) / CASCADE_STEP_PX)
	);
	const foldDepth = Math.max(
		0,
		Math.floor((width - MIN_TEXT_PX - FOLD_PX) / CASCADE_STEP_PX)
	);
	const blocks: PlacedItem[] = [];
	const folds: WeekFold[] = [];
	for (const row of dayRows(spans)) {
		let indent = Math.min(row.depth, maxDepth) * CASCADE_STEP_PX;
		const fits = Math.max(1, Math.floor((width - indent) / MIN_TEXT_PX));
		let shown = row.entries;
		let hidden: Span[] = [];
		let laneRoom = width - indent;
		if (row.entries.length > fits) {
			// A folding row also makes room for its "+N": it steps in less.
			indent = Math.min(indent, foldDepth * CASCADE_STEP_PX);
			laneRoom = width - indent - FOLD_PX;
			const count = Math.max(1, Math.floor(laneRoom / MIN_TEXT_PX));
			shown = row.entries.slice(0, count);
			hidden = row.entries.slice(count);
			const kept = hidden.find((span) => span.item.key === keepKey);
			if (kept) {
				const swapped = shown.at(-1);
				shown = [...shown.slice(0, -1), kept];
				hidden = hidden.filter((span) => span !== kept);
				if (swapped) {
					hidden.unshift(swapped);
				}
				shown.sort((a, b) => byStart(a.item, b.item));
			}
		}
		const laneWidth = laneRoom / shown.length;
		for (const [lane, span] of shown.entries()) {
			blocks.push({
				...span,
				lane,
				lanes: shown.length,
				left: indent + lane * laneWidth,
				openUntilMinute: span.endMinute,
				text: laneWidth >= MIN_TEXT_PX,
				width: laneWidth,
			});
		}
		const first = hidden[0];
		if (first) {
			folds.push({
				// One title line tall, so a later row cascading in below never covers it.
				endMinute: row.topMinute + CASCADE_MINUTES,
				items: hidden.map((span) => span.item),
				key: `fold:${first.item.key}`,
				left: width - FOLD_PX,
				topMinute: row.topMinute,
				width: FOLD_PX,
			});
		}
	}
	blocks.sort((a, b) => byStart(a.item, b.item));
	for (const block of blocks) {
		for (const other of blocks) {
			const covers =
				other.topMinute > block.topMinute &&
				overlaps(other, block) &&
				other.left < block.left + block.width &&
				other.left + other.width > block.left;
			if (covers) {
				block.openUntilMinute = Math.min(
					block.openUntilMinute,
					other.topMinute
				);
			}
		}
	}
	return { blocks, folds };
}

/** Blocks a scrolled week column hides above and below its visible hours. */
export function offscreenItems<
	T extends { endMinute: number; topMinute: number },
>(
	placed: readonly T[],
	fromMinute: number,
	toMinute: number
): { above: T[]; below: T[] } {
	// A block counts as hidden once less than a few minutes of it shows.
	const slack = 4;
	return {
		above: placed.filter((entry) => entry.endMinute <= fromMinute + slack),
		below: placed.filter((entry) => entry.topMinute >= toMinute - slack),
	};
}

/** How far above "now" a week showing today opens, like the reference calendars. */
const NOW_LEAD_MINUTES = 2 * 60;
/** Room left above the first item a week opens on. */
const FIRST_ITEM_LEAD_MINUTES = 30;

/** The top edge's own hint covers about this much of the hour below it. */
const TOP_HINT_MINUTES = 15;

/** Whether a block straddles (or sits right under) a scroll top at `minute`. */
function crowdsTop(itemMinutes: readonly number[], minute: number): boolean {
	return itemMinutes.some(
		(start) =>
			start > minute - MIN_BLOCK_MINUTES - 4 &&
			start < minute + TOP_HINT_MINUTES
	);
}

/**
 * The hour a week grid opens on. A week showing today opens about two hours
 * above "now", so the now-line and the live work around it are in view
 * (earlier items are counted by the column's "earlier" hint). Another week
 * opens a little above its first item, or at 8 AM when it is empty.
 */
export function initialScrollMinute(
	itemMinutes: readonly number[],
	nowMinute: number | null
): number {
	let target = 8 * 60;
	if (nowMinute !== null) {
		target = nowMinute - NOW_LEAD_MINUTES;
	} else if (itemMinutes.length > 0) {
		target = Math.min(...itemMinutes) - FIRST_ITEM_LEAD_MINUTES;
	}
	// Open exactly on an hour line, so the first label reads as a whole, and
	// never on one that would cut a block in half or tuck it under the
	// column's "earlier" hint (up to a few hours further up).
	let minute = Math.max(0, Math.floor(target / 60) * 60);
	for (
		let step = 0;
		step < 3 && minute > 0 && crowdsTop(itemMinutes, minute);
		step += 1
	) {
		minute -= 60;
	}
	return minute;
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

/**
 * The day a navigation key moves to from `key`, or null when the key does
 * not navigate. Arrows step a day or a week; Home/End go to the week's ends;
 * PageUp/PageDown step a page (a month, or a week).
 */
export function moveDayKey(
	key: string,
	keyName: string,
	scale: CalendarScale
): string | null {
	const date = parseDayKey(key);
	const offset = (date.getDay() - WEEK_START + 7) % 7;
	const steps: Record<string, () => Date> = {
		ArrowDown: () => addDays(date, 7),
		ArrowLeft: () => addDays(date, -1),
		ArrowRight: () => addDays(date, 1),
		ArrowUp: () => addDays(date, -7),
		End: () => addDays(date, 6 - offset),
		Home: () => addDays(date, -offset),
		PageDown: () => parseDayKey(shiftDay(scale, key, 1)),
		PageUp: () => parseDayKey(shiftDay(scale, key, -1)),
	};
	const step = steps[keyName];
	return step ? localDayKey(step()) : null;
}

/** The display zone as calendars label the hour axis: "GMT+2", "PDT", "UTC". */
export function timeZoneLabel(date: Date): string {
	let formatter: Intl.DateTimeFormat;
	try {
		formatter = new Intl.DateTimeFormat(undefined, {
			timeZone: resolveTimeZone(),
			timeZoneName: "short",
		});
	} catch {
		formatter = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" });
	}
	const part = formatter
		.formatToParts(date)
		.find((entry) => entry.type === "timeZoneName");
	return part?.value ?? "";
}
