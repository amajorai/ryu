import type { MarketShop, MarketShopKind } from "./market-model.ts";

// ---------------------------------------------------------------------------
// The market square, in world units (the game kit's diorama frame: x right,
// z toward the viewer, y up; a villager is about one unit tall)
// ---------------------------------------------------------------------------

export type Vec3 = [number, number, number];

/** A lot's footprint: its building's width and depth and its wall height. */
export const LOT_SIZE: Record<
	MarketShopKind,
	{ depth: number; height: number; width: number }
> = {
	general: { depth: 2.4, height: 2.5, width: 4.4 },
	shop: { depth: 2.2, height: 2.3, width: 3.5 },
	stall: { depth: 1.9, height: 1.7, width: 3.2 },
};

/** Shopkeepers shown at each kind of lot (the sheet lists them all). */
const KEEPERS_SHOWN: Record<MarketShopKind, number> = {
	general: 3,
	shop: 2,
	stall: 3,
};
/** Customers queueing at one shop at most (the sign counts the rest). */
export const QUEUE_SHOWN = 3;
/** A shop's fascia board sits between its awning and its eaves. */
const SIGN_Y = 2.02;
/** Customer to customer in a queue, in world units. */
const QUEUE_GAP = 1.15;
const LOT_GAP = 1.3;
/** The pavement strip in front of the shops is this deep. */
export const PAVEMENT_DEPTH = 1.45;
const KEEPER_SPACING = 1.1;
/** The square's open edges (right and front) are at least this far out. */
const MIN_SQUARE = 5.8;
/** Lawn beyond the square's open edges, for benches, planters and trees. */
const OPEN_EDGE = 2.2;
const DEEPEST = LOT_SIZE.general.depth;

/**
 * Which way a shop faces: the back row's fronts face the viewer (+z), the
 * left row's face right (+x). The camera looks from front right, so both
 * rows show their fronts and nothing stands in front of the square.
 */
export type MarketFacing = "east" | "south";

/** A point in a lot's own frame (its front faces +z) in world units. */
export function toWorld(facing: MarketFacing, point: Vec3): Vec3 {
	return facing === "south" ? point : [point[2], point[1], -point[0]];
}

/** The yaw that turns a lot's own frame into the world. */
export const FACING_YAW: Record<MarketFacing, number> = {
	east: Math.PI / 2,
	south: 0,
};

export interface MarketLot {
	/** The shop's plate (its badge), at the signboard's end (world). */
	badge: Vec3;
	facing: MarketFacing;
	/**
	 * The lot in its own frame (front faces +z): the middle of its frontage
	 * at ground level, its signboard and its display table.
	 */
	frame: { front: number; sign: Vec3; table: Vec3 | null; x: number };
	/** Where each shown shopkeeper stands (world), in `shop.agents` order. */
	keepers: Vec3[];
	/** Where queueing customers stand (world), front of the queue first. */
	queue: Vec3[];
	shop: MarketShop;
	/** The painted signboard's middle (world). */
	sign: Vec3;
	size: { depth: number; height: number; width: number };
}

export interface MarketRect {
	maxX: number;
	maxZ: number;
	minX: number;
	minZ: number;
}

export interface MarketSquare {
	bounds: MarketRect;
	lots: MarketLot[];
	/** The cobbled square between the two rows (world). */
	square: MarketRect;
}

/**
 * How the act layer lays the street out (spec §5, market row): every
 * shopkeeper gets a station of its own (a lot widens to fit them), and the
 * customers queueing at a shop are its upcoming runs, not the orders that
 * need you (those queue at the market cross).
 */
export interface MarketActLayout {
	/**
	 * The back row's start from the square's corner (default
	 * `ACT_BACK_INSET`; a phone shows no work bubbles, so it can start nearer).
	 */
	backInset?: number;
	/** Keeper to keeper along the left row (default `ACT_EAST_SPACING`). */
	eastSpacing?: number;
	/** Customers per shop id: its upcoming runs. */
	queue: ReadonlyMap<string, number>;
	/** Keeper to keeper along the back row (default `ACT_KEEPER_SPACING`). */
	spacing?: number;
	/** The square's least depth and width (default `ACT_MIN_SQUARE`). */
	square?: number;
}

/**
 * Keeper to keeper along the back row when every keeper has a station:
 * room for its props. Along the back row the next keeper stands down and to
 * the right on the screen, below the work bubble hanging up and to the
 * right of a keeper's plate, so the bubble never covers it.
 */
export const ACT_KEEPER_SPACING = 3.9;
/**
 * Along the left row the next keeper stands up and to the right, where the
 * work bubble hangs: it stands far enough along that its feet are clear
 * above the bubble (the row climbs 0.375 of a unit up the screen per unit;
 * a bubble's top is about 44 px over its keeper's plate, the figure 41 px
 * under its own). The act layout puts the shops with the fewest keepers in
 * this row.
 */
