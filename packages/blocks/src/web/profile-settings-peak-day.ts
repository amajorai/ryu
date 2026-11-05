import { dateFormatter } from "@ryu/i18n/format-intl";

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/u;

/**
 * The stats API's peak day (`2026-03-14`, a UTC calendar day) as a localized
 * weekday and date ("Sat, Mar 14, 2026", "2026年3月14日(土)"). Anything that is
 * not an ISO day is returned unchanged.
 */
export function formatPeakDay(
	day: string,
	locale: string | null | undefined = "en"
): string {
	const match = ISO_DAY.exec(day);
	if (!match) {
		return day;
	}
	const date = new Date(
		Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
	);
	if (Number.isNaN(date.getTime())) {
		return day;
	}
	return dateFormatter(locale, {
		day: "numeric",
		month: "short",
		timeZone: "UTC",
		weekday: "short",
		year: "numeric",
	}).format(date);
}
