import { translate as tr } from "@ryu/i18n/lite";
import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

export {
	AISLE_COUNT,
	AISLE_LETTERS,
	AISLE_MOUTH_X,
	aisleLabel,
	aisleY,
	BELT_PATH,
	BELT_REST,
	buildPickers,
	EXCEPTION_SLOTS,
	FLOOR,
	type FloorPlacement,
	PACKER_SPOT,
	type Picker,
	type PickerPose,
	type PickerRoute,
	pickerRoute,
	placeOrders,
	RACK,
	READY_SLOTS,
	RECEIVED_SLOTS,
	rackRowY,
	type Slot,
} from "./warehouse-model-floor.ts";

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
	get exception() {
		return tr("Exception");
	},
	get packing() {
		return tr("Packing");
	},
	get parked() {
		return tr("Parked");
	},
	get picking() {
		return tr("Picking");
	},
	get ready() {
		return tr("Ready to ship");
	},
	get received() {
		return tr("Received");
	},
	get shipped() {
		return tr("Shipped");
	},
	get stale() {
		return tr("Old failure");
	},
};

/**
 * A stage's name. With the act layer an exception is a counted stopped run
 * (failed or interrupted, recent or unread), as the Queue's "runs stopped"
 * group counts them, so it reads "Stopped".
 */
export function stageLabel(stage: OrderStage, acts: boolean): string {
	return acts && stage === "exception" ? tr("Stopped") : STAGE_LABELS[stage];
}

/** A tab's name, as `stageLabel` names its stage. */
export function tabLabel(tab: OrderTab, acts: boolean): string {
	if (acts && tab === "exceptions") {
		return tr("Stopped");
	}
	return ORDER_TABS.find((item) => item.id === tab)?.label ?? tab;
}

/** What each stage means in conversation terms (detail view, tooltips). */
export const STAGE_MEANING: Record<OrderStage, string> = {
	get exception() {
		return tr("The last run failed or was interrupted");
	},
	get packing() {
		return tr("The agent is wrapping up a reply");
	},
	get parked() {
		return tr("The agent hit a limit and waits for it to reset");
	},
	get picking() {
		return tr("The agent is working on it");
	},
	get ready() {
		return tr("Your turn: the agent replied or asks you something");
	},
	get received() {
		return tr("You wrote. The agent has not started yet");
	},
	get shipped() {
		return tr("Done. Nothing new since the last reply");
	},
	get stale() {
		return tr("An older run failed; it no longer needs you");
	},
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
	{
		id: "all",
		get label() {
			return tr("All");
		},
	},
	{
		id: "unfulfilled",
		get label() {
			return tr("Unfulfilled");
		},
	},
	{
		id: "ready",
		get label() {
			return tr("Ready to ship");
		},
	},
	{
		id: "exceptions",
		get label() {
			return tr("Exceptions");
		},
	},
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

/** "3 orders", "1 picker", in the UI language. */
export function warehouseCount(
	count: number,
	noun: "open order" | "order" | "picker"
): string {
	switch (noun) {
		case "open order":
			return tr("{count, plural, one {# open order} other {# open orders}}", {
				count,
			});
		case "picker":
			return tr("{count, plural, one {# picker} other {# pickers}}", { count });
		default:
			return tr("{count, plural, one {# order} other {# orders}}", { count });
	}
}
