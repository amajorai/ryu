import { translate as tr } from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
import { PICKUP, type Point } from "./rides-model-city.ts";
import { pointAlong, routeLength } from "./rides-model-routes.ts";
import type { DriverOption } from "./rides-model-sheet.ts";
import {
	carPose,
	etaLabel,
	ON_MAP,
	type RideCity,
	type RideTrip,
	STAGE_LABELS,
	type TripStage,
} from "./rides-model-trips.ts";

/**
 * Rides view model: a small, deterministic city and the trips on it. Pure
 * functions only, so the map, the sheet, and the tests agree on every
 * position, route, and estimate.
 *
 * The city is a street grid in world units (one block = {@link BLOCK}); a
 * river cuts across it, a park fills a corner, and two diagonal avenues
 * break the grid. You stand at the pickup point; every conversation is a
 * trip from there to its own destination, driven by its first agent.
 */

export {
	AVENUE_COLUMNS,
	AVENUE_ROWS,
	BANK,
	BLOCK,
	bridgeSpans,
	buildCity,
	type City,
	type CityBlock,
	type CityLabel,
	type CityRoad,
	COLUMNS,
	cellPoint,
	DRAWN_BEYOND,
	hashString,
	inPark,
	landPieces,
	OUTSKIRTS,
	PARK,
	PICKUP,
	PICKUP_CELL,
	type Point,
	type Rect,
	RIVER_HALF_WIDTH,
	ROWS,
	riverCenter,
	WORLD,
} from "./rides-model-city.ts";
export {
	carProgress,
	LANE_PX,
	laneRoute,
	laneShift,
	routeLanes,
	segmentAt,
} from "./rides-model-lanes.ts";
export { pointAlong, routeLength, routeTo } from "./rides-model-routes.ts";
export {
	arrivedTrips,
	clockTime,
	type DriverOption,
	dayLabel,
	driverOptions,
	nowTrips,
	SHEET_TABS,
	type SheetTab,
	type TripDay,
	tripHistory,
} from "./rides-model-sheet.ts";
export {
	buildRides,
	type CarState,
	carPose,
	DEFAULT_TRIP_MINUTES,
	etaLabel,
	MINUTE,
	PARK_GAP,
	PARKED_FOR,
	parkedShift,
	type RideCar,
	type RideCity,
	type RideTrip,
	STAGE_LABELS,
	type TripStage,
	tripProgress,
	tripStage,
	typicalMinutes,
} from "./rides-model-trips.ts";

// ---------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------

/** Points the overview frames: you, every car, and every pin on the map. */
export function overviewPoints(rides: RideCity): Point[] {
	const points: Point[] = [PICKUP];
	for (const car of rides.cars) {
		points.push(carPose(car, rides.trips));
	}
	for (const trip of mapTrips(rides)) {
		points.push(trip.destination);
	}
	return points;
}

/** Points that frame one trip: its whole route. */
export function tripPoints(trip: RideTrip): Point[] {
	return [...trip.route];
}

/**
 * Trips whose route and pin are drawn: anything under way, plus arrivals
 * whose car is still parked at the pin. Older arrivals live in the history.
 */
export function mapTrips(rides: RideCity): RideTrip[] {
	return rides.trips.filter((trip) => ON_MAP.has(trip.stage));
}

/**
 * The history: completed trips (replied more than {@link PARKED_FOR} ago),
 * conversations never started, and ones without a driver. Nothing here is
 * also in Now or Arrived.
 */
export function finishedTrips(trips: readonly RideTrip[]): RideTrip[] {
	return trips.filter(
		(trip) =>
			trip.stage === "completed" ||
			trip.stage === "unstarted" ||
			trip.stage === "unassigned"
	);
}

/**
 * The part of a trip's route the map draws: all of it when selected;
 * otherwise what is still ahead of a car en route, only the last leg of a
 * cancelled trip, and nothing for a finished ride.
 */
export function drawnRoute(trip: RideTrip, selected: boolean): Point[] {
	if (selected) {
		return [...trip.route];
	}
	if (trip.stage === "arrived") {
		return [];
	}
	if (trip.stage === "cancelled") {
		return trip.route.slice(-2);
	}
	if (trip.stage === "enroute" && !trip.carless) {
		return routeAhead(trip.route, trip.progress);
	}
	return [...trip.route];
}

/** The part of a route still ahead of `progress`, starting at the car. */
export function routeAhead(route: readonly Point[], progress: number): Point[] {
	const total = routeLength(route);
	const car = pointAlong(route, progress);
	const ahead: Point[] = [{ x: car.x, y: car.y }];
	let travelled = 0;
	const reached = Math.min(1, Math.max(0, progress)) * total;
	for (let index = 1; index < route.length; index += 1) {
		const from = route[index - 1];
		const to = route[index];
		if (!(from && to)) {
			continue;
		}
		travelled += Math.hypot(to.x - from.x, to.y - from.y);
		if (travelled > reached) {
			ahead.push(to);
		}
	}
	return ahead.length === 1 ? [car, car] : ahead;
}

