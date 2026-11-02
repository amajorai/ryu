import { translate as tr } from "@ryu/i18n/lite";
import {
	type InterfaceAgent,
	type InterfaceAsk,
	type InterfaceEvent,
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
	medianRunMs,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

export {
	actTickets,
	type TicketAct,
} from "./kitchen-model-acts.ts";

export {
	chefLabel,
	roughDuration,
	spokenAge,
	ticketLabel,
	ticketStateLabel,
	ticketTimer,
} from "./kitchen-model-labels.ts";

/**
 * Kitchen view model: pure functions that turn the snapshot into a service.
 * Each agent is a chef at its own station; each thread is an order ticket.
 * The scene, the HUD and the tests all read from here, so the rail, the pass
 * and the stations always agree about what is cooking.
 */

/** Where an order stands, in kitchen terms (from `threadStatus`). */
/**
 * A ticket's state. "needs" (a blocking ask) and "limited" (86'd) come only
 * from the act layer.
 */
export type TicketState =
	| "burnt"
	| "cooking"
	| "limited"
	| "needs"
	| "queued"
	| "ready"
	| "served";

export const TICKET_STATE: Record<ThreadStatus, TicketState> = {
	attention: "burnt",
	quiet: "served",
	waiting: "queued",
	working: "cooking",
	"your-turn": "ready",
};

export const TICKET_LABELS: Record<TicketState, string> = {
	burnt: "Burnt",
	cooking: "Cooking",
	limited: "86'd",
	needs: "Needs you",
	queued: "Waiting",
	ready: "Ready",
	served: "Served",
};

/** What each state means, for tooltips and screen readers. */
export const TICKET_MEANING: Record<TicketState, string> = {
	burnt: "The last run failed or was interrupted",
	cooking: "The chef is working on it",
	limited: "The chef hit a usage limit",
	needs: "The chef is waiting on your answer",
	queued: "Waiting for the chef to start",
	ready: "The chef replied; your turn",
	served: "Nothing waiting",
};

/** Rail order: what needs you first (ready, then burnt), then the stoves. */
const RAIL_ORDER: readonly TicketState[] = [
	"ready",
	"burnt",
	"cooking",
	"queued",
];

export type StationKind = "board" | "grill" | "stove";
const STATION_KINDS: readonly StationKind[] = ["stove", "board", "grill"];

export interface KitchenTicket {
	/** The chef who owns the ticket (the thread's first agent), if any. */
	chef: InterfaceAgent | undefined;
	id: string;
	state: TicketState;
	thread: InterfaceThread;
	title: string;
	updatedAt: number;
}

export interface KitchenStation {
	agent: InterfaceAgent;
	/** Has a burnt order: smoke rises from the station. */
	burnt: boolean;
	/** Station column within its row, and row (0 = back line). */
	column: number;
	index: number;
	kind: StationKind;
	/** Open orders for this chef, rail order. */
	orders: KitchenTicket[];
	row: number;
	/** When the newest live run started (its thread's last update), or null. */
	runStartedAt: number | null;
	/** Whether `typicalMs` comes from the chef's own past runs. */
	typicalFromHistory: boolean;
	/** This chef's usual run time, in ms (an estimate). */
	typicalMs: number;
	working: boolean;
	/** World position of the chef (counter in front of them). */
	x: number;
	z: number;
}

export interface KitchenDish {
	ticket: KitchenTicket;
	x: number;
	z: number;
}

export interface KitchenFloor {
	depth: number;
	/** Pass counter: centre and length along x. */
	pass: { length: number; x: number; z: number };
	width: number;
}

export interface KitchenTotals {
	burnt: number;
	cooking: number;
	queued: number;
	ready: number;
	/** Threads you replied to today. */
	servedToday: number;
}

export interface KitchenService {
	dishes: KitchenDish[];
	/** Ready orders that do not fit on the pass. */
	dishOverflow: number;
	floor: KitchenFloor;
	/** Open orders on the rail: ready, burnt, cooking, queued. */
	rail: KitchenTicket[];
	stations: KitchenStation[];
	totals: KitchenTotals;
}

/** Fallback run time when a chef has no finished scheduled runs. */
export const DEFAULT_RUN_MS = 4 * 60_000;
/** Station spacing along a counter line, and lines per kitchen. */
export const STATION_SPACING = 2.6;
export const STATIONS_PER_ROW = 4;
export const ROW_SPACING = 3.6;
/** Dishes that fit on the pass. */
export const PASS_SLOTS = 6;
const DISH_SPACING = 1.05;

export function toTicket(snapshot: InterfaceSnapshot, thread: InterfaceThread) {
	const chefId = thread.agentIds[0];
	const parsed = Date.parse(thread.updatedAt);
	return {
		chef: chefId
			? snapshot.agents.find((agent) => agent.id === chefId)
			: undefined,
		id: thread.id,
		state: TICKET_STATE[threadStatus(thread)],
		thread,
		title: thread.title.trim() || tr("Untitled order"),
		updatedAt: Number.isNaN(parsed) ? 0 : parsed,
	} satisfies KitchenTicket;
}

/** Rail order: state first, then the order that has waited longest. */
export function compareTickets(a: KitchenTicket, b: KitchenTicket): number {
	const rank = RAIL_ORDER.indexOf(a.state) - RAIL_ORDER.indexOf(b.state);
	return rank || a.updatedAt - b.updatedAt || a.id.localeCompare(b.id);
}

/** Median of a list of numbers (null when empty). */
export function median(values: readonly number[]): number | null {
	if (values.length === 0) {
		return null;
	}
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	const upper = sorted[middle] ?? 0;
	return sorted.length % 2 === 0
		? ((sorted[middle - 1] ?? upper) + upper) / 2
		: upper;
}

/**
 * A chef's usual run time: the median length of their finished scheduled
 * runs (the protocol's `medianRunMs`, pooled across the chef's routines),
 * else `DEFAULT_RUN_MS`, never under 30 s. Snapshots carry no per-message
 * timing, so this is an estimate and the HUD says so.
 */
export function typicalRunMs(
	agentId: string,
	events: readonly InterfaceEvent[] | undefined
): { fromHistory: boolean; ms: number } {
	const value = medianRunMs(events, { agentId });
	return value === null
		? { fromHistory: false, ms: DEFAULT_RUN_MS }
		: { fromHistory: true, ms: Math.max(30_000, value) };
}

export interface CookProgress {
	/** 0..1 of the usual run time. */
	fraction: number;
	/** Past the usual run time. */
	over: boolean;
}

/** How far along a run is, against the chef's usual run time. */
export function cookProgress(
	startedAt: number | null,
	typicalMs: number,
	now: number
): CookProgress {
	if (startedAt === null || typicalMs <= 0) {
		return { fraction: 0, over: false };
	}
	const raw = Math.max(0, now - startedAt) / typicalMs;
	return { fraction: Math.min(1, raw), over: raw > 1 };
}

/** How long a ready order waits on you before its patience bar runs out. */
export const READY_PATIENCE_MS = 4 * 60 * 60 * 1000;

/**
 * What is left of a ready ticket's patience bar, like the reference's order
 * timers: full when the reply lands, empty after `READY_PATIENCE_MS`.
 */
export function readyPatience(updatedAt: number, now: number): number {
	if (updatedAt <= 0) {
		return 0;
	}
	const waited = Math.max(0, now - updatedAt);
	return Math.max(0, 1 - waited / READY_PATIENCE_MS);
}

/**
 * A ticket's patience bar when the host sends asks: it drains from when
 * the ask started waiting (`ask.since`), toward its deadline when it has
 * one, else over `READY_PATIENCE_MS`. Unknown start: null (no drain shown).
 */
export function askPatience(ask: InterfaceAsk, now: number): number | null {
	const since = ask.since ? Date.parse(ask.since) : Number.NaN;
	if (Number.isNaN(since)) {
		return null;
	}
	const until = ask.expiresAt ? Date.parse(ask.expiresAt) : Number.NaN;
	const span = Number.isNaN(until) ? READY_PATIENCE_MS : until - since;
	if (span <= 0) {
		return 0;
	}
	return Math.max(0, Math.min(1, 1 - Math.max(0, now - since) / span));
}

/** Stations on counter lines, back line first, each line centred. */
export function stationSpots(
	count: number,
	perRow: number = STATIONS_PER_ROW,
	spread = 1
): { column: number; row: number; x: number; z: number }[] {
	const rows = Math.max(1, Math.ceil(count / perRow));
	const spots: { column: number; row: number; x: number; z: number }[] = [];
	for (let index = 0; index < count; index += 1) {
		const row = Math.floor(index / perRow);
		const inRow = Math.min(perRow, count - row * perRow);
		const column = index % perRow;
		spots.push({
			column,
			row,
			x: (column - (inRow - 1) / 2) * STATION_SPACING * spread,
			z: (row - (rows - 1) / 2) * ROW_SPACING * spread - 1,
		});
	}
	return spots;
}

/**
 * Floor size and the pass, sized to the lines of stations. A portrait stage
 * (a phone) passes a shorter line, so the room is taller than it is wide.
 */
export function kitchenFloor(
	count: number,
	perRow: number = STATIONS_PER_ROW,
	spread = 1
): KitchenFloor {
	const rows = Math.max(1, Math.ceil(count / perRow));
	const across = Math.max(Math.min(3, perRow), Math.min(perRow, count));
	const width = across * STATION_SPACING * spread + 3;
	const backZ = -((rows - 1) / 2) * ROW_SPACING * spread - 1;
	const frontZ = ((rows - 1) / 2) * ROW_SPACING * spread - 1;
	// Room behind the back line for its chefs, and in front of the front
	// line for the walkway and the pass.
	const back = backZ - 1.7;
	const passZ = frontZ + 2.9;
	const front = passZ + 1;
	return {
		depth: front - back,
		pass: {
			length: Math.min(width - 2, PASS_SLOTS * DISH_SPACING + 1.2),
			x: 0,
			z: passZ,
		},
		width,
	};
}

/** Where dishes sit on the pass, centred, one per slot. */
export function dishSpots(count: number, floor: KitchenFloor): number[] {
	const shown = Math.min(PASS_SLOTS, count);
	const spots: number[] = [];
	for (let index = 0; index < shown; index += 1) {
		spots.push(floor.pass.x + (index - (shown - 1) / 2) * DISH_SPACING);
	}
	return spots;
}

/** The z the floor's centre sits at, so the camera can aim at it. */
export function floorCentreZ(floor: KitchenFloor): number {
	return floor.pass.z + 1 - floor.depth / 2;
}

function isToday(timestamp: number, now: number): boolean {
	return (
		timestamp > 0 &&
		localDayKey(new Date(timestamp)) === localDayKey(new Date(now))
	);
}

/**
 * How much farther apart stations stand when the act layer draws its
 * props (alarms, boards, openers) between them.
 */
export const ACT_SPREAD = 1.2;

/** The whole service: stations, the rail, the pass and the totals. */
export function buildService(
	snapshot: InterfaceSnapshot,
	now: number,
	perRow: number = STATIONS_PER_ROW,
	spread = 1
): KitchenService {
	const tickets = snapshot.threads.map((thread) => toTicket(snapshot, thread));
	const rail = tickets
		.filter((ticket) => ticket.state !== "served")
		.sort(compareTickets);
	const spots = stationSpots(snapshot.agents.length, perRow, spread);
	const floor = kitchenFloor(snapshot.agents.length, perRow, spread);
	const stations = snapshot.agents.map((agent, index): KitchenStation => {
		const orders = rail.filter((ticket) =>
			ticket.thread.agentIds.includes(agent.id)
		);
		const running = orders.filter((ticket) => ticket.state === "cooking");
		const typical = typicalRunMs(agent.id, snapshot.events);
		const spot = spots[index] ?? { column: 0, row: 0, x: 0, z: 0 };
		return {
			agent,
			burnt: orders.some((ticket) => ticket.state === "burnt"),
			column: spot.column,
			index,
			kind: STATION_KINDS[index % STATION_KINDS.length] ?? "stove",
			orders,
			row: spot.row,
			runStartedAt:
				running.length > 0
					? Math.max(...running.map((ticket) => ticket.updatedAt))
					: null,
			typicalFromHistory: typical.fromHistory,
			typicalMs: typical.ms,
			working: agent.status === "working" || running.length > 0,
			x: spot.x,
			z: spot.z,
		};
	});
	const ready = rail.filter((ticket) => ticket.state === "ready");
	const xs = dishSpots(ready.length, floor);
	const dishes = xs.map((x, index) => ({
		ticket: ready[index] as KitchenTicket,
		x,
		z: floor.pass.z,
	}));
	const count = (state: TicketState) =>
		rail.filter((ticket) => ticket.state === state).length;
	return {
		dishes,
		dishOverflow: Math.max(0, ready.length - dishes.length),
		floor,
		rail,
		stations,
		totals: {
			burnt: count("burnt"),
			cooking: count("cooking"),
			queued: count("queued"),
			ready: ready.length,
			servedToday: tickets.filter(
				(ticket) =>
					isToday(ticket.updatedAt, now) &&
					(ticket.thread.lastMessageRole === "user" || ticket.thread.running)
			).length,
		},
	};
}

/** Every order a chef has had, open ones first (for the chef's panel). */
export function chefOrders(
	snapshot: InterfaceSnapshot,
	agentId: string
): KitchenTicket[] {
	return snapshot.threads
		.filter((thread) => thread.agentIds.includes(agentId))
		.map((thread) => toTicket(snapshot, thread))
		.sort((a, b) => {
			const served =
				Number(a.state === "served") - Number(b.state === "served");
			if (served !== 0) {
				return served;
			}
			return a.state === "served"
				? b.updatedAt - a.updatedAt
				: compareTickets(a, b);
		});
}

/** Next or previous index in a list, wrapping. */
export function cycleIndex(length: number, index: number, step: number) {
	if (length === 0) {
		return -1;
	}
	return (((index + step) % length) + length) % length;
}
