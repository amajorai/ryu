import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

/**
 * Warehouse view model: every conversation is an order moving through the
 * fulfillment stages, every agent a picker working one aisle. Pure functions
 * only, so the floor and the orders panel agree and tests can pin them.
 */

export type OrderStage =
	| "exception"
	/** Act layer only: a run that failed too long ago to count (a dim mark). */
	| "stale"
	/** Act layer only: the agent sits out a limit until it resets. */
	| "parked"
	| "packing"
	| "picking"
	| "ready"
	| "received"
	| "shipped";

/** Pipeline order, left to right, as the floor and the progress strip read it. */
export const STAGE_PIPELINE: readonly OrderStage[] = [
	"received",
	"picking",
	"packing",
	"ready",
	"shipped",
];

export const STAGE_LABELS: Record<OrderStage, string> = {
	exception: "Exception",
	packing: "Packing",
	parked: "Parked",
	picking: "Picking",
	ready: "Ready to ship",
	received: "Received",
	shipped: "Shipped",
	stale: "Old failure",
};

/**
 * A stage's name. With the act layer an exception is a counted stopped run
 * (failed or interrupted, recent or unread), as the Queue's "runs stopped"
 * group counts them, so it reads "Stopped".
 */
export function stageLabel(stage: OrderStage, acts: boolean): string {
	return acts && stage === "exception" ? "Stopped" : STAGE_LABELS[stage];
}

/** A tab's name, as `stageLabel` names its stage. */
export function tabLabel(tab: OrderTab, acts: boolean): string {
	if (acts && tab === "exceptions") {
		return "Stopped";
	}
	return ORDER_TABS.find((item) => item.id === tab)?.label ?? tab;
}

/** What each stage means in conversation terms (detail view, tooltips). */
export const STAGE_MEANING: Record<OrderStage, string> = {
	exception: "The last run failed or was interrupted",
	packing: "The agent is wrapping up a reply",
	parked: "The agent hit a limit and waits for it to reset",
	picking: "The agent is working on it",
	ready: "Your turn: the agent replied or asks you something",
	received: "You wrote. The agent has not started yet",
	shipped: "Done. Nothing new since the last reply",
	stale: "An older run failed; it no longer needs you",
};

/** A live run updated this recently is packing its reply, not still picking. */
export const PACKING_WINDOW_MS = 2 * 60_000;
/** A reply waits at the dock this long before it counts as shipped. */
export const DOCK_WINDOW_MS = 24 * 60 * 60_000;

function age(thread: InterfaceThread, now: number): number {
	const then = Date.parse(thread.updatedAt);
	return Number.isNaN(then) ? Number.POSITIVE_INFINITY : now - then;
}

/** What the act layer knows about the threads, for their order stages. */
export interface OrderActs {
	/** Threads waiting on your answer (an ask, or an agent asking on it). */
	asked: ReadonlySet<string>;
	/** Threads an agent's act is still about (working, waiting): never shipped. */
	held: ReadonlySet<string>;
	/** Threads whose agent sits out a limit. */
	limited: ReadonlySet<string>;
	/** Threads with a counted blocker (the Queue's "runs stopped"). */
	stopped: ReadonlySet<string>;
}

/**
 * An order's stage. With the act layer (`acts`) no stage is guessed from
 * the clock: a live run is picking (no 2-minute packing window), a stopped
 * run is an exception only while its blocker counts (an older one is
 * "stale"), a thread waiting on your answer is ready (your turn), one
 * whose agent sits out a limit is parked, and a reply ships only once it
 * is read and nothing about its thread still waits.
 */
export function orderStage(
	thread: InterfaceThread,
	now: number,
	acts?: OrderActs
): OrderStage {
	if (acts?.limited.has(thread.id)) {
		return "parked";
	}
	if (acts?.asked.has(thread.id) && !acts.stopped.has(thread.id)) {
		return "ready";
	}
	switch (threadStatus(thread)) {
		case "attention":
			if (acts) {
				return acts.stopped.has(thread.id) ? "exception" : "stale";
			}
			return "exception";
		case "working":
			if (acts) {
				return "picking";
			}
			return age(thread, now) <= PACKING_WINDOW_MS ? "packing" : "picking";
		case "waiting":
			return "received";
		case "your-turn":
			if (acts) {
				if ((thread.unread ?? 0) > 0) {
					return "ready";
				}
				return acts.held.has(thread.id) ? "picking" : "shipped";
			}
			return age(thread, now) <= DOCK_WINDOW_MS ? "ready" : "shipped";
		default:
			// An agent still at it on a quiet thread is picking, not done.
			return acts?.held.has(thread.id) ? "picking" : "shipped";
	}
}

