import {
	activeLocale,
	dateFormatter,
	formatRelativeTime,
	translate as tr,
} from "@ryu/i18n/lite";
import { localDayKey } from "@ryuhq/protocol/interfaces";

export function clockTime(date: Date, locale: string = activeLocale()): string {
	return dateFormatter(locale, { hour: "numeric", minute: "2-digit" }).format(
		date
	);
}

type DayKind = "date" | "today" | "tomorrow" | "yesterday";

function dayKind(date: Date, now: number): DayKind {
	const key = localDayKey(date);
	const today = new Date(now);
	if (key === localDayKey(today)) {
		return "today";
	}
	const yesterday = new Date(now);
	yesterday.setDate(today.getDate() - 1);
	if (key === localDayKey(yesterday)) {
		return "yesterday";
	}
	const tomorrow = new Date(now);
	tomorrow.setDate(today.getDate() + 1);
	return key === localDayKey(tomorrow) ? "tomorrow" : "date";
}

function shortDate(date: Date, locale: string): string {
	return dateFormatter(locale, {
		day: "numeric",
		month: "short",
		weekday: "short",
	}).format(date);
}

/** "Today", "Yesterday", "Tomorrow", or "Mon, Oct 12", in the UI locale. */
export function dayLabel(
	date: Date,
	now: number,
	locale: string = activeLocale()
): string {
	switch (dayKind(date, now)) {
		case "today":
			return tr("Today");
		case "yesterday":
			return tr("Yesterday");
		case "tomorrow":
			return tr("Tomorrow");
		default:
			return shortDate(date, locale);
	}
}

/** dayLabel for mid-sentence use: "today", "yesterday", or "on Sat, Oct 17". */
export function dayPhrase(
	date: Date,
	now: number,
	locale: string = activeLocale()
): string {
	return tr(
		"{day, select, today {today} yesterday {yesterday} tomorrow {tomorrow} other {on {date}}}",
		{ date: shortDate(date, locale), day: dayKind(date, now) }
	);
}

/** "3 min. ago", "2 hr. ago", "4 days ago": the long form of compactAge. */
export function relativeAge(
	iso: string,
	now: number,
	locale: string = activeLocale()
): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return "";
	}
	if (now - then < 60_000) {
		return tr("just now");
	}
	return formatRelativeTime(locale, Math.min(then, now), {
		now,
		numeric: "always",
		style: "short",
	});
}
