import {
	type InterfaceAgent,
	type InterfaceEvent,
	type InterfaceSnapshot,
	type InterfaceThread,
	medianRunMs,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import {
	BLOCK,
	cellPoint,
	hashString,
	PICKUP,
	type Point,
} from "./rides-model-city.ts";
import {
	claimCell,
	pointAlong,
	routeLength,
	routeTo,
} from "./rides-model-routes.ts";

// ---------------------------------------------------------------------------
// Estimates
// ---------------------------------------------------------------------------

export const MINUTE = 60_000;
/** Used when an agent has no finished runs to learn from. */
export const DEFAULT_TRIP_MINUTES = 4;
const MIN_TRIP_MINUTES = 1;
const MAX_TRIP_MINUTES = 45;

/**
 * An agent's typical time to reply, in whole minutes: the median of its
 * finished scheduled runs (the protocol's `medianRunMs`, pooled over the
 * agent's routines), or {@link DEFAULT_TRIP_MINUTES} without any.
 */
export function typicalMinutes(
	agentId: string | null | undefined,
	events: readonly InterfaceEvent[] | undefined
): number {
	// `medianRunMs` treats a missing agent as "every agent"; a trip with no
	// agent only learns from runs that have none either.
	const median =
		agentId == null
			? medianRunMs(
					events?.filter((event) => event.agentId === agentId),
					{}
				)
			: medianRunMs(events, { agentId });
	if (median === null) {
		return DEFAULT_TRIP_MINUTES;
	}
	return Math.min(
		MAX_TRIP_MINUTES,
		Math.max(MIN_TRIP_MINUTES, Math.round(median / MINUTE))
	);
}

/** Where a live trip has got to, and the minutes left on the estimate. */
export function tripProgress(
	updatedAt: string,
	typical: number,
	now: number
): { etaMinutes: number; progress: number } {
	const started = Date.parse(updatedAt);
	const elapsed = Number.isNaN(started)
		? 0
		: Math.max(0, (now - started) / MINUTE);
	return {
		etaMinutes: Math.max(0, Math.ceil(typical - elapsed)),
		// Never quite at the pin: the car only arrives when the agent replies.
		progress: Math.min(0.94, Math.max(0.02, elapsed / typical)),
	};
}

export function etaLabel(minutes: number): string {
	return minutes < 1 ? "<1 min" : `${minutes} min`;
}

// ---------------------------------------------------------------------------
// Trips and cars
// ---------------------------------------------------------------------------

export type TripStage =
	| "arrived"
	| "cancelled"
	| "completed"
	| "enroute"
	| "requested"
	| "unassigned"
	| "unstarted";

const STAGE_BY_STATUS: Record<ThreadStatus, TripStage> = {
	attention: "cancelled",
	quiet: "unstarted",
	waiting: "requested",
	working: "enroute",
	"your-turn": "arrived",
};

export const STAGE_LABELS: Record<TripStage, string> = {
	arrived: "Arrived",
	cancelled: "Cancelled",
	completed: "Completed",
	enroute: "En route",
	requested: "Requested",
	unassigned: "No driver assigned",
	unstarted: "Not started",
};

/** Stages whose route and pin are drawn on the map. */
export const ON_MAP = new Set<TripStage>([
	"arrived",
	"cancelled",
	"enroute",
	"requested",
]);

/** Arrived cars wait at the pin this long; after that the trip is history. */
export const PARKED_FOR = 12 * 60 * MINUTE;
/** A car that has just set off is drawn this far along, clear of you. */
const SET_OFF_DISTANCE = 72;

/**
 * The stage a conversation shows as. A thread nobody can drive is never a
 * live request, and a reply older than {@link PARKED_FOR} is a finished trip.
 */
export function tripStage(
	thread: InterfaceThread,
	hasDriver: boolean,
	now: number
): TripStage {
	const stage = unassignedOr(STAGE_BY_STATUS[threadStatus(thread)], hasDriver);
	if (stage === "arrived" && now - Date.parse(thread.updatedAt) >= PARKED_FOR) {
		return "completed";
	}
	return stage;
}

/** Nobody can drive a live request without a driver. */
function unassignedOr(stage: TripStage, hasDriver: boolean): TripStage {
	return !hasDriver && (stage === "requested" || stage === "enroute")
		? "unassigned"
		: stage;
}

export interface RideTrip {
	/**
	 * No car is on this trip: its driver is on (or parked at) another one.
	 * The map draws it as a dotted route and a pin, never a second car.
	 */
	carless: boolean;
	destination: Point;
	driver: InterfaceAgent | undefined;
	/** Minutes left on the estimate, for trips en route. */
	etaMinutes: number | null;
	id: string;
	/** 0..1 along the route, for trips en route. */
	progress: number;
	route: Point[];
	stage: TripStage;
	status: ThreadStatus;
	thread: InterfaceThread;
	/** The driver's typical minutes per reply. */
	typical: number;
}

/**
 * `queued` is a requested trip nobody has picked up yet: the car waits at
 * the start of its route, drawn as an outline, until the run begins.
 */
export type CarState = "arrived" | "driving" | "idle" | "queued";

export interface RideCar {
	agent: InterfaceAgent;
	/** Where the car waits between trips. */
	home: Point;
	/** The agent's id: every agent has exactly one car. */
	id: string;
	state: CarState;
	/** The trip the car is on, parked at, or waiting to start. */
	tripId: string | null;
}

export interface RideCity {
	cars: RideCar[];
	trips: RideTrip[];
}

export function byRecency(a: InterfaceThread, b: InterfaceThread): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

/**
 * Lay out every agent's car and every conversation's trip. Homes are
 * claimed first (near the pickup, like cars around a rider), then
 * destinations, each by hash so nothing moves between snapshots.
 */
export function buildRides(
	snapshot: InterfaceSnapshot,
	now: number = Date.now(),
	/**
	 * With the act layer: each thread's stage from its act (never from how
	 * old `updatedAt` is), and where a working car is along its route
	 * (`progress.done / total`, or a fixed start without progress).
	 */
	acted?: {
		progressOf: (thread: InterfaceThread) => number | null;
		stageOf: (thread: InterfaceThread) => TripStage;
	}
): RideCity {
	const taken = new Set<string>();
	const homes = new Map<string, Point>();
	const agents = [...snapshot.agents].sort((a, b) => a.id.localeCompare(b.id));
	for (const agent of agents) {
		const cell = claimCell(`home:${agent.id}`, taken, 2, 6);
		homes.set(agent.id, cellPoint(cell.col, cell.row));
	}
	const typicalByAgent = new Map<string, number>();
	const typicalFor = (agentId: string | undefined) => {
		const key = agentId ?? "";
		const cached = typicalByAgent.get(key);
		if (cached !== undefined) {
			return cached;
		}
		const value = typicalMinutes(agentId, snapshot.events);
		typicalByAgent.set(key, value);
		return value;
	};

	// Trips on the map claim the near corners first, so the overview stays
	// compact; history (never drawn) takes whatever is left further out.
	const staged = [...snapshot.threads]
		.sort((a, b) => a.id.localeCompare(b.id))
		.map((thread) => {
			const driverId = thread.agentIds[0];
			const driver = snapshot.agents.find((agent) => agent.id === driverId);
			const stage = acted
				? unassignedOr(acted.stageOf(thread), Boolean(driver))
				: tripStage(thread, Boolean(driver), now);
			return { driver, stage, thread };
		});
	const drawn = (stage: TripStage) => ON_MAP.has(stage);
	const ordered = [
		...staged.filter((item) => drawn(item.stage)),
		...staged.filter((item) => !drawn(item.stage)),
	];
	const trips: RideTrip[] = [];
	for (const { driver, stage, thread } of ordered) {
		const cell = drawn(stage)
			? claimCell(`trip:${thread.id}`, taken, 3, 8)
			: claimCell(`trip:${thread.id}`, taken, 3, 12);
		const typical = typicalFor(driver?.id);
		const route = routeTo(cell);
		let live: { etaMinutes: number | null; progress: number } = {
			etaMinutes: null,
			progress: stage === "arrived" || stage === "completed" ? 1 : 0,
		};
		if (stage === "enroute" && acted) {
			// Route position is the act's pips, never a guess from the clock.
			const floor = SET_OFF_DISTANCE / Math.max(1, routeLength(route));
			live = {
				etaMinutes: null,
				progress: Math.min(
					0.94,
					Math.max(floor, acted.progressOf(thread) ?? floor)
				),
			};
		} else if (stage === "enroute") {
			const estimate = tripProgress(thread.updatedAt, typical, now);
			const floor = SET_OFF_DISTANCE / Math.max(1, routeLength(route));
			live = {
				etaMinutes: estimate.etaMinutes,
				progress: Math.min(0.94, Math.max(floor, estimate.progress)),
			};
		}
		trips.push({
			carless: false,
			destination: cellPoint(cell.col, cell.row),
			driver,
			etaMinutes: live.etaMinutes,
			id: thread.id,
			progress: live.progress,
			route,
			stage,
			status: threadStatus(thread),
			thread,
			typical,
		});
	}
	trips.sort((a, b) => byRecency(a.thread, b.thread));

	const cars = placeCars(snapshot.agents, trips, homes);
	const driven = new Set(cars.map((car) => car.tripId));
	return {
		cars,
		trips: trips.map((trip) =>
			ON_MAP.has(trip.stage) &&
			trip.stage !== "cancelled" &&
			!driven.has(trip.id)
				? { ...trip, carless: true }
				: trip
		),
	};
}

function byAge(a: RideTrip, b: RideTrip): number {
	return (
		a.thread.updatedAt.localeCompare(b.thread.updatedAt) ||
		a.id.localeCompare(b.id)
	);
}

/**
 * One car per agent, because a driver can only be in one place. It drives
 * the agent's oldest trip en route (so a second booking never pulls it off
 * the first); failing that it is parked at the most recent arrival, then
 * waiting at the start of the oldest requested trip, then at home. Every
 * other trip of that agent is drawn without a car.
 */
function placeCars(
	agents: readonly InterfaceAgent[],
	trips: readonly RideTrip[],
	homes: ReadonlyMap<string, Point>
): RideCar[] {
	return agents.map((agent) => {
		const home = homes.get(agent.id) ?? PICKUP;
		const own = trips.filter((trip) => trip.driver?.id === agent.id);
		const oldest = (stage: TripStage) =>
			own.filter((trip) => trip.stage === stage).sort(byAge)[0];
		const driving = oldest("enroute");
		const arrived = own
			.filter((trip) => trip.stage === "arrived")
			.sort((a, b) => byRecency(a.thread, b.thread))[0];
		const queued = oldest("requested");
		let state: CarState = "idle";
		let trip: RideTrip | undefined;
		if (driving) {
			state = "driving";
			trip = driving;
		} else if (arrived) {
			state = "arrived";
			trip = arrived;
		} else if (queued) {
			state = "queued";
			trip = queued;
		}
		return { agent, home, id: agent.id, state, tripId: trip?.id ?? null };
	});
}

/** Where a car is drawn right now, and which way it points. */
export function carPose(
	car: RideCar,
	trips: readonly RideTrip[]
): Point & { heading: number } {
	const trip = car.tripId
		? trips.find((item) => item.id === car.tripId)
		: undefined;
	if (!trip) {
		// Parked facing along the street, varied by agent.
		return { ...car.home, heading: (hashString(car.agent.id) % 4) * 90 };
	}
	if (car.state === "arrived") {
		return pointAlong(trip.route, 1);
	}
	if (car.state === "queued") {
		return pointAlong(trip.route, setOffShare(trip.route));
	}
	return pointAlong(trip.route, trip.progress);
}

/**
 * Screen pixels a parked car stops short of its pin, so the car and the
 * destination marker both stay in view, the way a rider app shows a car
 * pulled up at the drop-off.
 */
export const PARK_GAP = 24;

/** The screen offset that pulls a parked car back from its pin. */
export function parkedShift(heading: number): Point {
	const radians = (heading * Math.PI) / 180;
	// `+ 0` turns a rounded -0 into 0.
	return {
		x: Math.round(-Math.cos(radians) * PARK_GAP) + 0,
		y: Math.round(-Math.sin(radians) * PARK_GAP) + 0,
	};
}

/** A requested trip's ghost car waits this far along its route. */
const QUEUED_DISTANCE = BLOCK;

/**
 * The share of `route` a requested trip's ghost car waits at: a block out,
 * clear of you and your label, and never past halfway.
 */
export function setOffShare(route: readonly Point[]): number {
	return Math.min(0.5, QUEUED_DISTANCE / Math.max(1, routeLength(route)));
}
