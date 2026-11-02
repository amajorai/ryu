// Team-chat timestamps for the Channels interface: clock times on messages
// ("10:42 AM"), day dividers ("Today", "Monday, October 6th"), and the thread
// bar's "Last reply …" phrase. English keeps the team-chat ordinal style
// ("October 6th"); every other locale uses its own date formats.

import {
	activeLocale,
	dateFormatter,
	isEnglishLocale,
	translate as tr,
} from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const SAME_WEEK_DAYS = 6;

const CLOCK: Intl.DateTimeFormatOptions = {
	hour: "numeric",
	minute: "2-digit",
};

function parse(iso: string): Date | null {
	const time = Date.parse(iso);
	return Number.isNaN(time) ? null : new Date(time);
}

function startOfDay(date: Date): number {
	return new Date(
		date.getFullYear(),
		date.getMonth(),
		date.getDate()
	).getTime();
}

/** Whole calendar days between `date` and `now` (0 = today, 1 = yesterday). */
function daysAgo(date: Date, now: number): number {
	return Math.round((startOfDay(new Date(now)) - startOfDay(date)) / DAY);
}

/** "1st", "2nd", "3rd", "4th", "11th", "22nd". */
export function ordinal(day: number): string {
	const lastTwo = day % 100;
	if (lastTwo >= 11 && lastTwo <= 13) {
		return `${day}th`;
	}
	switch (day % 10) {
		case 1:
			return `${day}st`;
		case 2:
			return `${day}nd`;
		case 3:
			return `${day}rd`;
		default:
			return `${day}th`;
	}
}

/** Local calendar day key, used to group messages under one divider. */
export function dayKey(iso: string): string {
	const date = parse(iso);
	if (!date) {
		return "unknown";
	}
	return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** "10:42 AM" in English; the locale's own clock elsewhere. */
export function clockTime(
	iso: string,
	locale: string = activeLocale()
): string {
	const date = parse(iso);
	return date ? dateFormatter(locale, CLOCK).format(date) : "";
}

/**
 * Divider label: "Today", "Yesterday", "Monday, October 6th" in English;
 * the locale's long weekday and date elsewhere ("Montag, 6. Oktober").
 */
export function dayLabel(
	iso: string,
	now: number = Date.now(),
	locale: string = activeLocale()
): string {
	const date = parse(iso);
	if (!date) {
		return tr("Earlier");
	}
	const days = daysAgo(date, now);
	if (days <= 0) {
		return tr("Today");
	}
	if (days === 1) {
		return tr("Yesterday");
	}
	const thisYear = date.getFullYear() === new Date(now).getFullYear();
	if (!isEnglishLocale(locale)) {
		return dateFormatter(locale, {
			day: "numeric",
			month: "long",
			weekday: "long",
			year: thisYear ? undefined : "numeric",
		}).format(date);
	}
	const weekday = dateFormatter(locale, { weekday: "long" }).format(date);
	const month = dateFormatter(locale, { month: "long" }).format(date);
	const label = `${weekday}, ${month} ${ordinal(date.getDate())}`;
	return thisYear ? label : `${label}, ${date.getFullYear()}`;
}

/** The thread bar's "Last reply …" phrase, without the "Last reply" prefix. */
export function lastReplyPhrase(
	iso: string,
	tl: LiteralMessage,
	now: number = Date.now(),
	locale: string = activeLocale()
): string {
	const date = parse(iso);
	if (!date) {
		return "";
	}
	const minutes = Math.floor((now - date.getTime()) / MINUTE);
	if (minutes < 1) {
		return tl("just now");
	}
	if (minutes < 60) {
		return tl("{minutes, plural, one {# minute ago} other {# minutes ago}}", {
			minutes,
		});
	}
	const days = daysAgo(date, now);
	if (days <= 0) {
		return tl("today at {time}", { time: clockTime(iso, locale) });
	}
	if (days === 1) {
		return tl("yesterday at {time}", { time: clockTime(iso, locale) });
	}
	if (days <= SAME_WEEK_DAYS) {
		return tl("{days, plural, one {# day ago} other {# days ago}}", { days });
	}
	if (!isEnglishLocale(locale)) {
		return dateFormatter(locale, { day: "numeric", month: "short" }).format(
			date
		);
	}
	const month = dateFormatter(locale, { month: "short" }).format(date);
	return `${month} ${ordinal(date.getDate())}`;
}

/** True when two timestamps are within `windowMs` of each other. */
export function withinWindow(
	earlierIso: string,
	laterIso: string,
	windowMs: number
): boolean {
	const earlier = Date.parse(earlierIso);
	const later = Date.parse(laterIso);
	if (Number.isNaN(earlier) || Number.isNaN(later)) {
		return false;
	}
	return Math.abs(later - earlier) <= windowMs;
}
