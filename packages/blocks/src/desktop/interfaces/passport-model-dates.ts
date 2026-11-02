import {
	activeLocale,
	dateFormatter,
	isEnglishLocale,
	translate as tr,
} from "@ryu/i18n/lite";
import { localDayKey } from "@ryuhq/protocol/interfaces";
import type { PassportStamp } from "./passport-model.ts";

/**
 * Passport stamp dates. English keeps the printed stamp style ("14 OCT
 * 2026"); every other UI locale prints its own day-month-year, uppercased
 * only where the script has letter case.
 */

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

/** The English month abbreviation ("Oct"), as the stamp prints it. */
function englishMonth(date: Date): string {
	return dateFormatter("en-US", { month: "short" }).format(date);
}

/** "14 OCT 2026", the way entry stamps print a date. */
export function stampDate(
	time: number,
	locale: string = activeLocale()
): string {
	const date = new Date(time);
	if (isEnglishLocale(locale)) {
		return `${pad(date.getDate())} ${englishMonth(date).toUpperCase()} ${date.getFullYear()}`;
	}
	return dateFormatter(locale, {
		day: "2-digit",
		month: "short",
		year: "numeric",
	})
		.format(date)
		.toLocaleUpperCase(locale);
}

/** "14 Oct 2026": the stamp's date as a person reads it, for speech. */
export function spokenDate(
	time: number,
	locale: string = activeLocale()
): string {
	const date = new Date(time);
	if (isEnglishLocale(locale)) {
		return `${pad(date.getDate())} ${englishMonth(date)} ${date.getFullYear()}`;
	}
	return dateFormatter(locale, { dateStyle: "medium" }).format(date);
}

/** "14 OCT": day and month, for short date lines. */
export function stampDayMonth(
	time: number,
	locale: string = activeLocale()
): string {
	const date = new Date(time);
	if (isEnglishLocale(locale)) {
		return `${pad(date.getDate())} ${englishMonth(date).toUpperCase()}`;
	}
	return dateFormatter(locale, { day: "2-digit", month: "short" })
		.format(date)
		.toLocaleUpperCase(locale);
}

/** "09:41", 24-hour local time. */
export function stampTime(time: number): string {
	const date = new Date(time);
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * The stamp's second date line: the time when the latest activity fell on the
 * entry day, otherwise the latest day.
 */
export function latestLine(stamp: Pick<PassportStamp, "entryAt" | "latestAt">) {
	const sameDay =
		localDayKey(new Date(stamp.entryAt)) ===
		localDayKey(new Date(stamp.latestAt));
	return tr("LAST {when}", {
		when: sameDay ? stampTime(stamp.latestAt) : stampDayMonth(stamp.latestAt),
	});
}
