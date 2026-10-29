// Team-chat timestamps for the Channels interface: clock times on messages
// ("10:42 AM"), day dividers ("Today", "Monday, October 6th"), and the thread
// bar's "Last reply …" phrase. Fixed to en-US so the copy stays stable.

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const SAME_WEEK_DAYS = 6;

const clockFormat = new Intl.DateTimeFormat("en-US", {
	hour: "numeric",
	minute: "2-digit",
});
const weekdayFormat = new Intl.DateTimeFormat("en-US", { weekday: "long" });
const monthFormat = new Intl.DateTimeFormat("en-US", { month: "long" });
const shortMonthFormat = new Intl.DateTimeFormat("en-US", { month: "short" });

function parse(iso: string): Date | null {
	const time = Date.parse(iso);
	return Number.isNaN(time) ? null : new Date(time);
}

function startOfDay(date: Date): number {
	return new Date(
		date.getFullYear(),
		date.getMonth(),
		date.getDate()
	).getTime();
}

/** Whole calendar days between `date` and `now` (0 = today, 1 = yesterday). */
function daysAgo(date: Date, now: number): number {
	return Math.round((startOfDay(new Date(now)) - startOfDay(date)) / DAY);
}

/** "1st", "2nd", "3rd", "4th", "11th", "22nd". */
export function ordinal(day: number): string {
	const lastTwo = day % 100;
	if (lastTwo >= 11 && lastTwo <= 13) {
		return `${day}th`;
	}
	switch (day % 10) {
		case 1:
			return `${day}st`;
		case 2:
			return `${day}nd`;
		case 3:
			return `${day}rd`;
		default:
			return `${day}th`;
	}
}

/** Local calendar day key, used to group messages under one divider. */
export function dayKey(iso: string): string {
	const date = parse(iso);
	if (!date) {
		return "unknown";
	}
	return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** "10:42 AM". */
export function clockTime(iso: string): string {
	const date = parse(iso);
	return date ? clockFormat.format(date) : "";
}

/** Divider label: "Today", "Yesterday", "Monday, October 6th". */
export function dayLabel(iso: string, now: number = Date.now()): string {
	const date = parse(iso);
	if (!date) {
		return "Earlier";
	}
	const days = daysAgo(date, now);
	if (days <= 0) {
		return "Today";
	}
	if (days === 1) {
		return "Yesterday";
	}
	const label = `${weekdayFormat.format(date)}, ${monthFormat.format(date)} ${ordinal(date.getDate())}`;
	return date.getFullYear() === new Date(now).getFullYear()
		? label
		: `${label}, ${date.getFullYear()}`;
}

/** The thread bar's "Last reply …" phrase, without the "Last reply" prefix. */
export function lastReplyPhrase(iso: string, now: number = Date.now()): string {
	const date = parse(iso);
	if (!date) {
		return "";
	}
	const minutes = Math.floor((now - date.getTime()) / MINUTE);
	if (minutes < 1) {
		return "just now";
	}
	if (minutes < 60) {
		return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
	}
	const days = daysAgo(date, now);
	if (days <= 0) {
		return `today at ${clockTime(iso)}`;
	}
	if (days === 1) {
		return `yesterday at ${clockTime(iso)}`;
	}
	if (days <= SAME_WEEK_DAYS) {
		return `${days} days ago`;
	}
	return `${shortMonthFormat.format(date)} ${ordinal(date.getDate())}`;
}

/** True when two timestamps are within `windowMs` of each other. */
export function withinWindow(
	earlierIso: string,
	laterIso: string,
	windowMs: number
): boolean {
	const earlier = Date.parse(earlierIso);
	const later = Date.parse(laterIso);
	if (Number.isNaN(earlier) || Number.isNaN(later)) {
		return false;
	}
	return Math.abs(later - earlier) <= windowMs;
}
