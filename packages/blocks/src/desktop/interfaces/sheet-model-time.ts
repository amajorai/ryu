import {
	activeLocale,
	dateFormatter,
	relativeTimeFormatter,
	translate as tr,
} from "@ryu/i18n/lite";

// ---------------------------------------------------------------------------
// Time, in the UI locale
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "Just now", "4m ago", "3h ago", "Yesterday", "5d ago", then a date. */
export function sheetRelativeTime(
	timestamp: number,
	now: number,
	locale: string = activeLocale()
): string {
	if (timestamp <= 0) {
		return "";
	}
	const elapsed = Math.max(0, now - timestamp);
	if (elapsed < MINUTE) {
		return tr("Just now");
	}
	const ago = relativeTimeFormatter(locale, "narrow", "always");
	if (elapsed < HOUR) {
		return ago.format(-Math.floor(elapsed / MINUTE), "minute");
	}
	if (elapsed < DAY) {
		return ago.format(-Math.floor(elapsed / HOUR), "hour");
	}
	if (elapsed < 2 * DAY) {
		return tr("Yesterday");
	}
	if (elapsed < 7 * DAY) {
		return ago.format(-Math.floor(elapsed / DAY), "day");
	}
	const date = new Date(timestamp);
	return dateFormatter(locale, {
		day: "numeric",
		month: "short",
		...(date.getFullYear() === new Date(now).getFullYear()
			? {}
			: { year: "numeric" }),
	}).format(date);
}

/** The exact time a relative age stands for, for tooltips and `<time>`. */
export function sheetAbsoluteTime(
	timestamp: number,
	locale: string = activeLocale()
): string {
	return timestamp > 0
		? dateFormatter(locale, { dateStyle: "full", timeStyle: "short" }).format(
				new Date(timestamp)
			)
		: "";
}
