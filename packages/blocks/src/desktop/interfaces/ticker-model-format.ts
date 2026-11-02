import {
	activeLocale,
	dateFormatter,
	numberFormatter,
	relativeTimeFormatter,
	translate as tr,
} from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const MINUS = "−";
/** Whole numbers in the UI locale. */
const integerFormat = {
	format: (value: number) => numberFormatter(activeLocale()).format(value),
};
/** One-decimal percentages in the UI locale. */
const percentFormat = {
	format: (value: number) =>
		numberFormatter(activeLocale(), {
			maximumFractionDigits: 1,
			minimumFractionDigits: 1,
		}).format(value),
};

export function formatPrice(value: number): string {
	return integerFormat.format(value);
}

/** "+2", "−1", "0" with a true minus sign. */
export function formatChange(value: number): string {
	if (value > 0) {
		return `+${integerFormat.format(value)}`;
	}
	if (value < 0) {
		return `${MINUS}${integerFormat.format(-value)}`;
	}
	return "0";
}

/** "+100.0%", "−50.0%", "0.0%"; null (no previous close) reads "—". */
export function formatPercent(value: number | null): string {
	if (value === null) {
		return "—";
	}
	if (value > 0) {
		return `+${percentFormat.format(value)}%`;
	}
	if (value < 0) {
		return `${MINUS}${percentFormat.format(-value)}%`;
	}
	return `${percentFormat.format(0)}%`;
}

/**
 * Spoken change, e.g. "up 2 messages in threads active today, 7.1 percent".
 * It names what is counted: every message of a thread last active today,
 * since threads do not date their individual messages.
 */
export function describeChange(
	change: number,
	changePercent: number | null,
	tl: LiteralMessage
): string {
	if (change === 0) {
		return tl("no threads active today");
	}
	const count = Math.abs(change);
	const values = {
		amount: integerFormat.format(count),
		count,
		direction: change > 0 ? "up" : "down",
	};
	if (changePercent === null) {
		return tl(
			"{direction, select, up {up} other {down}} {amount} {count, plural, one {message} other {messages}} in threads active today, none before today",
			values
		);
	}
	return tl(
		"{direction, select, up {up} other {down}} {amount} {count, plural, one {message} other {messages}} in threads active today, {percent} percent",
		{ ...values, percent: percentFormat.format(Math.abs(changePercent)) }
	);
}

/** "Wed, Oct 14", in the UI locale. */
export function formatDay(date: number): string {
	return dateFormatter(activeLocale(), {
		day: "numeric",
		month: "short",
		weekday: "short",
	}).format(new Date(date));
}

/** "Oct 14", in the UI locale. */
export function formatShortDay(date: number): string {
	return dateFormatter(activeLocale(), {
		day: "numeric",
		month: "short",
	}).format(new Date(date));
}

const CLOCK: Intl.DateTimeFormatOptions = {
	hour: "2-digit",
	hour12: false,
	minute: "2-digit",
};

/** "22:15", 24-hour. */
export function formatClock(date: number): string {
	return dateFormatter(activeLocale(), CLOCK).format(new Date(date));
}

/** "Wed 22:15". */
export function formatWeekdayClock(date: number): string {
	const value = new Date(date);
	return tr("{weekday} {time}", {
		time: formatClock(date),
		weekday: dateFormatter(activeLocale(), { weekday: "short" }).format(value),
	});
}

/**
 * An age read aloud, in the UI locale: "just now", "5 minutes ago",
 * "3 hours ago". An unparsable time reads as "".
 */
export function spokenAge(
	iso: string,
	now: number,
	locale: string = activeLocale()
): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return "";
	}
	const minutes = Math.max(0, Math.floor((now - then) / 60_000));
	if (minutes < 1) {
		return tr("just now");
	}
	const ago = relativeTimeFormatter(locale, "long", "always");
	if (minutes < 60) {
		return ago.format(-minutes, "minute");
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return ago.format(-hours, "hour");
	}
	const days = Math.floor(hours / 24);
	return days < 7
		? ago.format(-days, "day")
		: ago.format(-Math.floor(days / 7), "week");
}

/** A ticker range's name ("2 weeks"), in the UI language. */
export function tickerRangeName(range: 7 | 14 | 30): string {
	return tr("{count, plural, =7 {1 week} =14 {2 weeks} other {1 month}}", {
		count: range,
	});
}
