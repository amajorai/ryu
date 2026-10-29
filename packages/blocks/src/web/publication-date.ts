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

const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/u;

export function formatPublicationDate(
	date: string,
	month: "long" | "short"
): string {
	return new Date(date).toLocaleDateString("en-US", {
		year: "numeric",
		month,
		day: "numeric",
		...(CALENDAR_DAY.test(date) ? { timeZone: "UTC" } : {}),
	});
}
