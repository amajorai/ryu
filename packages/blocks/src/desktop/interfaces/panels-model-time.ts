import { localDayKey } from "@ryuhq/protocol/interfaces";

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function clockTime(date: Date): string {
	return new Intl.DateTimeFormat(undefined, {
		hour: "numeric",
		minute: "2-digit",
	}).format(date);
}

function minutesUntil(delta: number): number {
	return Math.min(59, Math.max(1, Math.round(delta / MINUTE)));
}

/** A run's start split for a two-line time column: "3:30 PM" over "Today". */
export function runWhenParts(
	iso: string,
	now: number
): { day: string; time: string } {
	const start = Date.parse(iso);
	if (Number.isNaN(start)) {
		return { day: "", time: "" };
	}
	const date = new Date(start);
	const delta = start - now;
	const time = clockTime(date);
	if (delta >= 0 && delta < HOUR) {
		return { day: `in ${minutesUntil(delta)}m`, time };
	}
	if (localDayKey(date) === localDayKey(new Date(now))) {
		return { day: "Today", time };
	}
	if (localDayKey(date) === localDayKey(new Date(now + DAY))) {
		return { day: "Tomorrow", time };
	}
	const day =
		delta > 0 && delta < 6 * DAY
			? new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(date)
			: new Intl.DateTimeFormat(undefined, {
					day: "numeric",
					month: "short",
				}).format(date);
	return { day, time };
}

/** "in 40m", "Today, 3:30 PM", "Tomorrow, 9:00 AM", "Fri, 5:00 PM", "Oct 23". */
export function runWhen(iso: string, now: number): string {
	const start = Date.parse(iso);
	if (Number.isNaN(start)) {
		return "";
	}
	const delta = start - now;
	if (delta >= 0 && delta < HOUR) {
		return `in ${minutesUntil(delta)}m`;
	}
	const date = new Date(start);
	const today = localDayKey(new Date(now));
	if (localDayKey(date) === today) {
		return `Today, ${clockTime(date)}`;
	}
	if (localDayKey(date) === localDayKey(new Date(now + DAY))) {
		return `Tomorrow, ${clockTime(date)}`;
	}
	if (delta > 0 && delta < 6 * DAY) {
		const weekday = new Intl.DateTimeFormat(undefined, {
			weekday: "short",
		}).format(date);
		return `${weekday}, ${clockTime(date)}`;
	}
	return new Intl.DateTimeFormat(undefined, {
		day: "numeric",
		month: "short",
	}).format(date);
}

/** "Wednesday, October 14" for the Home header. */
export function longDate(date: Date): string {
	return new Intl.DateTimeFormat(undefined, {
		day: "numeric",
		month: "long",
		weekday: "long",
	}).format(date);
}

export function shortClock(date: Date): string {
	return clockTime(date);
}
