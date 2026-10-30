import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	localDayKey,
	THREAD_STATUS_ORDER,
} from "@ryuhq/protocol/interfaces";
import {
	byRecency,
	type RideTrip,
	typicalMinutes,
} from "./rides-model-trips.ts";

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

export type SheetTab = "arrived" | "now" | "trips";

export const SHEET_TABS: readonly { id: SheetTab; label: string }[] = [
	{ id: "now", label: "Now" },
	{ id: "arrived", label: "Arrived" },
	{ id: "trips", label: "Trips" },
];

const STATUS_RANK = new Map(
	THREAD_STATUS_ORDER.map((status, index) => [status, index])
);

/**
 * Trips under way (en route, then requested), followed by cancelled trips,
 * which the sheet sets apart under "Needs attention".
 */
export function nowTrips(trips: readonly RideTrip[]): RideTrip[] {
	return trips
		.filter(
			(trip) =>
				trip.stage === "enroute" ||
				trip.stage === "requested" ||
				trip.stage === "cancelled"
		)
		.sort(
			(a, b) =>
				Number(a.stage === "cancelled") - Number(b.stage === "cancelled") ||
				(STATUS_RANK.get(a.status) ?? 0) - (STATUS_RANK.get(b.status) ?? 0) ||
				byRecency(a.thread, b.thread)
		);
}

/**
 * Trips whose driver replied in the last {@link PARKED_FOR}: the car is
 * waiting at the pin and it is your turn. Newest first.
 */
export function arrivedTrips(trips: readonly RideTrip[]): RideTrip[] {
	return trips
		.filter((trip) => trip.stage === "arrived")
		.sort((a, b) => byRecency(a.thread, b.thread));
}

export interface TripDay {
	key: string;
	label: string;
	trips: RideTrip[];
}

export function dayLabel(dayKey: string, now: Date): string {
	const today = localDayKey(now);
	const yesterday = localDayKey(
		new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
	);
	if (dayKey === today) {
		return "Today";
	}
	if (dayKey === yesterday) {
		return "Yesterday";
	}
	const [year, month, day] = dayKey.split("-").map(Number);
	const date = new Date(year ?? 0, (month ?? 1) - 1, day ?? 1);
	return date.toLocaleDateString("en-US", {
		day: "numeric",
		month: "short",
		weekday: "short",
		...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
	});
}

/**
 * Every trip, grouped by local day, newest day and trip first. With the act
 * layer (`undated`) `updatedAt` is no day a trip happened on: one group,
 * still newest first.
 */
export function tripHistory(
	trips: readonly RideTrip[],
	now: Date = new Date(),
	undated = false
): TripDay[] {
	const days = new Map<string, RideTrip[]>();
	const sorted = [...trips].sort((a, b) => byRecency(a.thread, b.thread));
	if (undated) {
		return sorted.length > 0
			? [{ key: "earlier", label: "Earlier", trips: sorted }]
			: [];
	}
	for (const trip of sorted) {
		const date = new Date(trip.thread.updatedAt);
		if (Number.isNaN(date.getTime())) {
			continue;
		}
		const key = localDayKey(date);
		const list = days.get(key) ?? [];
		list.push(trip);
		days.set(key, list);
	}
	return [...days.entries()].map(([key, list]) => ({
		key,
		label: dayLabel(key, now),
		trips: list,
	}));
}

export function clockTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return "";
	}
	return date.toLocaleTimeString("en-US", {
		hour: "numeric",
		minute: "2-digit",
	});
}

export interface DriverOption {
	agent: InterfaceAgent;
	available: boolean;
	/** Minutes until free (0 when available now). */
	waitMinutes: number;
}

/** Drivers for the booking list: available first, then soonest free. */
export function driverOptions(
	snapshot: InterfaceSnapshot,
	trips: readonly RideTrip[]
): DriverOption[] {
	return snapshot.agents
		.map((agent) => {
			const busy = trips.filter(
				(trip) => trip.stage === "enroute" && trip.driver?.id === agent.id
			);
			const available = agent.status === "idle" && busy.length === 0;
			const waitMinutes = available
				? 0
				: Math.max(
						1,
						...busy.map((trip) => trip.etaMinutes ?? trip.typical),
						busy.length === 0 ? typicalMinutes(agent.id, snapshot.events) : 1
					);
			return { agent, available, waitMinutes };
		})
		.sort(
			(a, b) =>
				Number(b.available) - Number(a.available) ||
				a.waitMinutes - b.waitMinutes ||
				a.agent.name.localeCompare(b.agent.name)
		);
}

export function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}
