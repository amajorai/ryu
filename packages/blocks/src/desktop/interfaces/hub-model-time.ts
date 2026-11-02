import { activeLocale, dateFormatter, translate as tr } from "@ryu/i18n/lite";
import type { InterfaceEvent } from "@ryuhq/protocol/interfaces";

/** Hub times: thread ages, upcoming runs, and the failed-run list, in the UI locale. */

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "now", "4 min ago", "3 hr ago", "Yesterday", "Oct 5", in the UI locale. */
export function hubAgo(
	iso: string,
	now: number,
	locale: string = activeLocale()
): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return "";
	}
	const elapsed = Math.max(0, now - then);
	if (elapsed < MINUTE_MS) {
		return tr("now");
	}
	if (elapsed < HOUR_MS) {
		return tr("{minutes} min ago", {
			minutes: Math.floor(elapsed / MINUTE_MS),
		});
	}
	if (elapsed < DAY_MS) {
		return tr("{hours} hr ago", {
			hours: Math.floor(elapsed / HOUR_MS),
		});
	}
	if (elapsed < 2 * DAY_MS) {
		return tr("Yesterday");
	}
	return dateFormatter(locale, { day: "numeric", month: "short" }).format(
		new Date(then)
	);
}

function startOfDay(time: number): number {
	const date = new Date(time);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

/** When a run starts, as parts both the row and the headline phrase. */
type RunWhen =
	| { kind: "now" }
	| { count: number; kind: "hours" | "minutes" }
	| { kind: "today" | "tomorrow"; time: string }
	| { day: string; kind: "day"; time: string };

function runWhen(iso: string, now: number, locale: string): RunWhen | null {
	const start = Date.parse(iso);
	if (Number.isNaN(start)) {
		return null;
	}
	const until = start - now;
	if (until < MINUTE_MS) {
		return { kind: "now" };
	}
	const minutes = Math.round(until / MINUTE_MS);
	if (minutes < 60) {
		return { count: minutes, kind: "minutes" };
	}
	// Within a few hours a countdown reads faster than a clock time, even
	// across midnight.
	if (minutes < 6 * 60) {
		return { count: Math.round(minutes / 60), kind: "hours" };
	}
	const days = Math.round((startOfDay(start) - startOfDay(now)) / DAY_MS);
	const date = new Date(start);
	const time = dateFormatter(locale, {
		hour: "numeric",
		minute: "2-digit",
	}).format(date);
	if (days === 0) {
		return { kind: "today", time };
	}
	if (days === 1) {
		return { kind: "tomorrow", time };
	}
	const day = dateFormatter(
		locale,
		days < 7 ? { weekday: "short" } : { day: "numeric", month: "short" }
	).format(date);
	return { day, kind: "day", time };
}

/**
 * When a scheduled run starts, in the reference's words: "In 40 min",
 * "In 3 hr", "Tomorrow, 9:00 AM", "Fri, 5:00 PM", "Oct 23, 9:00 AM". Every
 * dated form carries its time, so rows in one list read alike.
 */
export function hubRunWhen(
	iso: string,
	now: number,
	locale: string = activeLocale()
): string {
	const when = runWhen(iso, now, locale);
	if (!when) {
		return "";
	}
	switch (when.kind) {
		case "now":
			return tr("Now");
		case "minutes":
			return tr("In {count} min", { count: when.count });
		case "hours":
			return tr("In {count} hr", { count: when.count });
		case "today":
			return tr("Today, {time}", { time: when.time });
		case "tomorrow":
			return tr("Tomorrow, {time}", { time: when.time });
		default:
			return tr("{day}, {time}", { day: when.day, time: when.time });
	}
}

/**
 * The Upcoming card's headline: "Next run in 40 min", "Next run tomorrow at
 * 9:00 AM", "Next run Fri at 5:00 PM", "Next run soon" with no time.
 */
export function hubNextRunHeadline(
	iso: string | null,
	now: number,
	locale: string = activeLocale()
): string {
	const when = iso ? runWhen(iso, now, locale) : null;
	// The day period stays with its time when the headline wraps.
	const time =
		when && "time" in when ? when.time.replace(/\s(?=[AP]M\b)/, "\u00a0") : "";
	if (!when) {
		return tr("Next run soon");
	}
	switch (when.kind) {
		case "now":
			return tr("A run is starting now");
		case "minutes":
			return tr("Next run in {count} min", { count: when.count });
		case "hours":
			return tr("Next run in {count} hr", { count: when.count });
		case "today":
			return tr("Next run at {time}", { time });
		case "tomorrow":
			return tr("Next run tomorrow at {time}", { time });
		default:
			return tr("Next run {day} at {time}", { day: when.day, time });
	}
}

export function hubUpcoming(
	events: InterfaceEvent[] | undefined,
	now: number
): InterfaceEvent[] {
	return (events ?? [])
		.filter(
			(event) =>
				event.kind === "upcoming" && Date.parse(event.start) >= now - MINUTE_MS
		)
		.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
}

/** Past runs that failed in the last day, shown under failed threads. */
export function hubFailedRuns(
	events: InterfaceEvent[] | undefined,
	now: number
): InterfaceEvent[] {
	return (events ?? [])
		.filter(
			(event) =>
				event.kind === "past" &&
				event.outcome === "failure" &&
				now - Date.parse(event.start) < 2 * DAY_MS
		)
		.sort((a, b) => b.start.localeCompare(a.start));
}
