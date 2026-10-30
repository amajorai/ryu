import { type InterfaceThread, localDayKey } from "@ryuhq/protocol/interfaces";
import {
	formatClock,
	formatShortDay,
	formatWeekdayClock,
} from "./ticker-model-format.ts";
import {
	TICKER_RANGE_PERIODS,
	type TickerDay,
	type TickerDirection,
	type TickerRange,
} from "./ticker-model-types.ts";

// ---------------------------------------------------------------------------
// Activity and quotes
// ---------------------------------------------------------------------------

/** Local midnight `offset` days from the day of `now` (negative = past). */
function dayStart(now: number, offset: number): Date {
	const date = new Date(now);
	date.setHours(0, 0, 0, 0);
	date.setDate(date.getDate() + offset);
	return date;
}

/**
 * Threads (and their messages) last active on each of the `days` days ending
 * today, oldest first, with each day's running "close". Threads only carry
 * their newest activity time, so a thread counts once, on its latest day;
 * threads last active before the range seed the opening price.
 */
export function dailyActivity(
	threads: InterfaceThread[],
	days: number,
	now: number
): TickerDay[] {
	const buckets: TickerDay[] = [];
	const byKey = new Map<string, TickerDay>();
	for (let offset = 1 - days; offset <= 0; offset++) {
		const date = dayStart(now, offset);
		const day: TickerDay = {
			close: 0,
			date: date.getTime(),
			key: localDayKey(date),
			messages: 0,
			threads: 0,
		};
		buckets.push(day);
		byKey.set(day.key, day);
	}
	const rangeStart = buckets[0]?.date ?? 0;
	let opening = 0;
	for (const thread of threads) {
		const at = Date.parse(thread.updatedAt);
		if (Number.isNaN(at)) {
			continue;
		}
		const day = byKey.get(localDayKey(new Date(at)));
		if (day) {
			day.threads += 1;
			day.messages += thread.messageCount;
		} else if (at < rangeStart) {
			opening += thread.messageCount;
		}
	}
	let running = opening;
	for (const day of buckets) {
		running += day.messages;
		day.close = running;
	}
	return buckets;
}

const MINUTE_SPAN = 60_000;
const HOUR_SPAN = 60 * MINUTE_SPAN;
const DAY_SPAN = 24 * HOUR_SPAN;
/** Bucket sizes a narrowed series may use, smallest first. */
const BUCKET_STEPS = [
	MINUTE_SPAN,
	2 * MINUTE_SPAN,
	5 * MINUTE_SPAN,
	10 * MINUTE_SPAN,
	15 * MINUTE_SPAN,
	30 * MINUTE_SPAN,
	HOUR_SPAN,
	2 * HOUR_SPAN,
	3 * HOUR_SPAN,
	6 * HOUR_SPAN,
	12 * HOUR_SPAN,
] as const;
/** Most buckets a narrowed series draws; enough for a smooth line. */
const MAX_BUCKETS = 24;
/** The narrowest window a series shows, so two close events still read as a move. */
const MIN_WINDOW = 30 * MINUTE_SPAN;
/** The window reaches this far past the first activity, as a share of its age. */
const LEAD_RATIO = 0.5;

export interface TickerSeries {
	/** Buckets oldest first; each `date` is the bucket's start. */
	buckets: TickerDay[];
	/** Whether the series starts after the range does (the range was mostly quiet). */
	narrowed: boolean;
	/** The price before the first bucket. */
	opening: number;
	/** Whole local days, or equal slices of time ending now. */
	unit: "day" | "time";
}

/**
 * A price series for a chart over the last `rangeDays` days that never draws
 * the degenerate "flat for weeks, then a wall today" shape. Threads only carry
 * their newest activity time, so a series starts shortly before the first
 * activity in the range: whole days when that still spans days, else equal
 * slices of time (1 minute to 12 hours) ending now. A quiet range keeps
 * every day, flat at the opening price.
 */
export function activitySeries(
	threads: InterfaceThread[],
	rangeDays: number,
	now: number
): TickerSeries {
	const rangeStart = dayStart(now, 1 - rangeDays).getTime();
	let first = Number.POSITIVE_INFINITY;
	for (const thread of threads) {
		const at = Date.parse(thread.updatedAt);
		if (!Number.isNaN(at) && at >= rangeStart && at <= now) {
			first = Math.min(first, at);
		}
	}
	const daily = (days: number): TickerSeries => {
		const buckets = dailyActivity(threads, days, now);
		return {
			buckets,
			narrowed: days < rangeDays,
			opening: openingPrice(buckets),
			unit: "day",
		};
	};
	if (first === Number.POSITIVE_INFINITY) {
		return daily(rangeDays);
	}
	const window = Math.max(MIN_WINDOW, (now - first) * (1 + LEAD_RATIO));
	const step = BUCKET_STEPS.find((size) => window / size <= MAX_BUCKETS);
	if (step === undefined) {
		const days = Math.min(rangeDays, Math.ceil(window / DAY_SPAN) + 1);
		return daily(days);
	}
	const count = Math.ceil(window / step);
	const start = now - count * step;
	const buckets: TickerDay[] = [];
	for (let index = 0; index < count; index++) {
		const date = start + index * step;
		buckets.push({
			close: 0,
			date,
			key: `t${date}`,
			messages: 0,
			threads: 0,
		});
	}
	let opening = 0;
	for (const thread of threads) {
		const at = Date.parse(thread.updatedAt);
		if (Number.isNaN(at)) {
			continue;
		}
		if (at < start) {
			opening += thread.messageCount;
			continue;
		}
		const bucket =
			buckets[Math.min(count - 1, Math.floor((at - start) / step))];
		if (bucket) {
			bucket.threads += 1;
			bucket.messages += thread.messageCount;
		}
	}
	let running = opening;
	for (const bucket of buckets) {
		running += bucket.messages;
		bucket.close = running;
	}
	return { buckets, narrowed: true, opening, unit: "time" };
}

/**
 * What a chart's caption calls the window it draws: the range ("Past 2
 * weeks") when the whole range is drawn, else where the narrowed series
 * starts ("Since 22:35", "Since Sun 17:09", "Since Oct 4"), so the caption
 * always matches the x-axis.
 */
export function seriesPeriod(
	series: TickerSeries,
	range: TickerRange,
	now: number
): string {
	const first = series.buckets[0];
	if (!(series.narrowed && first)) {
		return TICKER_RANGE_PERIODS[range];
	}
	if (series.unit === "day") {
		return `Since ${formatShortDay(first.date)}`;
	}
	return now - first.date > DAY_SPAN
		? `Since ${formatWeekdayClock(first.date)}`
		: `Since ${formatClock(first.date)}`;
}

/** The price before the first day of a series: its "previous close". */
export function openingPrice(days: TickerDay[]): number {
	const first = days[0];
	return first ? first.close - first.messages : 0;
}

/** A series' move over its whole range: up when the price grew. */
export function seriesDirection(days: TickerDay[]): TickerDirection {
	const last = days.at(-1);
	return last ? directionOf(last.close - openingPrice(days)) : "flat";
}

export function directionOf(change: number): TickerDirection {
	if (change > 0) {
		return "up";
	}
	return change < 0 ? "down" : "flat";
}