/** FNV-1a: small, stable across runtimes, good enough to spread ids. */
export function hashId(id: string): number {
	let hash = 2_166_136_261;
	for (const char of id) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16_777_619);
	}
	return hash >>> 0;
}

/** Four-digit order numbers: `#R-1000` through `#R-9999`. */
const ORDER_SLOTS = 9000;

function formatOrderNumber(slot: number): string {
	return `#R-${1000 + slot}`;
}

/** A stable, human order number for a thread id, e.g. `#R-1042`. */
export function orderNumber(threadId: string): string {
	return formatOrderNumber(hashId(threadId) % ORDER_SLOTS);
}

function byCodeUnit(a: string, b: string): number {
	if (a === b) {
		return 0;
	}
	return a < b ? -1 : 1;
}

/**
 * Order numbers for a set of threads with no two alike: each id keeps its
 * `orderNumber` unless an earlier id (by id, so recency never reshuffles
 * them) already took it, then it moves to the next free number.
 */
export function orderNumbers(
	threadIds: readonly string[]
): Map<string, string> {
	const used = new Set<number>();
	const numbers = new Map<string, string>();
	for (const id of [...new Set(threadIds)].sort(byCodeUnit)) {
		let slot = hashId(id) % ORDER_SLOTS;
		if (used.size < ORDER_SLOTS) {
			while (used.has(slot)) {
				slot = (slot + 1) % ORDER_SLOTS;
			}
		} else {
			// Every four-digit number is taken; count on past them.
			slot = used.size;
		}
		used.add(slot);
		numbers.set(id, formatOrderNumber(slot));
	}
	return numbers;
}

export interface WarehouseOrder {
	agent: InterfaceAgent | undefined;
	id: string;
	number: string;
	stage: OrderStage;
	thread: InterfaceThread;
}

function byRecency(a: InterfaceThread, b: InterfaceThread): number {
	return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
}

/** Every thread as an order, newest first (the way an order list reads). */
export function buildOrders(
	snapshot: InterfaceSnapshot,
	now: number,
	acts?: OrderActs
): WarehouseOrder[] {
	const agents = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
	const numbers = orderNumbers(snapshot.threads.map((thread) => thread.id));
	return [...snapshot.threads].sort(byRecency).map((thread) => ({
		agent: agents.get(thread.agentIds[0] ?? ""),
		id: thread.id,
		number: numbers.get(thread.id) ?? orderNumber(thread.id),
		stage: orderStage(thread, now, acts),
		thread,
	}));
}

export type OrderTab = "all" | "exceptions" | "ready" | "unfulfilled";

export const ORDER_TABS: readonly { id: OrderTab; label: string }[] = [
	{ id: "all", label: "All" },
	{ id: "unfulfilled", label: "Unfulfilled" },
	{ id: "ready", label: "Ready to ship" },
	{ id: "exceptions", label: "Exceptions" },
];

const UNFULFILLED = new Set<OrderStage>([
	"packing",
	"parked",
	"picking",
	"received",
]);

export function inTab(order: WarehouseOrder, tab: OrderTab): boolean {
	switch (tab) {
		case "unfulfilled":
			return UNFULFILLED.has(order.stage);
		case "ready":
			return order.stage === "ready";
		case "exceptions":
			return order.stage === "exception";
		default:
			return true;
	}
}

export function filterOrders(
	orders: readonly WarehouseOrder[],
	tab: OrderTab,
	fulfillerId: string | null
): WarehouseOrder[] {
	return orders.filter(
		(order) =>
			inTab(order, tab) &&
			(fulfillerId === null || order.agent?.id === fulfillerId)
	);
}

export function tabCounts(
	orders: readonly WarehouseOrder[],
	fulfillerId: string | null
): Record<OrderTab, number> {
	const counts: Record<OrderTab, number> = {
		all: 0,
		exceptions: 0,
		ready: 0,
		unfulfilled: 0,
	};
	for (const order of orders) {
		if (fulfillerId !== null && order.agent?.id !== fulfillerId) {
			continue;
		}
		for (const tab of ORDER_TABS) {
			if (inTab(order, tab.id)) {
				counts[tab.id] += 1;
			}
		}
	}
	return counts;
}

export interface FloorStats {
	exceptions: number;
	ready: number;
	/** Orders touched today (from `updatedAt`: never shown under acts). */
	today: number;
	/** Every order on the clipboard (the act layer's "Orders"). */
	total: number;
	/** Received, picking or packing: the same rows as the Unfulfilled tab. */
	unfulfilled: number;
}

