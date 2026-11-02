import { translate as tr } from "@ryu/i18n/lite";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import {
	hashId,
	type OrderStage,
	type WarehouseOrder,
} from "./warehouse-model.ts";

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
	return index === -1
		? null
		: tr("Aisle {letter}", { letter: AISLE_LETTERS[index % AISLE_COUNT] });
}