export const ACT_EAST_SPACING = 8;
/**
 * On a phone the props are icons, no work bubble shows
 * (`marketShownOverlays`) and the street turns to run down the screen, so
 * keepers stand closer: a longer street would shrink everything on it.
 */
export const ACT_KEEPER_SPACING_NARROW = 4;
/**
 * With acts the square is at least this deep: the market cross, its ring
 * and the queue of asks stand clear of the back row's stations.
 */
export const ACT_MIN_SQUARE = 11.5;
/**
 * On a phone no ask or work bubble hangs over the square, so the market
 * cross can stand nearer the back row and the square is shallower (its
 * depth runs across a phone's screen).
 */
export const ACT_MIN_SQUARE_NARROW = 10.5;
/** A stall counter's front face, from the stall's front (market-shops.tsx). */
const STALL_COUNTER_FRONT = -0.1;
/** With acts, the back row's first lot starts this far from the corner. */
const ACT_BACK_INSET = 3.2;
/** Act-layout customers: from the lot's edge, out from its frontage. */
const ACT_QUEUE_OUT = 1.9;
const ACT_QUEUE_GAP = 1;

/** Keeper to keeper in a row. */
function rowSpacing(
	facing: MarketFacing,
	acts: MarketActLayout | undefined
): number {
	if (!acts) {
		return KEEPER_SPACING;
	}
	return facing === "south"
		? (acts.spacing ?? ACT_KEEPER_SPACING)
		: (acts.eastSpacing ?? ACT_EAST_SPACING);
}

/** A lot's size: wider in the act layout when its keepers need the room. */
function lotSize(
	shop: MarketShop,
	facing: MarketFacing,
	acts: MarketActLayout | undefined
): { depth: number; height: number; width: number } {
	const size = LOT_SIZE[shop.kind];
	if (!acts) {
		return size;
	}
	return {
		...size,
		width: Math.max(
			size.width,
			shop.agents.length * rowSpacing(facing, acts) + 0.4
		),
	};
}

/** Lots along one row, in their own frame, from `start` along +x. */
function placeRow(
	shops: MarketShop[],
	facing: MarketFacing,
	start: number,
	direction: 1 | -1,
	acts?: MarketActLayout
): MarketLot[] {
	const lots: MarketLot[] = [];
	let along = start;
	for (const shop of shops) {
		const size = lotSize(shop, facing, acts);
		const x = direction > 0 ? along + size.width / 2 : along - size.width / 2;
		const stall = shop.kind === "stall";
		const shown = acts
			? shop.agents.length
			: Math.min(shop.agents.length, KEEPERS_SHOWN[shop.kind]);
		const spacing = rowSpacing(facing, acts);
		// The queue forms on the side away from the square's back corner.
		const away = facing === "south" ? 1 : -1;
		// Keepers stand under the awning (in a stall, behind its counter),
		// a little off centre so the queue has room beside them.
		// With acts every keeper stands before its lot's front (a stall's
		// counter), where the camera sees it under the canopy.
		let keeperZ = stall ? -size.depth / 2 + 0.15 : 0.55;
		if (acts) {
			keeperZ = stall ? STALL_COUNTER_FRONT + 0.55 : 0.55;
		}
		const keepers: Vec3[] = [];
		for (let index = 0; index < shown; index++) {
			const offset = (index - (shown - 1) / 2) * spacing;
			keepers.push(
				toWorld(facing, [
					x - (acts ? 0 : away * (stall ? 0 : 0.25)) + offset,
					0,
					// Today's layout nudges every other keeper back a little.
					keeperZ - (acts ? 0 : (index % 2) * 0.12),
				])
			);
		}
		const queue: Vec3[] = [];
		const waiting = Math.min(
			acts ? (acts.queue.get(shop.id) ?? 0) : shop.waitingOnYou,
			QUEUE_SHOWN
		);
		if (acts) {
			// With acts the frontage is the keepers' stations: the customers
			// line up beyond the last keeper's stretch, in the gap past the
			// lot's end, out from the frontage.
			const edge = x + away * (size.width / 2 + LOT_GAP / 2);
			for (let index = 0; index < waiting; index++) {
				queue.push(
					toWorld(facing, [edge, 0, ACT_QUEUE_OUT + index * ACT_QUEUE_GAP])
				);
			}
		} else {
			// A short line, a villager's width and a little apart.
			const queueStart = x + away * (stall ? 0.75 : 1.1);
			for (let index = 0; index < waiting; index++) {
				queue.push(
					toWorld(facing, [
						queueStart + away * index * QUEUE_GAP,
						0,
						stall ? 0.85 : 1.8,
					])
				);
			}
		}
		const sign: Vec3 = stall
			? [x, size.height + 1.2, -size.depth / 2 + 0.1]
			: [x, SIGN_Y, 0.12];
		lots.push({
			facing,
			frame: {
				front: 0,
				sign,
				table: stall ? null : [x - away * 0.25, 0, 1.05],
				x,
			},
			keepers,
			queue,
			shop,
			// With acts the badge rides higher, clear of the work bubbles that
			// hang up and to the right of the keepers' plates; in the back row
			// it stands over the lot's first end, up and to the left of its
			// first keeper (in the left row the bubbles hang toward its back,
			// so it keeps today's end, the front one).
			badge: toWorld(
				facing,
				acts && facing === "south"
					? [
							x - away * (size.width / 2 - 0.3),
							sign[1] + (stall ? 0.55 : 1.1),
							sign[2] + 0.05,
						]
					: [
							sign[0] + away * size.width * (stall ? 0.3 : 0.33) + away * 0.35,
							sign[1] + (acts ? 1.1 : 0.55),
							sign[2] + 0.05,
						]
			),
			sign: toWorld(facing, sign),
			size,
		});
		along += direction * (size.width + LOT_GAP);
	}
	return lots;
}