export function floorStats(
	orders: readonly WarehouseOrder[],
	now: number
): FloorStats {
	const today = localDayKey(new Date(now));
	const stats: FloorStats = {
		exceptions: 0,
		ready: 0,
		today: 0,
		total: orders.length,
		unfulfilled: 0,
	};
	for (const order of orders) {
		const updated = Date.parse(order.thread.updatedAt);
		if (!Number.isNaN(updated) && localDayKey(new Date(updated)) === today) {
			stats.today += 1;
		}
		if (UNFULFILLED.has(order.stage)) {
			stats.unfulfilled += 1;
		} else if (order.stage === "ready") {
			stats.ready += 1;
		} else if (order.stage === "exception") {
			stats.exceptions += 1;
		}
	}
	return stats;
}

export function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// Floor plan (grid units; warehouse-diorama.tsx maps them to the 3D world)
// ---------------------------------------------------------------------------

/** Floor size in tiles: x runs to the right-hand dock, y toward the viewer. */
export const FLOOR = { depth: 14, width: 16 } as const;
export const AISLE_COUNT = 6;
export const AISLE_LETTERS = ["A", "B", "C", "D", "E", "F"] as const;
/**
 * Shelving rows run along x, one per aisle; each aisle is the walkway in
 * front of its row. Shelves stay low enough that a picker's head and cart
 * show over the row in front.
 */
export const RACK = {
	depth: 0.6,
	firstRow: 0.7,
	pitch: 2.1,
	x0: 1.5,
	x1: 8.5,
} as const;

/** Rows of shelving from the back wall forward. */
export function rackRowY(row: number): number {
	return RACK.firstRow + row * RACK.pitch;
}

/** The walking line down the middle of an aisle. */
export function aisleY(aisle: number): number {
	return rackRowY(aisle) + RACK.depth + (RACK.pitch - RACK.depth) / 2;
}

/** Where an idle picker waits: at the aisle's mouth on the cross walkway. */
export const AISLE_MOUTH_X = 9.35;
/** Where a picker stands while their order is at the packing station. */
export const PACKER_SPOT = { x: 15.15, y: 6.05 } as const;

export interface PickerRoute {
	/** Seconds for one loop. */
	duration: number;
	/** Keyframe times in [0, 1], one per x stop. */
	times: number[];
	/** x positions along the aisle (y is fixed). */
	xs: number[];
}

const SHELF_STOPS = [2.1, 3.1, 4.1, 5.1, 6.1, 7.1, 7.9] as const;

/**
 * A picker's walk between shelves: three stops picked from the agent id,
 * pausing at each, then back to the first. Stable per agent, so a re-render
 * never teleports anyone.
 */
export function pickerRoute(agentId: string): PickerRoute {
	const hash = hashId(agentId);
	const stops: number[] = [];
	for (let step = 0; step < 3; step += 1) {
		const pick = SHELF_STOPS[(hash >>> (step * 5)) % SHELF_STOPS.length] ?? 4.1;
		if (stops.at(-1) === pick) {
			stops.push(SHELF_STOPS[(SHELF_STOPS.indexOf(pick) + 3) % 7] ?? 4.1);
		} else {
			stops.push(pick);
		}
	}
	const xs: number[] = [];
	for (const stop of [...stops, stops[0] ?? 4.1]) {
		// Arrive, then hold a moment at the shelf.
		xs.push(stop, stop);
	}
	const legs = xs.length - 1;
	const times = xs.map((_, index) => index / legs);
	return { duration: 9 + (hash % 5), times, xs };
}

export type PickerPose = "idle" | "packing" | "picking";

export interface Picker {
	agent: InterfaceAgent;
	aisle: number;
	/** Orders this picker is carrying (picking stage), newest first. */
	carrying: WarehouseOrder[];
	/** Color slot for the vest. */
	hue: number;
	pose: PickerPose;
	route: PickerRoute;
	/** Rest position when not walking. */
	x: number;
	y: number;
}

/** Assign agents to aisles in snapshot order; a seventh agent shares aisle A. */
export function buildPickers(
	agents: readonly InterfaceAgent[],
	orders: readonly WarehouseOrder[]
): Picker[] {
	return agents.map((agent, index) => {
		const aisle = index % AISLE_COUNT;
		const lane = Math.floor(index / AISLE_COUNT);
		const mine = orders.filter((order) => order.agent?.id === agent.id);
		const carrying = mine.filter((order) => order.stage === "picking");
		const packing = mine.some((order) => order.stage === "packing");
		let pose: PickerPose = "idle";
		if (carrying.length > 0) {
			pose = "picking";
		} else if (packing && lane === 0) {
			pose = "packing";
		}
		const atStation = pose === "packing";
		return {
			agent,
			aisle,
			carrying,
			hue: index,
			pose,
			route: pickerRoute(agent.id),
			x: atStation ? PACKER_SPOT.x : AISLE_MOUTH_X + lane * 0.55,
			y: atStation ? PACKER_SPOT.y : aisleY(aisle),
		};
	});
}