/** How a driver's availability reads in the booking list: one short phrase. */
export function availabilityText(
	option: DriverOption,
	tl: LiteralMessage
): string {
	return option.available
		? "Available now"
		: tl("About {waitMinutes} min wait", { waitMinutes: option.waitMinutes });
}

/**
 * A trip's one status word, wherever it is shown: its row, the list, its
 * pin and the open trip. The act's word when there is one (a carless car
 * en route is "Up next"); a trip without a driver always reads so.
 */
export function tripWord(
	trip: RideTrip,
	acted?: { stage: TripStage; word: string },
	/** Render callers pass their hook `tl`; the word is translated here so a
	 *  sentence that interpolates it never mixes languages. */
	tl: LiteralMessage = tr
): string {
	if (acted && trip.stage !== "unassigned") {
		return acted.stage === "enroute" && trip.carless
			? tl("Up next")
			: acted.word;
	}
	switch (trip.stage) {
		case "arrived":
			return tl("Your turn");
		case "cancelled":
			return trip.thread.runState === "interrupted"
				? tl("Run interrupted")
				: tl("Run failed");
		case "enroute":
			return trip.carless ? tl("Up next") : STAGE_LABELS.enroute;
		default:
			return STAGE_LABELS[trip.stage];
	}
}

/**
 * The open trip's status and the one line under it. The destination (the
 * conversation's title) is the heading and the ETA the large figure, so
 * neither is repeated here.
 */
export function tripHeadline(
	trip: RideTrip,
	tl: LiteralMessage
): {
	detail: string;
	status: string;
} {
	const driver = trip.driver?.name ?? tr("No driver");
	switch (trip.stage) {
		case "enroute":
			return trip.carless
				? {
						detail: tl("{driver} starts this after the current trip", {
							driver,
						}),
						status: tripWord(trip, undefined, tl),
					}
				: {
						detail: tl("Estimated from {driver}'s usual reply time", {
							driver,
						}),
						status: tripWord(trip, undefined, tl),
					};
		case "arrived":
			return {
				detail: tl("{driver} replied.", { driver }),
				status: tripWord(trip, undefined, tl),
			};
		case "completed":
			return {
				detail: tl("{driver} replied. It's still your turn.", { driver }),
				status: tripWord(trip, undefined, tl),
			};
		case "unassigned":
			return {
				detail: tl("Add an agent to this conversation to start it"),
				status: tripWord(trip, undefined, tl),
			};
		case "requested":
			return {
				detail: tl("Waiting for {driver} to pick it up", { driver }),
				status: tripWord(trip, undefined, tl),
			};
		case "cancelled":
			return {
				detail:
					trip.thread.runState === "interrupted"
						? tl("The run was interrupted. Send a message to try again.")
						: tl("The run failed. Send a message to try again."),
				status: tripWord(trip, undefined, tl),
			};
		default:
			return {
				detail: tl("Nothing has been sent yet"),
				status: tripWord(trip, undefined, tl),
			};
	}
}

/**
 * The words on a pin's status chip, shared by the marker and the layout so
 * they agree on its width: the lead (bold) and an optional muted tail.
 * A parked car's chip carries the driver's name, since the car has no
 * separate name chip.
 */
export function chipText(
	trip: RideTrip,
	/** The act layer: an ETA only for a routine's run (its estimate). */
	acted = false
): {
	lead: string;
	tail: string | null;
} {
	if (trip.stage === "enroute") {
		if (trip.carless) {
			return { lead: tr("Up next"), tail: null };
		}
		// With acts a map pin never shows the typical-length guess.
		return acted
			? { lead: STAGE_LABELS.enroute, tail: null }
			: { lead: etaLabel(trip.etaMinutes ?? 0), tail: "est." };
	}
	if (trip.stage === "arrived" && !trip.carless && trip.driver) {
		return { lead: trip.driver.name, tail: tripWord(trip) };
	}
	return { lead: tripWord(trip), tail: null };
}

/** "3 min" for a trip en route with a car on it; null for anything else. */
export function tripEta(
	trip: RideTrip,
	/**
	 * The act layer: only a routine's run has an estimate to show (the
	 * median of its own past runs); a chat's typical length is not an ETA.
	 */
	acted = false
): string | null {
	if (trip.stage !== "enroute" || trip.carless) {
		return null;
	}
	if (acted && !trip.thread.routineRun) {
		return null;
	}
	return etaLabel(trip.etaMinutes ?? 0);
}
