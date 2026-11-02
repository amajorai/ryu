/**
 * Display text for a marketing content `date` (blog posts and changelog
 * releases).
 *
 * A `date` is either a calendar day (`2026-03-15`) or an RFC 3339 timestamp
 * with an offset (see `apps/web/src/lib/content-dates.ts`). `Date` reads a bare
 * day as UTC midnight, so formatting it in the reader's zone shows the previous
 * day to everyone west of UTC. A calendar day names a day, not an instant, so
 * it is formatted in UTC and reads the same for every reader. A timestamp is an
 * instant and keeps the reader's zone.
 */

import { dateFormatter } from "@ryu/i18n/format-intl";

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/u;

/** `date` in the reader's UI `locale` ("Mar 15, 2026", "15. März 2026"). */
export function formatPublicationDate(
	date: string,
	month: "long" | "short",
	locale: string | null | undefined = "en"
): string {
	const options: Intl.DateTimeFormatOptions = {
		year: "numeric",
		month,
		day: "numeric",
	};
	if (CALENDAR_DAY.test(date)) {
		return dateFormatter(locale, { ...options, timeZone: "UTC" }).format(
			new Date(date)
		);
	}
	// An instant is shown in the reader's current zone. A cached formatter
	// would keep the zone it was built in, so this one is made per call.
	try {
		return new Date(date).toLocaleDateString(locale || "en", options);
	} catch {
		return new Date(date).toLocaleDateString("en", options);
	}
}
