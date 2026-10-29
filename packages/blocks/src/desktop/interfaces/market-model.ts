import {
	type InterfaceAgent,
	type InterfacePort,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { MARKET_SWATCHES } from "./market-palette.ts";

/** A project is a shop, a team is a stall, everything else the general store. */
export type MarketShopKind = "general" | "shop" | "stall";

export interface MarketShopStyle {
	awning: number;
	door: number;
	goods: number;
	/** What stands on the sidewalk: 0 an A-board, 1 a crate, 2 flower pots. */
	prop: number;
	/** 0 flat cornice, 1 stepped parapet, 2 gable. */
	roof: number;
	/** 0 rounded board, 1 banner with notched ends, 2 arched board. */
	sign: number;
	/** 0 one wide upper window, 1 two shuttered windows, 2 a round window. */
	upper: number;
	wall: number;
}

export interface MarketOrder {
	/** Agent serving this order: the thread's first agent. */
	agent: InterfaceAgent | undefined;
	/** Slip number within the shop, oldest order is 1. */
	number: number;
	status: ThreadStatus;
	thread: InterfaceThread;
}

export interface MarketShop {
	/** Shopkeepers: the group's members, or agents in no group. */
	agents: InterfaceAgent[];
	/** True while a shopkeeper is working or an order has a live run. */
	busy: boolean;
	counts: Record<ThreadStatus, number>;
	/** The group id for projects and teams, null for the general store. */
	groupId: string | null;
	id: string;
	kind: MarketShopKind;
	name: string;
	/** Most urgent first (status order), then most recent. */
	orders: MarketOrder[];
	/** With acts: the door sign from its keepers' acts ("Busy", "Stopped"…). */
	sign?: string;
	style: MarketShopStyle;
	/** Orders the user should act on: failed runs and replies. */
	waitingOnYou: number;
}

export const GENERAL_STORE_ID = "market-general";

function hash(seed: string): number {
	let value = 2_166_136_261;
	for (const char of seed) {
		value ^= char.codePointAt(0) ?? 0;
		value = Math.imul(value, 16_777_619);
	}
	return value >>> 0;
}

/** Deterministic facade variety from a shop id: the same id, the same shop. */
export function shopStyle(id: string): MarketShopStyle {
	const pick = (salt: string, count: number) => hash(`${salt}:${id}`) % count;
	return {
		awning: pick("awning", MARKET_SWATCHES.awning),
		door: pick("door", MARKET_SWATCHES.door),
		goods: pick("goods", MARKET_SWATCHES.goods),
		prop: pick("prop", 3),
		roof: pick("roof", 3),
		sign: pick("sign", 3),
		upper: pick("upper", 3),
		wall: pick("wall", MARKET_SWATCHES.wall),
	};
}

/** A stable small index for an agent's or customer's look. */
export function lookIndex(seed: string, count: number): number {
	return hash(seed) % count;
}

function emptyCounts(): Record<ThreadStatus, number> {
	return { attention: 0, quiet: 0, waiting: 0, working: 0, "your-turn": 0 };
}

const STATUS_RANK = new Map(
	THREAD_STATUS_ORDER.map((status, index) => [status, index])
);

function byUrgency(a: MarketOrder, b: MarketOrder): number {
	return (
		(STATUS_RANK.get(a.status) ?? 0) - (STATUS_RANK.get(b.status) ?? 0) ||
		Number(b.thread.pinned) - Number(a.thread.pinned) ||
		b.thread.updatedAt.localeCompare(a.thread.updatedAt) ||
		a.thread.id.localeCompare(b.thread.id)
	);
}

function makeShop(
	snapshot: InterfaceSnapshot,
	input: {
		agents: InterfaceAgent[];
		groupId: string | null;
		id: string;
		kind: MarketShopKind;
		name: string;
		threads: InterfaceThread[];
	}
): MarketShop {
	const byAge = [...input.threads].sort(
		(a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id)
	);
	const numbers = new Map(byAge.map((thread, index) => [thread.id, index + 1]));
	const counts = emptyCounts();
	const orders: MarketOrder[] = [];
	for (const thread of input.threads) {
		const status = threadStatus(thread);
		counts[status] += 1;
		orders.push({
			agent: snapshot.agents.find((agent) => agent.id === thread.agentIds[0]),
			number: numbers.get(thread.id) ?? 0,
			status,
			thread,
		});
	}
	orders.sort(byUrgency);
	return {
		agents: input.agents,
		busy:
			counts.working > 0 ||
			input.agents.some((agent) => agent.status === "working"),
		counts,
		groupId: input.groupId,
		id: input.id,
		kind: input.kind,
		name: input.name,
		orders,
		style: shopStyle(input.id),
		waitingOnYou: counts.attention + counts["your-turn"],
	};
}

/**
 * The street, left to right: a shop per project, a stall per team, and a
 * general store for agents and conversations filed under neither. A thread
 * filed under both a project and a team is an order at the project's shop.
 */
export function buildMarket(snapshot: InterfaceSnapshot): MarketShop[] {
	const agentsFor = (ids: string[]) =>
		ids
			.map((id) => snapshot.agents.find((agent) => agent.id === id))
			.filter((agent): agent is InterfaceAgent => agent !== undefined);
	const knownGroups = new Set(snapshot.groups.map((group) => group.id));
	const projects = snapshot.groups.filter((group) => group.kind === "project");
	const teams = snapshot.groups.filter((group) => group.kind === "team");
	const shops: MarketShop[] = [];
	for (const group of [...projects, ...teams]) {
		const threads = snapshot.threads.filter((thread) =>
			group.kind === "project"
				? thread.projectId === group.id
				: thread.teamId === group.id &&
					!(thread.projectId && knownGroups.has(thread.projectId))
		);
		shops.push(
			makeShop(snapshot, {
				agents: agentsFor(group.memberAgentIds),
				groupId: group.id,
				id: group.id,
				kind: group.kind === "project" ? "shop" : "stall",
				name: group.name.trim() || "Untitled",
				threads,
			})
		);
	}
	const grouped = new Set(
		snapshot.groups.flatMap((group) => group.memberAgentIds)
	);
	const looseAgents = snapshot.agents.filter((agent) => !grouped.has(agent.id));
	const looseThreads = snapshot.threads.filter(
		(thread) =>
			!(
				(thread.projectId && knownGroups.has(thread.projectId)) ||
				(thread.teamId && knownGroups.has(thread.teamId))
			)
	);
	if (looseAgents.length > 0 || looseThreads.length > 0) {
		shops.push(
			makeShop(snapshot, {
				agents: looseAgents,
				groupId: null,
				id: GENERAL_STORE_ID,
				kind: "general",
				name: "General store",
				threads: looseThreads,
			})
		);
	}
	// Neighbours never share a sidewalk prop; the first shop gets the A-board.
	return shops.map((shop, index) => ({
		...shop,
		style: { ...shop.style, prop: index % 3 },
	}));
}

export interface MarketTotals {
	busy: number;
	orders: number;
	shops: number;
	waitingOnYou: number;
}

export function marketTotals(shops: MarketShop[]): MarketTotals {
	let busy = 0;
	let orders = 0;
	let waitingOnYou = 0;
	for (const shop of shops) {
		busy += Number(shop.busy);
		orders += shop.orders.length;
		waitingOnYou += shop.waitingOnYou;
	}
	return { busy, orders, shops: shops.length, waitingOnYou };
}

/** The shop an order belongs to. */
export function shopForThread(
	shops: MarketShop[],
	threadId: string | null
): MarketShop | undefined {
	if (!threadId) {
		return undefined;
	}
	return shops.find((shop) =>
		shop.orders.some((order) => order.thread.id === threadId)
	);
}

/**
 * Who a new order can go to: the shopkeepers, or at the general store (and
 * at a shop with nobody behind the counter) every agent, shopkeepers first.
 */
export function orderRecipients(
	shop: MarketShop,
	snapshot: InterfaceSnapshot
): InterfaceAgent[] {
	if (shop.kind !== "general" && shop.agents.length > 0) {
		return shop.agents;
	}
	const keepers = new Set(shop.agents.map((agent) => agent.id));
	return [
		...shop.agents,
		...snapshot.agents.filter((agent) => !keepers.has(agent.id)),
	];
}

/**
 * Where an order's agent usually works, when that is not `shop`: the general
 * store takes conversations from agents who keep a stall or shop elsewhere,
 * so their slips say where they are visiting from. Null for the shop's own
 * shopkeepers and for agents in no group.
 */
export function visitingFrom(
	order: MarketOrder,
	shop: MarketShop,
	snapshot: InterfaceSnapshot
): string | null {
	const agentId = order.agent?.id;
	if (!agentId || shop.agents.some((agent) => agent.id === agentId)) {
		return null;
	}
	const home = snapshot.groups.find((group) =>
		group.memberAgentIds.includes(agentId)
	);
	return home ? home.name : null;
}

/** The port input for an order the user typed and placed at a shop. */
export function newOrderInput(
	shop: MarketShop,
	agentId: string | undefined,
	prompt: string
): Parameters<InterfacePort["startThread"]>[0] {
	const input: Parameters<InterfacePort["startThread"]>[0] = { prompt };
	if (agentId) {
		input.agentId = agentId;
	}
	if (shop.kind === "shop" && shop.groupId) {
		input.projectId = shop.groupId;
	} else if (shop.kind === "stall" && shop.groupId) {
		input.teamId = shop.groupId;
	}
	return input;
}

export interface OrderSection {
	orders: MarketOrder[];
	status: ThreadStatus;
}

/** Orders grouped by status, most urgent group first, empty groups dropped. */
export function orderSections(orders: MarketOrder[]): OrderSection[] {
	const sections: OrderSection[] = [];
	for (const status of THREAD_STATUS_ORDER) {
		const matching = orders.filter((order) => order.status === status);
		if (matching.length > 0) {
			sections.push({ orders: matching, status });
		}
	}
	return sections;
}

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

export function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export const SHOP_KIND_LABELS: Record<MarketShopKind, string> = {
	general: "General store",
	shop: "Project shop",
	stall: "Team stall",
};

/** "Order title" with a fallback for blank titles. */
export function orderTitle(thread: InterfaceThread | undefined): string {
	if (!thread) {
		return "New order";
	}
	return thread.title.trim() || "Untitled order";
}

/** What a shop is in words: its kind, or its keepers for the general store. */
export function shopKindText(shop: MarketShop): string {
	return shop.name === SHOP_KIND_LABELS[shop.kind]
		? plural(shop.agents.length, "shopkeeper")
		: SHOP_KIND_LABELS[shop.kind];
}

/** A shop's door sign: from its keepers' acts when known, else its orders. */
export function shopState(shop: MarketShop): string {
	return shop.sign ?? (shop.busy ? "Busy" : "Open");
}

/**
 * A shop's accessible name, as its sign plate and list button read it.
 * With the act layer, `needYou` (its keepers' blocking asks) stands in for
 * the orders-based "waiting on you" count.
 */
export function shopLabel(shop: MarketShop, needYou?: number): string {
	const parts = [
		shop.name,
		SHOP_KIND_LABELS[shop.kind],
		shopState(shop).toLowerCase(),
		plural(shop.orders.length, "order"),
	];
	if (needYou !== undefined) {
		if (needYou > 0) {
			parts.push(`${needYou} need you`);
		}
	} else if (shop.waitingOnYou > 0) {
		parts.push(`${shop.waitingOnYou} waiting on you`);
	}
	return parts.join(", ");
}