function rowLength(
	shops: MarketShop[],
	facing: MarketFacing,
	acts?: MarketActLayout
): number {
	return (
		shops.reduce((sum, shop) => sum + lotSize(shop, facing, acts).width, 0) +
		LOT_GAP * Math.max(0, shops.length - 1)
	);
}

/**
 * The market square: shops in an L around a cobbled square, the back row
 * facing the viewer and the left row facing right, each with its
 * shopkeepers out front and a queue of customers for every conversation
 * waiting on you. The square's inner corner starts at the origin; the
 * whole is then centred on it. With `acts`, see `MarketActLayout`.
 */
export function layoutMarket(
	shops: MarketShop[],
	acts?: MarketActLayout
): MarketSquare {
	const backCount = Math.ceil(shops.length / 2);
	// With acts the back row takes the shops with the most keepers (stable):
	// a work bubble there never covers the next keeper (`ACT_EAST_SPACING`).
	const order = acts
		? [...shops].sort((a, b) => b.agents.length - a.agents.length)
		: shops;
	const back = order.slice(0, backCount);
	const left = order.slice(backCount);
	// The rows start a step out from the inner corner, so the corner shops'
	// walls never meet.
	const inset = 0.9;
	// With acts the back row starts further from the corner, so the first
	// keeper there stands clear of the bubble of the left row's last one.
	const backLots = placeRow(
		back,
		"south",
		acts ? (acts.backInset ?? ACT_BACK_INSET) : inset,
		1,
		acts
	);
	// In the left row's frame, +x runs toward the back: walk it forward.
	const leftLots = placeRow(left, "east", -inset, -1, acts);
	const least = acts ? (acts.square ?? ACT_MIN_SQUARE) : MIN_SQUARE;
	const width = Math.max(
		least,
		(acts ? (acts.backInset ?? ACT_BACK_INSET) : inset) +
			rowLength(back, "south", acts) +
			0.6
	);
	const depth = Math.max(least, inset + rowLength(left, "east", acts) + 0.6);
	const square: MarketRect = { maxX: width, maxZ: depth, minX: 0, minZ: 0 };
	const raw: MarketRect = {
		maxX: width + OPEN_EDGE,
		maxZ: depth + OPEN_EDGE,
		minX: -DEEPEST - 0.6,
		minZ: -DEEPEST - 0.6,
	};
	const dx = -(raw.minX + raw.maxX) / 2;
	const dz = -(raw.minZ + raw.maxZ) / 2;
	const move = (point: Vec3): Vec3 => [point[0] + dx, point[1], point[2] + dz];
	const lots = [...backLots, ...leftLots].map((lot) => {
		// The lot's own frame moves by the world shift turned into it.
		const shift: Vec3 = lot.facing === "south" ? [dx, 0, dz] : [-dz, 0, dx];
		const frame = (point: Vec3): Vec3 => [
			point[0] + shift[0],
			point[1],
			point[2] + shift[2],
		];
		return {
			...lot,
			frame: {
				front: lot.frame.front + shift[2],
				sign: frame(lot.frame.sign),
				table: lot.frame.table ? frame(lot.frame.table) : null,
				x: lot.frame.x + shift[0],
			},
			badge: move(lot.badge),
			keepers: lot.keepers.map(move),
			queue: lot.queue.map(move),
			sign: move(lot.sign),
		};
	});
	const shiftRect = (rect: MarketRect): MarketRect => ({
		maxX: rect.maxX + dx,
		maxZ: rect.maxZ + dz,
		minX: rect.minX + dx,
		minZ: rect.minZ + dz,
	});
	return { bounds: shiftRect(raw), lots, square: shiftRect(square) };
}
