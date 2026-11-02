import {
	activeLocale,
	dateFormatter,
	formatRelativeTime,
	translate as tr,
} from "@ryu/i18n/lite";

/** Notebook edit and run times, in the UI locale. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Notion-style relative edit time: "Just now", "5 minutes ago", "Oct 4". */
export function notebookEditedLabel(
	iso: string,
	now: number,
	locale: string = activeLocale()
): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return "";
	}
	const elapsed = Math.max(0, now - then);
	if (elapsed < MINUTE) {
		return tr("Just now");
	}
	if (elapsed >= DAY && elapsed < 2 * DAY) {
		return tr("Yesterday");
	}
	if (elapsed < 7 * DAY) {
		return formatRelativeTime(locale, now - elapsed, {
			now,
			numeric: "always",
		});
	}
	const date = new Date(then);
	const sameYear = date.getFullYear() === new Date(now).getFullYear();
	return dateFormatter(locale, {
		day: "numeric",
		month: "short",
		...(sameYear ? {} : { year: "numeric" }),
	}).format(date);
}

/** Full timestamp for the "Last edited" property ("October 13, 2026 2:41 PM"). */
export function notebookTimestamp(
	iso: string,
	locale: string = activeLocale()
): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) {
		return "";
	}
	return dateFormatter(locale, {
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		month: "long",
		year: "numeric",
	}).format(new Date(then));
}

/**
 * When an upcoming run starts, as a day line and a time line:
 * { day: "In 45 min", time: "6:52 PM" }, { day: "Tomorrow", time: "9:00 AM" }.
 * Every run has both lines, so the rows share one rhythm.
 */
export function notebookRunTime(
	iso: string,
	now: number,
	locale: string = activeLocale()
): { day: string; time: string | null } {
	const start = Date.parse(iso);
	if (Number.isNaN(start)) {
		return { day: "", time: null };
	}
	const ahead = start - now;
	const date = new Date(start);
	const time = dateFormatter(locale, {
		hour: "numeric",
		minute: "2-digit",
	}).format(date);
	if (ahead < HOUR) {
		const minutes = Math.max(1, Math.floor(ahead / MINUTE));
		return {
			day: tr("In {minutes} min", { minutes }),
			time,
		};
	}
	const today = new Date(now);
	const dayDiff = Math.round(
		(new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() -
			new Date(
				today.getFullYear(),
				today.getMonth(),
				today.getDate()
			).getTime()) /
			DAY
	);
	if (dayDiff === 0) {
		return { day: tr("Today"), time };
	}
	if (dayDiff === 1) {
		return { day: tr("Tomorrow"), time };
	}
	const day = dateFormatter(locale, {
		day: "numeric",
		month: "short",
		weekday: "short",
	}).format(date);
	return { day, time };
}
