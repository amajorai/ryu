import {
	activeLocale,
	dateFormatter,
	relativeTimeFormatter,
	translate as tr,
} from "@ryu/i18n/lite";
import { localDayKey } from "@ryuhq/protocol/interfaces";

// ---------------------------------------------------------------------------
// Time formatting, in the UI locale
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function clockTime(date: Date, locale: string): string {
	return dateFormatter(locale, { hour: "numeric", minute: "2-digit" }).format(
		date
	);
}

/** "in 40m": a run starting within the hour. */
function soon(delta: number, locale: string): string {
	const minutes = Math.min(59, Math.max(1, Math.round(delta / MINUTE)));
	return relativeTimeFormatter(locale, "narrow", "always").format(
		minutes,
		"minute"
	);
}

/** A run's start split for a two-line time column: "3:30 PM" over "Today". */
export function runWhenParts(
	iso: string,
	now: number,
	locale: string = activeLocale()
): { day: string; time: string } {
	const start = Date.parse(iso);
	if (Number.isNaN(start)) {
		return { day: "", time: "" };
	}
	const date = new Date(start);
	const delta = start - now;
	const time = clockTime(date, locale);
	if (delta >= 0 && delta < HOUR) {
		return { day: soon(delta, locale), time };
	}
	if (localDayKey(date) === localDayKey(new Date(now))) {
		return { day: tr("Today"), time };
	}
	if (localDayKey(date) === localDayKey(new Date(now + DAY))) {
		return { day: tr("Tomorrow"), time };
	}
	const day =
		delta > 0 && delta < 6 * DAY
			? dateFormatter(locale, { weekday: "long" }).format(date)
			: dateFormatter(locale, { day: "numeric", month: "short" }).format(date);
	return { day, time };
}

/** "in 40m", "Today, 3:30 PM", "Tomorrow, 9:00 AM", "Fri, 5:00 PM", "Oct 23". */
export function runWhen(
	iso: string,
	now: number,
	locale: string = activeLocale()
): string {
	const start = Date.parse(iso);
	if (Number.isNaN(start)) {
		return "";
	}
	const delta = start - now;
	if (delta >= 0 && delta < HOUR) {
		return soon(delta, locale);
	}
	const date = new Date(start);
	const time = clockTime(date, locale);
	if (localDayKey(date) === localDayKey(new Date(now))) {
		return tr("Today, {time}", { time });
	}
	if (localDayKey(date) === localDayKey(new Date(now + DAY))) {
		return tr("Tomorrow, {time}", { time });
	}
	if (delta > 0 && delta < 6 * DAY) {
		const day = dateFormatter(locale, { weekday: "short" }).format(date);
		return tr("{day}, {time}", { day, time });
	}
	return dateFormatter(locale, { day: "numeric", month: "short" }).format(date);
}

/** "Wednesday, October 14" for the Home header. */
export function longDate(date: Date, locale: string = activeLocale()): string {
	return dateFormatter(locale, {
		day: "numeric",
		month: "long",
		weekday: "long",
	}).format(date);
}

export function shortClock(
	date: Date,
	locale: string = activeLocale()
): string {
	return clockTime(date, locale);
}
