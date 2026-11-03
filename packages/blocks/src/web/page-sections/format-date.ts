import { dateFormatter } from "@ryu/i18n/format-intl";
import { formatPublicationDate } from "../publication-date.ts";

const ISO_DATE = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/;
const LAST_MONTH = 12;

function validMonth(value: string): boolean {
	const month = Number(value);
	return month >= 1 && month <= LAST_MONTH;
}

/** True when the match names a real month and, if given, a real day in it. */
function validDate(match: RegExpMatchArray | null): match is RegExpMatchArray {
	if (!(match?.[2] && validMonth(match[2]))) {
		return false;
	}
	const day = match[3];
	if (!day) {
		return true;
	}
	// Date.UTC rolls "02-30" into March and "04-00" into March 31; a day that
	// does not survive the round trip is not a calendar date.
	const parsed = new Date(
		Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(day))
	);
	return parsed.getUTCDate() === Number(day);
}

/**
 * "2026-04-12" → "Apr 12, 2026" (en) or "12. Apr. 2026" (de); "2026-04" →
 * "Apr 2026" (en) or "2026年4月" (ja). Both are formatted as UTC calendar days, so
 * prerendered output never depends on the server's time zone or the build
 * time. Anything that is not an ISO date is returned as is.
 */
export function formatIsoDate(
	value: string,
	locale: string | null | undefined = "en"
): string {
	const match = value.match(ISO_DATE);
	if (!validDate(match)) {
		return value;
	}
	const [, year, month, day] = match;
	if (day) {
		return formatPublicationDate(value, "short", locale);
	}
	return dateFormatter(locale, {
		year: "numeric",
		month: "short",
		timeZone: "UTC",
	}).format(new Date(Date.UTC(Number(year), Number(month) - 1, 1)));
}

/** True when the value is an ISO calendar date the formatter understands. */
export function isIsoDate(value: string): boolean {
	return validDate(value.match(ISO_DATE));
}
