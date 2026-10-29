import type {
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { localDayKey } from "@ryuhq/protocol/interfaces";
import { displayWallDate } from "./calendar-model.ts";

/**
 * Pure helpers for the Timeline interface. Everything here works in the
 * runtime's local time zone, matching `projectTimeline`'s local day keys; the
 * renderer hands them display-zone wall-clock times (`displayWallSnapshot`).
 */

/**
 * The snapshot with each thread's time moved to the display time zone's wall
 * clock (see `displayWallDate`), so the local-time helpers below and
 * `projectTimeline` bucket and label days as the user's chosen zone reads
 * them. Only for this view's layout and labels; ids and everything else are
 * untouched.
 */
export function displayWallSnapshot(
	snapshot: InterfaceSnapshot
): InterfaceSnapshot {
	return {
		...snapshot,
		threads: snapshot.threads.map((thread) => {
			const ms = Date.parse(thread.updatedAt);
			return Number.isNaN(ms)
				? thread
				: { ...thread, updatedAt: displayWallDate(ms).toISOString() };
		}),
	};
}

/** A `YYYY-MM-DD` local day key back to local midnight. */
export function dayKeyToDate(key: string): Date {
	const [year = 1970, month = 1, day = 1] = key.split("-").map(Number);
	return new Date(year, month - 1, day);
}

/** The local day key `offset` days before `now`. */
export function dayKeyBefore(now: Date, offset: number): string {
	return localDayKey(
		new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset)
	);
}

const WEEKDAY_DATE = new Intl.DateTimeFormat(undefined, {
	day: "numeric",
	month: "short",
	weekday: "long",
});
const WEEKDAY_DATE_YEAR = new Intl.DateTimeFormat(undefined, {
	day: "numeric",
	month: "short",
	weekday: "long",
	year: "numeric",
});
const SHORT_WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const NARROW_WEEKDAY = new Intl.DateTimeFormat(undefined, {
	weekday: "narrow",
});
const DAY_OF_MONTH = new Intl.DateTimeFormat(undefined, { day: "numeric" });
const MONTH_DAY = new Intl.DateTimeFormat(undefined, {
	day: "numeric",
	month: "short",
});
const TIME_OF_DAY = new Intl.DateTimeFormat(undefined, {
	hour: "numeric",
	minute: "2-digit",
});
const HOUR_ONLY = new Intl.DateTimeFormat(undefined, { hour: "numeric" });
const FULL_DATE_TIME = new Intl.DateTimeFormat(undefined, {
	dateStyle: "full",
	timeStyle: "short",
});

/** "Today", "Yesterday", or a weekday and date ("Friday, Oct 9"). */
export function dayHeading(key: string, now: Date): string {
	if (key === localDayKey(now)) {
		return "Today";
	}
	if (key === dayKeyBefore(now, 1)) {
		return "Yesterday";
	}
	const date = dayKeyToDate(key);
	return date.getFullYear() === now.getFullYear()
		? WEEKDAY_DATE.format(date)
		: WEEKDAY_DATE_YEAR.format(date);
}

/** Short weekday ("Mon"), its initial ("M") and day of month ("12") for a week column. */
export function weekColumnLabel(key: string): {
	dayOfMonth: string;
	full: string;
	initial: string;
	weekday: string;
} {
	const date = dayKeyToDate(key);
	return {
		dayOfMonth: DAY_OF_MONTH.format(date),
		full: WEEKDAY_DATE.format(date),
		initial: NARROW_WEEKDAY.format(date),
		weekday: SHORT_WEEKDAY.format(date),
	};
}

/** "Oct 6 – Oct 12" for the visible week. */
export function weekRangeLabel(firstKey: string, lastKey: string): string {
	return `${MONTH_DAY.format(dayKeyToDate(firstKey))} – ${MONTH_DAY.format(
		dayKeyToDate(lastKey)
	)}`;
}

/** "9:42 AM" in the user's locale. */
export function timeOfDay(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? "" : TIME_OF_DAY.format(date);
}

/** Full local date and time for a `title` / screen-reader label. */
export function fullDateTime(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? "" : FULL_DATE_TIME.format(date);
}

