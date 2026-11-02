import {
	activeLocale,
	dateFormatter,
	isEnglishLocale,
	numberFormatter,
	translate as tr,
} from "@ryu/i18n/lite";
import { resolveTimeZone } from "@ryu/ui/lib/timezone.ts";
import type { CalendarParams } from "@ryuhq/protocol/interfaces";
import { localDayKey } from "@ryuhq/protocol/interfaces";

export type CalendarScale = CalendarParams["scale"];

/** Weeks start on Sunday, like the reference calendars' default. */
export const WEEK_START = 0;
export const DAY_MS = 86_400_000;

/** Calendar date math and the labels the month and week ranges show. */

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

const MONTH_YEAR = (locale: string = activeLocale()) =>
	dateFormatter(locale, {
		month: "long",
		year: "numeric",
	});
const MONTH_SHORT = (locale: string = activeLocale()) =>
	dateFormatter(locale, { month: "short" });
const MONTH_SHORT_YEAR = (locale: string = activeLocale()) =>
	dateFormatter(locale, {
		month: "short",
		year: "numeric",
	});
const WEEKDAY_SHORT = (locale: string = activeLocale()) =>
	dateFormatter(locale, { weekday: "short" });
const WEEKDAY_NARROW = (locale: string = activeLocale()) =>
	dateFormatter(locale, {
		weekday: "narrow",
	});
const DAY_LONG = (locale: string = activeLocale()) =>
	dateFormatter(locale, {
		day: "numeric",
		month: "long",
		weekday: "long",
	});
const DAY_MEDIUM = (locale: string = activeLocale()) =>
	dateFormatter(locale, {
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
		return MONTH_YEAR().format(anchor);
	}
	return MONTH_SHORT_YEAR().formatRange(first, last);
}

/** A narrow header's range label: "Oct 2026", or "Sep – Oct" for a straddling week. */
export function rangeTitleShort(scale: CalendarScale, anchor: Date): string {
	const first = startOfWeek(anchor);
	const last = addDays(first, 6);
	if (scale === "month" || sameMonth(first, last)) {
		return MONTH_SHORT_YEAR().format(anchor);
	}
	return MONTH_SHORT().formatRange(first, last);
}

/** Column headings in week order, short ("Sun") and narrow ("S"). */
export function weekdayNames(): { narrow: string; short: string }[] {
	return weekDays(new Date(2026, 0, 4)).map((day) => ({
		narrow: WEEKDAY_NARROW().format(day),
		short: WEEKDAY_SHORT().format(day),
	}));
}

export function weekdayShort(date: Date): string {
	return WEEKDAY_SHORT().format(date);
}

/** "Tuesday, October 13" */
export function longDay(date: Date): string {
	return DAY_LONG().format(date);
}

/** "Tue, Oct 13" */
export function mediumDay(date: Date): string {
	return DAY_MEDIUM().format(date);
}

/** A month cell's number: "Oct 1" on the first of a month, else "13". */
export function cellDayLabel(date: Date): string {
	return date.getDate() === 1
		? dateFormatter(activeLocale(), { day: "numeric", month: "short" }).format(
				date
			)
		: numberFormatter(activeLocale()).format(date.getDate());
}

/**
 * Compact clock time, calendar style: "9am", "9:16am", "12pm" in English;
 * the locale's own short time ("9:16", "9時16分") elsewhere.
 */
export function compactTime(
	date: Date,
	locale: string = activeLocale()
): string {
	if (!isEnglishLocale(locale)) {
		return dateFormatter(locale, {
			hour: "numeric",
			minute: date.getMinutes() === 0 ? undefined : "2-digit",
		}).format(date);
	}
	const hours = date.getHours();
	const minutes = date.getMinutes();
	const suffix = hours < 12 ? "am" : "pm";
	const hour = hours % 12 || 12;
	return minutes === 0
		? `${hour}${suffix}`
		: `${hour}:${String(minutes).padStart(2, "0")}${suffix}`;
}

/** Hour-axis label: "1 AM" … "11 PM" in English (midnight's row is unlabeled). */
export function hourLabel(
	hour: number,
	locale: string = activeLocale()
): string {
	return dateFormatter(locale, { hour: "numeric" }).format(
		new Date(2026, 0, 1, hour)
	);
}

/** "Today", "Tomorrow", "Yesterday", or "Fri, Oct 16". */
export function relativeDay(date: Date, now: Date): string {
	const diff = Math.round(
		(parseDayKey(localDayKey(date)).getTime() -
			parseDayKey(localDayKey(now)).getTime()) /
			DAY_MS
	);
	if (diff === 0) {
		return tr("Today");
	}
	if (diff === 1) {
		return tr("Tomorrow");
	}
	if (diff === -1) {
		return tr("Yesterday");
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

export function validDate(iso: string | null | undefined): Date | null {
	if (!iso) {
		return null;
	}
	const time = Date.parse(iso);
	return Number.isNaN(time) ? null : displayWallDate(time);
}
