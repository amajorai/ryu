// apps/desktop/src/lib/calendar/events-grouping.ts
//
// Day/job grouping and Agenda status-strip entries for calendar events (split
// from ./events.ts, which re-exports these).

import type { RunStatusTimelineEntry } from "@ryu/ui/components/run-status-timeline.tsx";
import { displayDayKey } from "@/src/lib/calendar/display-days.ts";
import type { CalendarEvent } from "@/src/lib/calendar/events.ts";

/** Group events by display-zone calendar day for grid rendering. */
export function groupEventsByDay(
	events: CalendarEvent[]
): Map<string, CalendarEvent[]> {
	const map = new Map<string, CalendarEvent[]>();
	for (const event of events) {
		const key = displayDayKey(event.start);
		const bucket = map.get(key);
		if (bucket) {
			bucket.push(event);
		} else {
			map.set(key, [event]);
		}
	}
	return map;
}

/** Group a status-page window by scheduled job while preserving event order. */
export function groupEventsByJob(
	events: CalendarEvent[]
): Map<string, CalendarEvent[]> {
	const map = new Map<string, CalendarEvent[]>();
	for (const event of events) {
		const bucket = map.get(event.jobId);
		if (bucket) {
			bucket.push(event);
		} else {
			map.set(event.jobId, [event]);
		}
	}
	return map;
}

/** Convert one calendar day into the status entries used by the Agenda strip. */
export function buildRunStatusTimelineEntries(
	dayStart: Date,
	dayEnd: Date,
	events: CalendarEvent[]
): RunStatusTimelineEntry[] {
	const dayStartAt = dayStart.getTime();
	const dayEndAt = dayEnd.getTime();
	if (!(Number.isFinite(dayStartAt) && Number.isFinite(dayEndAt))) {
		return [];
	}

	return events.flatMap((event): RunStatusTimelineEntry[] => {
		const eventStartAt = event.start.getTime();
		if (!Number.isFinite(eventStartAt)) {
			return [];
		}
		const aggregate = event.aggregateCount != null;
		const startAt = aggregate ? dayStartAt : eventStartAt;
		const endAt = aggregate ? dayEndAt : event.end?.getTime();
		const status =
			event.kind === "past"
				? event.outcome === "failure"
					? "failure"
					: "success"
				: "scheduled";
		const runLabel = aggregate
			? `${event.aggregateCount} projected runs; times collapsed`
			: event.scheduleLabel;

		const entry: RunStatusTimelineEntry = {
			id: event.id,
			label: `${event.jobName} · ${event.kind === "past" ? "Completed" : "Scheduled"} · ${runLabel}`,
			startAt,
			status,
		};
		if (endAt != null && Number.isFinite(endAt) && endAt > startAt) {
			return [{ endAt, ...entry }];
		}
		return [entry];
	});
}