/** Hour gutter label ("6 AM" / "18"). */
export function hourLabel(hour: number): string {
	return HOUR_ONLY.format(new Date(2000, 0, 1, hour));
}

/** Minutes since local midnight. */
export function minuteOfDay(date: Date): number {
	return date.getHours() * 60 + date.getMinutes();
}

/** An hour range for a folded run of empty hours ("8–10 AM", "11 AM–2 PM"). */
export function hourRangeLabel(fromHour: number, toHour: number): string {
	const from = HOUR_ONLY.formatToParts(new Date(2000, 0, 1, fromHour));
	const to = HOUR_ONLY.formatToParts(new Date(2000, 0, 1, toHour));
	const period = (parts: Intl.DateTimeFormatPart[]) =>
		parts.find((part) => part.type === "dayPeriod")?.value;
	const fromPeriod = period(from);
	if (fromPeriod && fromPeriod === period(to)) {
		const bare = from
			.filter((part) => part.type !== "dayPeriod")
			.map((part) => part.value)
			.join("")
			.trim();
		return `${bare}–${hourLabel(toHour)}`;
	}
	return `${hourLabel(fromHour)}–${hourLabel(toHour)}`;
}

// ---------------------------------------------------------------------------
// Week grid layout
// ---------------------------------------------------------------------------

/** Height of an hour row that holds at most one chip. */
export const WEEK_HOUR_PX = 48;
/**
 * Vertical pitch of a thread chip: one line, title then time. A thread's
 * latest activity is a moment, not a span, so chips in the same hour stack
 * full width, in time order, from the top of the hour.
 */
export const WEEK_CHIP_PX = 24;
/** A run of two or more empty hours folds into one short row this tall. */
export const WEEK_QUIET_PX = 24;
/** Space above the first chip and below the last chip in an hour. */
const WEEK_ROW_PAD_PX = 4;
/** Room below today's chips in the current hour for the "now" line. */
const WEEK_NOW_ROOM_PX = 6;

/** Most an hour row grows by to fill a tall view. */
const WEEK_FILL_GROW_PX = 16;

/** Working-day hours the grid always shows, so a quiet week still reads. */
const DEFAULT_START_HOUR = 8;
const DEFAULT_END_HOUR = 18;

/** One horizontal band of the grid: an hour, or a folded run of empty hours. */
export interface WeekRow {
	fromHour: number;
	height: number;
	quiet: boolean;
	/** Hour the row ends at (exclusive). */
	toHour: number;
	/** Pixel offset of the row's top edge. */
	top: number;
}

export interface PlacedChip {
	thread: InterfaceThread;
	/** Pixel offset of the chip's top edge. */
	top: number;
}

export interface WeekLayout {
	/** Chips per day, in time order. */
	chips: PlacedChip[][];
	endHour: number;
	/** Total grid height in pixels; always ends on an hour line. */
	height: number;
	/** Where the "now" line sits in today's column, or null when not shown. */
	nowTop: number | null;
	rows: WeekRow[];
	startHour: number;
}

function threadMinute(thread: InterfaceThread): number {
	return minuteOfDay(new Date(thread.updatedAt));
}

/** One day's threads grouped by the hour of their latest activity, in time order. */
function byHour(
	threads: readonly InterfaceThread[]
): Map<number, InterfaceThread[]> {
	const sorted = [...threads].sort(
		(a, b) =>
			Date.parse(a.updatedAt) - Date.parse(b.updatedAt) ||
			a.id.localeCompare(b.id)
	);
	const hours = new Map<number, InterfaceThread[]>();
	for (const thread of sorted) {
		const hour = Math.floor(threadMinute(thread) / 60);
		const list = hours.get(hour) ?? [];
		list.push(thread);
		hours.set(hour, list);
	}
	return hours;
}

