// apps/desktop/src/components/calendar/TimeGridView-hour-label.ts
//
// The week/day grid's hour gutter label. It follows the active i18n locale,
// like the column headers above it: the locale's 12/24-hour clock (`3:00 PM`
// in en-US, `15:00` in German, `오후 3:00` in Korean) and its digits. Hours are wall-clock slots, not instants, so a fixed UTC date keeps
// the label free of the machine's time zone and DST.

const HOUR_LABEL: Intl.DateTimeFormatOptions = {
	hour: "numeric",
	minute: "2-digit",
	timeZone: "UTC",
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function hourFormatter(locale: string | undefined): Intl.DateTimeFormat {
	const key = locale ?? "";
	const hit = formatters.get(key);
	if (hit) {
		return hit;
	}
	let made: Intl.DateTimeFormat;
	try {
		made = new Intl.DateTimeFormat(locale, HOUR_LABEL);
	} catch {
		made = new Intl.DateTimeFormat(undefined, HOUR_LABEL);
	}
	formatters.set(key, made);
	return made;
}

/** The gutter label for `hour` (0-23) in `locale` (undefined: runtime default). */
export function formatGridHourLabel(hour: number, locale?: string): string {
	const bounded = Math.max(0, Math.min(23, Math.trunc(hour)));
	return hourFormatter(locale).format(new Date(Date.UTC(2000, 0, 1, bounded)));
}
