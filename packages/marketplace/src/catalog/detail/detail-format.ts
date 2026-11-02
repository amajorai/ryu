import { activeLocale } from "@ryu/i18n/lite";
import { formatCount as formatSharedCount } from "@ryu/ui/lib/number-format.ts";

/** Render an ISO timestamp as a short absolute date. Absolute rather than
 *  relative on purpose: "2 years ago" is the health tab's job, a version table
 *  wants the date it actually shipped. */
export function formatDate(
	iso?: string | null,
	locale: string = activeLocale()
): string | null {
	if (!iso) {
		return null;
	}
	const parsed = new Date(iso);
	if (Number.isNaN(parsed.getTime())) {
		return null;
	}
	return parsed.toLocaleDateString(locale, {
		day: "numeric",
		month: "short",
		year: "numeric",
	});
}

/** Shared count policy for store metadata and version rows. */
export function formatCount(value: number): string {
	return formatSharedCount(value) ?? "—";
}
