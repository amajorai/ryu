import { activeLocale, dateFormatter, translate as tr } from "@ryu/i18n/lite";
import { localDayKey } from "@ryuhq/protocol/interfaces";

/** Calendar label for a local day relative to now ("Today", "Yesterday", "Oct 5"). */
export function dayLabel(
	iso: string,
	now: number = Date.now(),
	locale: string = activeLocale()
): string {
	const date = new Date(iso);
	const today = new Date(now);
	const key = localDayKey(date);
	if (key === localDayKey(today)) {
		return tr("Today");
	}
	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	if (key === localDayKey(yesterday)) {
		return tr("Yesterday");
	}
	const sameYear = date.getFullYear() === today.getFullYear();
	return dateFormatter(locale, {
		day: "numeric",
		month: "short",
		...(sameYear ? {} : { year: "numeric" }),
	}).format(date);
}

/** Clock time for a log row ("9:41 AM"). */
export function clockTime(
	iso: string,
	locale: string = activeLocale()
): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return "";
	}
	return dateFormatter(locale, { hour: "numeric", minute: "2-digit" }).format(
		date
	);
}

/** Day and clock time for a detail line ("Today 9:41 AM", "Oct 5 9:41 AM"). */
export function dayTime(iso: string, now: number = Date.now()): string {
	const time = clockTime(iso);
	return time ? tr("{day} {time}", { day: dayLabel(iso, now), time }) : "";
}

/** Full date and time for a `title` tooltip. */
export function fullTime(iso: string, locale: string = activeLocale()): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return "";
	}
	return dateFormatter(locale, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(date);
}
