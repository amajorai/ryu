import type { InterfaceEvent } from "@ryuhq/protocol/interfaces";
import type { TrackingParcel } from "./tracking-model.ts";
import { nextCollection, scheduleApplies } from "./tracking-model-copy.ts";

export interface CourierRoutine {
	/** RFC 3339 start: recorded for past runs, projected for the next one. */
	at: string;
	estimated: boolean;
	failed: boolean;
	id: string;
	title: string;
}

/**
 * The courier's own routines, kept apart from the parcel's scans: the next
 * projected run and the two most recent ones.
 */
export function courierRoutines(
	parcel: TrackingParcel,
	events: readonly InterfaceEvent[],
	now: number
): CourierRoutine[] {
	const courierId = parcel.courier?.id;
	if (!courierId) {
		return [];
	}
	const routines: CourierRoutine[] = [];
	// Where the next routine bears on this parcel, the history already shows it.
	const next = scheduleApplies(parcel.stage)
		? undefined
		: nextCollection(parcel, events, now);
	if (next) {
		routines.push({
			at: next.start,
			estimated: true,
			failed: false,
			id: next.id,
			title: next.title,
		});
	}
	const past = events
		.filter(
			(event) =>
				event.kind === "past" &&
				event.agentId === courierId &&
				Date.parse(event.start) <= now
		)
		.sort((a, b) => b.start.localeCompare(a.start))
		.slice(0, 2);
	for (const event of past) {
		routines.push({
			at: event.start,
			estimated: false,
			failed: event.outcome === "failure",
			id: event.id,
			title: event.title,
		});
	}
	return routines;
}
