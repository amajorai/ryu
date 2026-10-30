import type { Point } from "./rides-model-city.ts";
import { routeLength } from "./rides-model-routes.ts";
import {
	type RideCar,
	type RideTrip,
	setOffShare,
} from "./rides-model-trips.ts";

// ---------------------------------------------------------------------------
// Lanes: routes that share a street are drawn side by side
// ---------------------------------------------------------------------------

/** Screen pixels between the centres of two routes sharing a street. */
export const LANE_PX = 7;

interface LaneSpan {
	high: number;
	index: number;
	low: number;
	order: number;
	tripId: string;
}

function assignLanes(spans: LaneSpan[], lanes: Map<string, number[]>): void {
	const sorted = [...spans].sort((a, b) => a.low - b.low);
	let group: LaneSpan[] = [];
	let reach = Number.NEGATIVE_INFINITY;
	const flush = () => {
		if (group.length > 1) {
			group.sort(
				(a, b) => a.order - b.order || a.tripId.localeCompare(b.tripId)
			);
			for (const [lane, span] of group.entries()) {
				const offsets = lanes.get(span.tripId);
				if (offsets) {
					offsets[span.index] = lane - (group.length - 1) / 2;
				}
			}
		}
		group = [];
		reach = Number.NEGATIVE_INFINITY;
	};
	for (const span of sorted) {
		if (span.low >= reach) {
			flush();
		}
		group.push(span);
		reach = Math.max(reach, span.high);
	}
	flush();
}

/**
 * Lane offsets (in lanes, centred on 0) for each segment of each route.
 * Where routes run along the same stretch of street they split into
 * parallel lanes, ordered by where they turn off (northbound turns on the
 * north side, westbound on the west) so the lines never cross to leave.
 */
export function routeLanes(trips: readonly RideTrip[]): Map<string, number[]> {
	const lanes = new Map<string, number[]>();
	const lines = new Map<string, LaneSpan[]>();
	for (const trip of trips) {
		lanes.set(
			trip.id,
			Array.from({ length: Math.max(0, trip.route.length - 1) }, () => 0)
		);
		for (let index = 1; index < trip.route.length; index += 1) {
			const from = trip.route[index - 1];
			const to = trip.route[index];
			if (!(from && to) || (from.x === to.x && from.y === to.y)) {
				continue;
			}
			const horizontal = from.y === to.y;
			const key = horizontal ? `h:${from.y}` : `v:${from.x}`;
			const spans = lines.get(key) ?? [];
			spans.push({
				high: horizontal ? Math.max(from.x, to.x) : Math.max(from.y, to.y),
				index: index - 1,
				low: horizontal ? Math.min(from.x, to.x) : Math.min(from.y, to.y),
				order: horizontal ? trip.destination.y : trip.destination.x,
				tripId: trip.id,
			});
			lines.set(key, spans);
		}
	}
	for (const spans of lines.values()) {
		assignLanes(spans, lanes);
	}
	return lanes;
}

function isHorizontal(route: readonly Point[], segment: number): boolean {
	return route[segment]?.y === route[segment + 1]?.y;
}

/**
 * `route` moved into its lanes: each segment shifted sideways by its lane
 * times `unit` world units, with corners where the shifted segments meet.
 */
export function laneRoute(
	route: readonly Point[],
	offsets: readonly number[] | undefined,
	unit: number
): Point[] {
	if (!offsets || route.length < 2) {
		return [...route];
	}
	return route.map((point, index) => {
		let x = point.x;
		let y = point.y;
		for (const segment of [index - 1, index]) {
			if (segment < 0 || segment >= route.length - 1) {
				continue;
			}
			const shift = (offsets[segment] ?? 0) * unit;
			if (isHorizontal(route, segment)) {
				y = point.y + shift;
			} else {
				x = point.x + shift;
			}
		}
		return { x, y };
	});
}

/** The segment of `route` that `progress` (0..1) falls on. */
export function segmentAt(route: readonly Point[], progress: number): number {
	const total = routeLength(route);
	let remaining = Math.min(1, Math.max(0, progress)) * total;
	for (let index = 1; index < route.length; index += 1) {
		const from = route[index - 1];
		const to = route[index];
		if (!(from && to)) {
			continue;
		}
		const length = Math.hypot(to.x - from.x, to.y - from.y);
		if (remaining <= length && length > 0) {
			return index - 1;
		}
		remaining -= length;
	}
	return Math.max(0, route.length - 2);
}

/**
 * The sideways shift, in lanes, of a car on `trip` at `progress`: the lane
 * of the segment it is on, as an x/y pair.
 */
export function laneShift(
	trip: RideTrip,
	offsets: readonly number[] | undefined,
	progress: number
): Point {
	if (!offsets) {
		return { x: 0, y: 0 };
	}
	const segment = segmentAt(trip.route, progress);
	const lane = offsets[segment] ?? 0;
	return isHorizontal(trip.route, segment)
		? { x: 0, y: lane }
		: { x: lane, y: 0 };
}

/** Where along its route a car is, for lane purposes. */
export function carProgress(car: RideCar, trip: RideTrip): number {
	if (car.state === "arrived") {
		return 1;
	}
	if (car.state === "queued") {
		return setOffShare(trip.route);
	}
	return trip.progress;
}
