import { translate as tr } from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
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

export {
	ACT_EAST_SPACING,
	ACT_KEEPER_SPACING,
	ACT_KEEPER_SPACING_NARROW,
	ACT_MIN_SQUARE,
	ACT_MIN_SQUARE_NARROW,
	FACING_YAW,
	LOT_SIZE,
	layoutMarket,
	type MarketActLayout,
	type MarketFacing,
	type MarketLot,
	type MarketRect,
	type MarketSquare,
	PAVEMENT_DEPTH,
	QUEUE_SHOWN,
	toWorld,
	type Vec3,
} from "./market-model-layout.ts";

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
				name: group.name.trim() || tr("Untitled"),
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
				name: tr("General store"),
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
export const SHOP_KIND_LABELS: Record<MarketShopKind, string> = {
	get general() {
		return tr("General store");
	},
	get shop() {
		return tr("Project shop");
	},
	get stall() {
		return tr("Team stall");
	},
};

/** A shop kind's label in the UI language. */
export function shopKindLabel(
	kind: MarketShopKind,
	tl: LiteralMessage = tr
): string {
	switch (kind) {
		case "general":
			return tl("General store");
		case "shop":
			return tl("Project shop");
		default:
			return tl("Team stall");
	}
}

/** "Order title" with a fallback for blank titles. */
export function orderTitle(
	thread: InterfaceThread | undefined,
	tl: LiteralMessage = tr
): string {
	if (!thread) {
		return tl("New order");
	}
	return thread.title.trim() || tl("Untitled order");
}

/** What a shop is in words: its kind, or its keepers for the general store. */
export function shopKindText(
	shop: MarketShop,
	tl: LiteralMessage = tr
): string {
	return shop.kind === "general"
		? tl("{count, plural, one {# shopkeeper} other {# shopkeepers}}", {
				count: shop.agents.length,
			})
		: shopKindLabel(shop.kind, tl);
}

/** A shop's door sign: from its keepers' acts when known, else its orders. */
export function shopState(shop: MarketShop, tl: LiteralMessage = tr): string {
	return shop.sign ?? (shop.busy ? tl("Busy") : tl("Open"));
}

/** "3 orders", in the UI language. */
export function orderCount(count: number, tl: LiteralMessage = tr): string {
	return tl("{count, plural, one {# order} other {# orders}}", { count });
}

/**
 * A shop's accessible name, as its sign plate and list button read it.
 * With the act layer, `needYou` (its keepers' blocking asks) stands in for
 * the orders-based "waiting on you" count.
 */
export function shopLabel(
	shop: MarketShop,
	needYou?: number,
	tl: LiteralMessage = tr
): string {
	const parts = [
		shop.name,
		shopKindLabel(shop.kind, tl),
		shopState(shop, tl).toLowerCase(),
		orderCount(shop.orders.length, tl),
	];
	if (needYou !== undefined) {
		if (needYou > 0) {
			parts.push(tl("{count} need you", { count: needYou }));
		}
	} else if (shop.waitingOnYou > 0) {
		parts.push(tl("{count} waiting on you", { count: shop.waitingOnYou }));
	}
	return parts.join(", ");
}