/** Hour rows sized to their busiest day, with runs of empty hours folded. */
function buildRows(
	startHour: number,
	endHour: number,
	stackDepth: ReadonlyMap<number, number>,
	nowHour: number | null,
	fold = true
): WeekRow[] {
	const rows: WeekRow[] = [];
	let top = 0;
	let hour = startHour;
	while (hour < endHour) {
		let runEnd = hour;
		while (runEnd < endHour && !stackDepth.has(runEnd) && runEnd !== nowHour) {
			runEnd += 1;
		}
		if (fold && runEnd - hour >= 2) {
			rows.push({
				fromHour: hour,
				height: WEEK_QUIET_PX,
				quiet: true,
				toHour: runEnd,
				top,
			});
			top += WEEK_QUIET_PX;
			hour = runEnd;
			continue;
		}
		const depth = stackDepth.get(hour) ?? 0;
		const height = Math.max(
			WEEK_HOUR_PX,
			WEEK_ROW_PAD_PX * 2 +
				depth * WEEK_CHIP_PX +
				(hour === nowHour ? WEEK_NOW_ROOM_PX : 0)
		);
		rows.push({ fromHour: hour, height, quiet: false, toHour: hour + 1, top });
		top += height;
		hour += 1;
	}
	return rows;
}

/** Rebase row offsets after rows were added or resized; returns the total height. */
function retile(rows: WeekRow[]): number {
	let top = 0;
	for (const row of rows) {
		row.top = top;
		top += row.height;
	}
	return top;
}

/**
 * Add whole empty hours while they fit in the view (later hours first, then
 * earlier ones), then spread what is left over the hours, up to a cap. The
 * grid always ends on an hour line, never part-way through a row.
 */
function fillRows(
	rows: WeekRow[],
	range: { endHour: number; startHour: number },
	fillPx: number
): number {
	const addHour = (): boolean => {
		if (range.endHour < 24) {
			rows.push({
				fromHour: range.endHour,
				height: WEEK_HOUR_PX,
				quiet: false,
				toHour: range.endHour + 1,
				top: 0,
			});
			range.endHour += 1;
			return true;
		}
		if (range.startHour > 0) {
			range.startHour -= 1;
			rows.unshift({
				fromHour: range.startHour,
				height: WEEK_HOUR_PX,
				quiet: false,
				toHour: range.startHour + 1,
				top: 0,
			});
			return true;
		}
		return false;
	};
	let height = retile(rows);
	// Whole hours that fit, so the last hour line lands inside the view.
	while (height + WEEK_HOUR_PX <= fillPx && addHour()) {
		height += WEEK_HOUR_PX;
	}
	// Then the remainder, spread over the hours (up to a cap each), so the
	// grid ends exactly on the view's bottom edge.
	const hourRows = rows.filter((row) => !row.quiet);
	if (height < fillPx && hourRows.length > 0) {
		const rest = Math.min(fillPx - height, WEEK_FILL_GROW_PX * hourRows.length);
		const extra = Math.floor(rest / hourRows.length);
		const remainder = rest - extra * hourRows.length;
		for (const [index, row] of hourRows.entries()) {
			row.height += extra + (index < remainder ? 1 : 0);
		}
	}
	return retile(rows);
}

/**
 * Lay out the week grid. The band runs from the first to the last hour with
 * activity (or "now"), so it never opens or closes on a folded run; an empty
 * week shows the working day. Each hour is a compact fixed height, grown only
 * as far as its busiest day's stacked chips need; inner runs of two or more
 * empty hours fold into one short row. With `fillPx`, whole empty hours are
 * added around the band until the grid fills the view.
 */
