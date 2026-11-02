import {
	activeLocale,
	dateFormatter,
	relativeTimeFormatter,
	translate as tr,
} from "@ryu/i18n/lite";
import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
} from "@ryuhq/protocol/interfaces";
import { threadStatusLabel } from "./interface-renderer.ts";
import { HOUR, type RecordsRow, type RecordsSortKey } from "./records-model.ts";
import { DAY } from "./records-model-activity.ts";

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const MINUTE = 60_000;

/** "Oct 5", with the year when it is not this year, in the UI locale. */
function shortDate(then: number, now: number, locale: string): string {
	const date = new Date(then);
	return dateFormatter(locale, {
		day: "numeric",
		month: "short",
		...(date.getFullYear() === new Date(now).getFullYear()
			? {}
			: { year: "numeric" }),
	}).format(date);
}

/** Attio-style relative time: "Just now", "18m ago", "Yesterday", "Oct 5". */
export function recordsRelativeTime(
	iso: string | null,
	now: number,
	locale: string = activeLocale()
): string | null {
	if (!iso) {
		return null;
	}
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return null;
	}
	const elapsed = Math.max(0, now - then);
	if (elapsed < MINUTE) {
		return tr("Just now");
	}
	const ago = relativeTimeFormatter(locale, "narrow", "always");
	if (elapsed < HOUR) {
		return ago.format(-Math.floor(elapsed / MINUTE), "minute");
	}
	const key = localDayKey(new Date(then));
	if (key === localDayKey(new Date(now))) {
		return ago.format(-Math.floor(elapsed / HOUR), "hour");
	}
	if (key === localDayKey(new Date(now - DAY))) {
		return tr("Yesterday");
	}
	if (elapsed < 7 * DAY) {
		return ago.format(-Math.max(2, Math.round(elapsed / DAY)), "day");
	}
	return shortDate(then, now, locale);
}

/** Time until a scheduled run: "in 45m", "in 3h", "Tomorrow", "in 3d", "Oct 5". */
export function recordsTimeUntil(
	iso: string | null,
	now: number,
	locale: string = activeLocale()
): string | null {
	if (!iso) {
		return null;
	}
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return null;
	}
	const ahead = Math.max(0, then - now);
	if (ahead < MINUTE) {
		return tr("Now");
	}
	const until = relativeTimeFormatter(locale, "narrow", "always");
	if (ahead < HOUR) {
		return until.format(Math.floor(ahead / MINUTE), "minute");
	}
	const key = localDayKey(new Date(then));
	if (key === localDayKey(new Date(now))) {
		return until.format(Math.floor(ahead / HOUR), "hour");
	}
	if (key === localDayKey(new Date(now + DAY))) {
		return tr("Tomorrow");
	}
	if (ahead < 7 * DAY) {
		return until.format(Math.max(2, Math.round(ahead / DAY)), "day");
	}
	return shortDate(then, now, locale);
}

/** A run's day and clock time: "Today, 9:00 AM", "Tomorrow, 9:00 AM", "Fri, 5:00 PM". */
export function recordsRunTime(
	iso: string,
	now: number,
	locale: string = activeLocale()
): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return "";
	}
	const date = new Date(then);
	const time = recordsClockTime(iso, locale);
	const key = localDayKey(date);
	if (key === localDayKey(new Date(now))) {
		return tr("Today, {time}", { time });
	}
	if (key === localDayKey(new Date(now + DAY))) {
		return tr("Tomorrow, {time}", { time });
	}
	const day =
		Math.abs(then - now) < 6 * DAY
			? dateFormatter(locale, { weekday: "short" }).format(date)
			: dateFormatter(locale, { day: "numeric", month: "short" }).format(date);
	return tr("{day}, {time}", { day, time });
}

/** Clock time for an activity entry: "14:05" style in the UI locale. */
export function recordsClockTime(
	iso: string,
	locale: string = activeLocale()
): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return "";
	}
	return dateFormatter(locale, { hour: "numeric", minute: "2-digit" }).format(
		new Date(then)
	);
}

/** Full date and time for tooltips and `title` attributes. */
export function recordsFullTime(
	iso: string | null,
	locale: string = activeLocale()
): string | undefined {
	if (!iso) {
		return undefined;
	}
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return undefined;
	}
	return dateFormatter(locale, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(then));
}

/** Status label for a record: a record with no threads reads "No threads". */
export function recordsStatusLabel(row: RecordsRow): string {
	if (row.status === "quiet" && row.threads.length === 0) {
		return tr("No threads");
	}
	return threadStatusLabel(row.status);
}

/** The `startThread` input that files a new thread under a record. */
export function recordsStartInput(row: RecordsRow): {
	agentId?: string;
	projectId?: string;
	teamId?: string;
} {
	if (row.object === "agents") {
		return { agentId: row.id };
	}
	if (row.object === "teams") {
		return { teamId: row.id };
	}
	return { projectId: row.id };
}

/** A thread title that is never blank. */
export function recordsThreadTitle(thread: InterfaceThread): string {
	return thread.title.trim() || tr("Untitled thread");
}

/** The latest message line, attributed when the user wrote it. */
export function recordsLatestLine(thread: InterfaceThread): string | null {
	const text = thread.lastMessage?.trim();
	if (!text) {
		return null;
	}
	return thread.lastMessageRole === "user" ? tr("You: {text}", { text }) : text;
}

/** A thread's agent names, in thread order. */
export function recordsThreadAgents(
	snapshot: InterfaceSnapshot,
	thread: InterfaceThread
): InterfaceAgent[] {
	return thread.agentIds
		.map((agentId) => snapshot.agents.find((agent) => agent.id === agentId))
		.filter((agent): agent is InterfaceAgent => agent !== undefined);
}

/** A sort key's label in the UI language. */
export function recordsSortLabel(key: RecordsSortKey): string {
	switch (key) {
		case "lastInteraction":
			return tr("Last interaction");
		case "name":
			return tr("Name");
		case "needsYou":
			return tr("Needs you");
		case "status":
			return tr("Status");
		default:
			return tr("Threads");
	}
}
