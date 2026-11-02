import { activeLocale, dateFormatter } from "@ryu/i18n/lite";
import { resolveTimeZone } from "@ryu/ui/lib/timezone.ts";
import { localDayKey } from "@ryuhq/protocol/interfaces";
import {
	byStart,
	type CalendarItem,
	MIN_BLOCK_MINUTES,
} from "./calendar-model.ts";
import {
	addDays,
	type CalendarScale,
	minuteOfDay,
	parseDayKey,
	shiftDay,
	WEEK_START,
} from "./calendar-model-dates.ts";

/** Calendar week-grid placement, scroll position, keyboard movement, and the zone label. */

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
	const locale = activeLocale();
	let formatter: Intl.DateTimeFormat;
	try {
		formatter = new Intl.DateTimeFormat(locale, {
			timeZone: resolveTimeZone(),
			timeZoneName: "short",
		});
	} catch {
		formatter = dateFormatter(locale, { timeZoneName: "short" });
	}
	const part = formatter
		.formatToParts(date)
		.find((entry) => entry.type === "timeZoneName");
	return part?.value ?? "";
}
