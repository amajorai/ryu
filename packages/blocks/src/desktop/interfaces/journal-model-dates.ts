import { activeLocale, dateFormatter } from "@ryu/i18n/lite";
import { localDayKey } from "@ryuhq/protocol/interfaces";

/** Journal date keys and the labels its calendar, day and stats views show. */

const MONTH_LABEL = (locale: string = activeLocale()) =>
	dateFormatter(locale, {
		month: "long",
		year: "numeric",
	});
const TIME_LABEL = (locale: string = activeLocale()) =>
	dateFormatter(locale, {
		hour: "numeric",
		minute: "2-digit",
	});
const WEEKDAY_SHORT = (locale: string = activeLocale()) =>
	dateFormatter(locale, { weekday: "short" });
const WEEKDAY_LONG = (locale: string = activeLocale()) =>
	dateFormatter(locale, { weekday: "long" });
const WEEKDAY_NARROW = (locale: string = activeLocale()) =>
	dateFormatter(locale, {
		weekday: "narrow",
	});
const MONTH_SHORT = (locale: string = activeLocale()) =>
	dateFormatter(locale, { month: "short" });
const FULL_DATE = (locale: string = activeLocale()) =>
	dateFormatter(locale, {
		day: "numeric",
		month: "long",
		weekday: "long",
		year: "numeric",
	});
const MEDIUM_DATE = (locale: string = activeLocale()) =>
	dateFormatter(locale, {
		day: "numeric",
		month: "short",
		weekday: "short",
	});

/** Parse a local `YYYY-MM-DD` key into local midnight. */
export function parseDayKey(key: string): Date {
	const [year = "1970", month = "1", day = "1"] = key.split("-");
	return new Date(Number(year), Number(month) - 1, Number(day));
}

export function shiftDayKey(key: string, days: number): string {
	const date = parseDayKey(key);
	date.setDate(date.getDate() + days);
	return localDayKey(date);
}

/** The same day `months` away, clamped to the end of a shorter month. */
export function shiftMonthKey(key: string, months: number): string {
	const date = parseDayKey(key);
	const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
	const lastDay = new Date(
		target.getFullYear(),
		target.getMonth() + 1,
		0
	).getDate();
	target.setDate(Math.min(date.getDate(), lastDay));
	return localDayKey(target);
}

export function monthLabel(key: string): string {
	return MONTH_LABEL().format(parseDayKey(key));
}

export function timeLabel(date: Date): string {
	return TIME_LABEL().format(date);
}

export function fullDateLabel(key: string): string {
	return FULL_DATE().format(parseDayKey(key));
}

export function mediumDateLabel(key: string): string {
	return MEDIUM_DATE().format(parseDayKey(key));
}

export function weekdayShort(key: string): string {
	return WEEKDAY_SHORT().format(parseDayKey(key));
}

export function weekdayLong(key: string): string {
	return WEEKDAY_LONG().format(parseDayKey(key));
}

export function weekdayNarrow(date: Date): string {
	return WEEKDAY_NARROW().format(date);
}

export function monthShort(date: Date): string {
	return MONTH_SHORT().format(date);
}