/** A spot on the floor (grid units) an order box occupies. */
export interface Slot {
	x: number;
	y: number;
}

/** Inbound pallets along the back wall, by the receiving door. */
export const RECEIVED_SLOTS: readonly Slot[] = [
	{ x: 10.7, y: 0.55 },
	{ x: 11.8, y: 0.55 },
	{ x: 12.9, y: 0.55 },
	{ x: 14.0, y: 0.55 },
	{ x: 10.7, y: 1.55 },
	{ x: 11.8, y: 1.55 },
	{ x: 12.9, y: 1.55 },
	{ x: 14.0, y: 1.55 },
];

/** Staging pallets on the dock, waiting for the truck. */
export const READY_SLOTS: readonly Slot[] = [
	{ x: 13.6, y: 8.85 },
	{ x: 14.65, y: 8.85 },
	{ x: 13.6, y: 9.9 },
	{ x: 14.65, y: 9.9 },
	{ x: 13.6, y: 10.95 },
	{ x: 14.65, y: 10.95 },
];

/**
 * Inside the returns cage: the first box in the middle, so its number tag
 * sits on the mesh roof clear of the cage's edges; the rest in the corners.
 */
export const EXCEPTION_SLOTS: readonly Slot[] = [
	{ x: 11.6, y: 11.7 },
	{ x: 10.75, y: 10.85 },
	{ x: 12.5, y: 10.85 },
	{ x: 10.75, y: 12.65 },
	{ x: 12.5, y: 12.65 },
];

/** The belt route a packing box rides: front run, then up to the station. */
export const BELT_PATH: readonly Slot[] = [
	{ x: 10.7, y: 6.9 },
	{ x: 14.3, y: 6.9 },
	{ x: 14.3, y: 4.6 },
];

/** Resting spots on the belt when motion is reduced (closest to the station first). */
export const BELT_REST: readonly Slot[] = [
	{ x: 14.3, y: 4.6 },
	{ x: 14.3, y: 5.7 },
	{ x: 13.4, y: 6.9 },
	{ x: 12.3, y: 6.9 },
	{ x: 11.2, y: 6.9 },
];

export interface FloorPlacement {
	/** Orders that have a box on a static slot, keyed by stage. */
	exception: { order: WarehouseOrder; slot: Slot }[];
	/** Orders that did not fit a slot, by stage (shown as counts). */
	overflow: Record<OrderStage, number>;
	packing: WarehouseOrder[];
	ready: { order: WarehouseOrder; slot: Slot }[];
	received: { order: WarehouseOrder; slot: Slot }[];
	shipped: WarehouseOrder[];
}

/** Put each order's box where its stage lives on the floor. */
export function placeOrders(orders: readonly WarehouseOrder[]): FloorPlacement {
	const placement: FloorPlacement = {
		exception: [],
		overflow: {
			exception: 0,
			packing: 0,
			parked: 0,
			picking: 0,
			ready: 0,
			received: 0,
			shipped: 0,
			stale: 0,
		},
		packing: [],
		ready: [],
		received: [],
		shipped: [],
	};
	const slotted = (
		list: { order: WarehouseOrder; slot: Slot }[],
		slots: readonly Slot[],
		order: WarehouseOrder
	) => {
		const slot = slots[list.length];
		if (slot) {
			list.push({ order, slot });
		} else {
			placement.overflow[order.stage] += 1;
		}
	};
	for (const order of orders) {
		switch (order.stage) {
			case "received":
				slotted(placement.received, RECEIVED_SLOTS, order);
				break;
			case "ready":
				slotted(placement.ready, READY_SLOTS, order);
				break;
			case "exception":
				slotted(placement.exception, EXCEPTION_SLOTS, order);
				break;
			case "packing":
				if (placement.packing.length < BELT_REST.length) {
					placement.packing.push(order);
				} else {
					placement.overflow.packing += 1;
				}
				break;
			case "shipped":
				placement.shipped.push(order);
				break;
			default:
				break;
		}
	}
	return placement;
}

/** The aisle letter an agent picks in, for the panel. */
export function aisleLabel(
	agentId: string | undefined,
	agents: readonly InterfaceAgent[]
): string | null {
	if (!agentId) {
		return null;
	}
	const index = agents.findIndex((agent) => agent.id === agentId);
	return index === -1 ? null : `Aisle ${AISLE_LETTERS[index % AISLE_COUNT]}`;
}
