import type { InstanceSpec } from "./game3d-instances.tsx";
import { jitter } from "./game3d-math.ts";
import type { Vec3 } from "./game3d-palette.ts";
import type { VillagerPose } from "./game3d-villager.tsx";
import {
	BELT_REST,
	FLOOR,
	type FloorPlacement,
	type OrderTab,
	type Picker,
	STAGE_LABELS,
	type WarehouseOrder,
} from "./warehouse-model.ts";

/** One floor tile is this many world units. */
export const TILE = 0.8;
export const SLAB = 0.12;
export const WALL_HEIGHT = 2.5;
export const WALL_THICK = 0.16;
/** The truck backed up to the dock, and the returns cage (floor tiles). */
export const TRUCK = { x: 17.4, y: 8.4 } as const;
export const CAGE = { d: 2.9, w: 2.8, x: 10.55, y: 10.65 } as const;
export const BELT_TOP = 0.44;
export const BOX = 0.36;

/** A floor tile point (x along the dock wall, y toward the viewer) in world units. */
export function tileToWorld(x: number, y: number, height = 0): Vec3 {
	return [(x - FLOOR.width / 2) * TILE, height, (y - FLOOR.depth / 2) * TILE];
}

/** The floor's extent in world units, the yard and truck included. */
export const WAREHOUSE_BOUNDS = {
	maxX: (TRUCK.x + 3.4 - FLOOR.width / 2) * TILE,
	maxZ: (FLOOR.depth / 2) * TILE,
	minX: (-FLOOR.width / 2) * TILE,
	minZ: (-FLOOR.depth / 2) * TILE,
};

/** A picker's villager pose from what they carry and what waits for them. */
export function pickerPose(
	picker: Picker,
	orders: readonly WarehouseOrder[]
): VillagerPose {
	if (picker.pose === "picking" || picker.pose === "packing") {
		return "working";
	}
	const mine = orders.filter((order) => order.agent?.id === picker.agent.id);
	if (mine.some((order) => order.stage === "exception")) {
		return "failed";
	}
	if (mine.some((order) => order.stage === "ready")) {
		return "needs-you";
	}
	return "idle";
}

/** The zone a plate opens on the clipboard. */
export interface FloorZone {
	at: Vec3;
	count: number;
	id: string;
	label: string;
	tab: OrderTab;
}

/** The plates over the floor's zones, with their order counts. */
export function floorZones(
	placement: FloorPlacement,
	orders: readonly WarehouseOrder[],
	/** With acts the shipped plate drops beside the truck, clear of the queue. */
	acting = false
): FloorZone[] {
	const count = (stage: WarehouseOrder["stage"]) =>
		orders.filter((order) => order.stage === stage).length;
	const zones: FloorZone[] = [
		{
			// With acts it steps back by the door, clear of the queue's asks.
			at: acting ? tileToWorld(12, 0.4, 1.15) : tileToWorld(12.3, 1.05, 1.15),
			count: count("received"),
			id: "received",
			label: STAGE_LABELS.received,
			tab: "unfulfilled",
		},
		{
			at: tileToWorld(15.9, 3.6, 1.7),
			count: placement.packing.length + placement.overflow.packing,
			id: "packing",
			label: STAGE_LABELS.packing,
			tab: "unfulfilled",
		},
		{
			// With acts it steps forward, clear of the next picker's board.
			at: acting ? tileToWorld(14.1, 10.5, 1.15) : tileToWorld(14.1, 9.9, 1.15),
			count: count("ready"),
			id: "ready",
			label: STAGE_LABELS.ready,
			tab: "ready",
		},
		{
			// With acts the beacon stands over the cage: the plate drops to its front.
			at: acting
				? tileToWorld(CAGE.x + 0.6, CAGE.y + CAGE.d + 0.3, 1.0)
				: tileToWorld(CAGE.x + CAGE.w / 2, CAGE.y + CAGE.d / 2, 1.55),
			count: count("exception"),
			id: "exception",
			label: "Exceptions",
			tab: "exceptions",
		},
		{
			at: acting
				? tileToWorld(TRUCK.x + 1.4, TRUCK.y + 2.4, 1.6)
				: tileToWorld(TRUCK.x + 1.4, TRUCK.y + 0.9, 2.1),
			count: count("shipped"),
			id: "shipped",
			label: STAGE_LABELS.shipped,
			tab: "all",
		},
	];
	// With acts nothing packs on the belt (a live run is picking), so its
	// plate would always read 0.
	return acting ? zones.filter((zone) => zone.id !== "packing") : zones;
}

/** Where an order's box sits right now (world), for the selection ring. */
export function boxSpot(
	orderId: string,
	placement: FloorPlacement,
	pickers: readonly Picker[]
): Vec3 | null {
	const slotted = [
		...placement.received,
		...placement.ready,
		...placement.exception,
	].find((item) => item.order.id === orderId);
	if (slotted) {
		return tileToWorld(slotted.slot.x, slotted.slot.y, SLAB);
	}
	const belt = placement.packing.findIndex((order) => order.id === orderId);
	if (belt !== -1) {
		const slot = BELT_REST[belt] ?? BELT_REST[0];
		return slot ? tileToWorld(slot.x, slot.y, SLAB) : null;
	}
	const picker = pickers.find((item) =>
		item.carrying.some((order) => order.id === orderId)
	);
	if (picker) {
		return tileToWorld(picker.x, picker.y, SLAB);
	}
	if (placement.shipped.some((order) => order.id === orderId)) {
		return tileToWorld(TRUCK.x + 1.4, TRUCK.y + 0.9, SLAB);
	}
	return null;
}

export function addBox(
	parts: {
		boxes: InstanceSpec[];
		tapes: InstanceSpec[];
		labels: InstanceSpec[];
	},
	at: Vec3,
	color: string,
	label: boolean,
	seed: number
) {
	const size = BOX * (0.9 + jitter(seed, 1, 3) * 0.2);
	const turn = (jitter(seed, 2, 5) - 0.5) * 0.4;
	parts.boxes.push({
		color,
		position: [at[0], at[1] + size / 2, at[2]],
		rotation: [0, turn, 0],
		scale: [size, size * 0.8, size],
	});
	parts.tapes.push({
		position: [at[0], at[1] + size * 0.8 + 0.004, at[2]],
		rotation: [0, turn, 0],
		scale: [size * 0.22, 0.01, size + 0.01],
	});
	if (label) {
		parts.labels.push({
			position: [at[0], at[1] + size * 0.4, at[2] + size / 2 + 0.004],
			rotation: [0, turn, 0],
			scale: [size * 0.5, size * 0.3, 0.01],
		});
	}
}