export function weekLayout(
	days: readonly (readonly InterfaceThread[])[],
	now: Date,
	todayIndex: number,
	fillPx = 0
): WeekLayout {
	const grouped = days.map(byHour);
	const nowMinute = minuteOfDay(now);
	const showNow = todayIndex >= 0 && todayIndex < days.length;
	const nowHour = showNow ? Math.floor(nowMinute / 60) : null;

	const stackDepth = new Map<number, number>();
	for (const hours of grouped) {
		for (const [hour, threads] of hours) {
			stackDepth.set(hour, Math.max(stackDepth.get(hour) ?? 0, threads.length));
		}
	}
	const anchors = [
		...stackDepth.keys(),
		...(nowHour === null ? [] : [nowHour]),
	];
	const empty = stackDepth.size === 0;
	const range = {
		endHour: empty ? DEFAULT_END_HOUR : 0,
		startHour: empty ? DEFAULT_START_HOUR : 24,
	};
	for (const hour of anchors) {
		range.startHour = Math.min(range.startHour, hour);
		range.endHour = Math.max(range.endHour, hour + 1);
	}

	// An empty week keeps every working hour: there is nothing to fold toward.
	const rows = buildRows(
		range.startHour,
		range.endHour,
		stackDepth,
		nowHour,
		!empty
	);
	const height = fillRows(rows, range, fillPx);
	const { endHour, startHour } = range;
	const rowByHour = new Map<number, WeekRow>();
	for (const row of rows) {
		if (!row.quiet) {
			rowByHour.set(row.fromHour, row);
		}
	}

	const chips = grouped.map((hours) => {
		const placed: PlacedChip[] = [];
		for (const [hour, threads] of [...hours].sort(([a], [b]) => a - b)) {
			const row = rowByHour.get(hour);
			const rowTop = row?.top ?? 0;
			for (const [index, thread] of threads.entries()) {
				placed.push({
					thread,
					top: rowTop + WEEK_ROW_PAD_PX + index * WEEK_CHIP_PX,
				});
			}
		}
		return placed;
	});

	let nowTop: number | null = null;
	const nowRow = nowHour === null ? undefined : rowByHour.get(nowHour);
	if (nowRow) {
		const today = grouped[todayIndex]?.get(nowRow.fromHour) ?? [];
		const past = today.filter((thread) => threadMinute(thread) <= nowMinute);
		const natural = nowRow.top + ((nowMinute % 60) / 60) * nowRow.height;
		// The line follows today's stacked chips, so it never runs through one.
		const afterStack =
			nowRow.top + WEEK_ROW_PAD_PX + past.length * WEEK_CHIP_PX + 1;
		if (past.length === 0) {
			nowTop = today.length > 0 ? nowRow.top + 2 : natural;
		} else if (past.length < today.length) {
			nowTop = afterStack;
		} else {
			nowTop = Math.min(
				Math.max(natural, afterStack),
				nowRow.top + nowRow.height - 2
			);
		}
	}

	return { chips, endHour, height, nowTop, rows, startHour };
}

// ---------------------------------------------------------------------------
// Week grid columns
// ---------------------------------------------------------------------------

/** Width of the hour gutter at the grid's left edge. */
export const WEEK_GUTTER_REM = 4.5;

interface ColumnSizing {
	/** A day with threads is never narrower than this: room for a readable title. */
	dayMin: number;
	/** An empty day keeps a narrow column; it still marks the day. */
	emptyMin: number;
	/** An empty day's share of the width, against 1 for a day with threads. */
	emptyShare: number;
}

/** Sizes, in rem, with the timeline to itself. */
const ROOMY: ColumnSizing = { dayMin: 8, emptyMin: 2.75, emptyShare: 0.4 };
/**
 * Sizes, in rem, beside an open thread: empty days shrink to their initial,
 * so busy days keep the width; past that the grid scrolls sideways, oldest
 * days first, rather than crush chips.
 */
const COMPACT: ColumnSizing = { dayMin: 8, emptyMin: 1.5, emptyShare: 0.15 };

export interface WeekColumnTracks {
	/** Minimum width of the whole grid (gutter included), in rem. */
	minWidthRem: number;
	/** CSS `grid-template-columns` for the gutter and the seven days. */
	template: string;
}

/**
 * Column widths. Days with threads share the width equally; empty days keep
 * a narrow column, so the busy days get the room. The minimums sum to the
 * grid's minimum width so a narrow viewport scrolls sideways instead of
 * crushing chips.
 */
export function weekColumnTracks(
	chipCounts: readonly number[],
	compact = false
): WeekColumnTracks {
	const sizing = compact ? COMPACT : ROOMY;
	let minWidthRem = WEEK_GUTTER_REM;
	const tracks = [`${WEEK_GUTTER_REM}rem`];
	for (const count of chipCounts) {
		if (count <= 0) {
			minWidthRem += sizing.emptyMin;
			tracks.push(`minmax(${sizing.emptyMin}rem,${sizing.emptyShare}fr)`);
			continue;
		}
		minWidthRem += sizing.dayMin;
		tracks.push(`minmax(${sizing.dayMin}rem,1fr)`);
	}
	return { minWidthRem, template: tracks.join(" ") };
}
