// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const MINUS = "−";
const integerFormat = new Intl.NumberFormat("en-US");
const percentFormat = new Intl.NumberFormat("en-US", {
	maximumFractionDigits: 1,
	minimumFractionDigits: 1,
});

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
	changePercent: number | null
): string {
	if (change === 0) {
		return "no threads active today";
	}
	const amount = Math.abs(change);
	const noun = amount === 1 ? "message" : "messages";
	const percent =
		changePercent === null
			? "none before today"
			: `${percentFormat.format(Math.abs(changePercent))} percent`;
	return `${change > 0 ? "up" : "down"} ${integerFormat.format(amount)} ${noun} in threads active today, ${percent}`;
}

const dayFormat = new Intl.DateTimeFormat("en-US", {
	day: "numeric",
	month: "short",
	weekday: "short",
});
const shortDayFormat = new Intl.DateTimeFormat("en-US", {
	day: "numeric",
	month: "short",
});

export function formatDay(date: number): string {
	return dayFormat.format(new Date(date));
}

export function formatShortDay(date: number): string {
	return shortDayFormat.format(new Date(date));
}

const clockFormat = new Intl.DateTimeFormat("en-US", {
	hour: "2-digit",
	hour12: false,
	minute: "2-digit",
});
const weekdayFormat = new Intl.DateTimeFormat("en-US", { weekday: "short" });

/** "22:15", 24-hour. */
export function formatClock(date: number): string {
	return clockFormat.format(new Date(date));
}

/** "Wed 22:15". */
export function formatWeekdayClock(date: number): string {
	const value = new Date(date);
	return `${weekdayFormat.format(value)} ${clockFormat.format(value)}`;
}

const SPOKEN_UNITS: Record<string, string> = {
	d: "day",
	h: "hour",
	m: "minute",
	s: "second",
	w: "week",
};

/** A compact age ("5m") read aloud: "5 minutes ago"; "now" is "just now". */
export function spokenAge(age: string): string {
	const match = age.match(/^(\d+)([smhdw])$/);
	if (!match) {
		return age === "now" ? "just now" : age;
	}
	const count = Number(match[1]);
	const unit = SPOKEN_UNITS[match[2] ?? ""] ?? "";
	return `${count} ${count === 1 ? unit : `${unit}s`} ago`;
}

export function plural(count: number, noun: string): string {
	return `${integerFormat.format(count)} ${count === 1 ? noun : `${noun}s`}`;
}
