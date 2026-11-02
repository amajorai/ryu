import { activeLocale, dateFormatter, translate as tr } from "@ryu/i18n/lite";
import {
	type InterfaceEvent,
	type InterfaceThread,
	localDayKey,
} from "@ryuhq/protocol/interfaces";

// ---------------------------------------------------------------------------
// Activity timeline
// ---------------------------------------------------------------------------

/** One entry on a record's activity timeline: a thread or a scheduled run. */
export type RecordsActivityItem =
	| { at: string; id: string; kind: "thread"; thread: InterfaceThread }
	| { at: string; event: InterfaceEvent; id: string; kind: "run" };

export interface RecordsActivityDay {
	items: RecordsActivityItem[];
	key: string;
	label: string;
}

export const DAY = 86_400_000;

/** "Today", "Yesterday", a weekday within the week, else a date. */
export function recordsDayLabel(
	key: string,
	now: number,
	locale: string = activeLocale()
): string {
	const today = localDayKey(new Date(now));
	if (key === today) {
		return tr("Today");
	}
	if (key === localDayKey(new Date(now - DAY))) {
		return tr("Yesterday");
	}
	const [year, month, day] = key.split("-").map(Number);
	const date = new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
	if (now - date.getTime() < 6 * DAY) {
		return dateFormatter(locale, { weekday: "long" }).format(date);
	}
	const sameYear = date.getFullYear() === new Date(now).getFullYear();
	return dateFormatter(locale, {
		day: "numeric",
		month: "long",
		...(sameYear ? {} : { year: "numeric" }),
	}).format(date);
}

function byNewest(a: RecordsActivityItem, b: RecordsActivityItem): number {
	return b.at.localeCompare(a.at) || a.id.localeCompare(b.id);
}

/**
 * A record's threads and past scheduled runs, merged and grouped by local
 * day, newest day first.
 */
export function recordsActivity(
	threads: readonly InterfaceThread[],
	now: number,
	runs: readonly InterfaceEvent[] = []
): RecordsActivityDay[] {
	const items: RecordsActivityItem[] = [
		...threads.map((thread) => ({
			at: thread.updatedAt,
			id: thread.id,
			kind: "thread" as const,
			thread,
		})),
		...runs
			.filter((event) => event.kind === "past")
			.map((event) => ({
				at: event.end ?? event.start,
				event,
				id: event.id,
				kind: "run" as const,
			})),
	].sort(byNewest);
	const days: RecordsActivityDay[] = [];
	for (const item of items) {
		const at = Date.parse(item.at);
		const key = Number.isNaN(at) ? "unknown" : localDayKey(new Date(at));
		const last = days.at(-1);
		if (last && last.key === key) {
			last.items.push(item);
		} else {
			days.push({
				items: [item],
				key,
				label: key === "unknown" ? "Earlier" : recordsDayLabel(key, now),
			});
		}
	}
	return days;
}
