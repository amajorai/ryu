import {
	compareAsks,
	estimateProgress,
	type InterfaceAgent,
	type InterfaceAgentAct,
	type InterfaceAsk,
	type InterfaceEvent,
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
	medianRunMs,
	type ThreadStatus,
	threadClaims,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { actHasBlocker } from "./game3d-acts.ts";

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

function toTicket(snapshot: InterfaceSnapshot, thread: InterfaceThread) {
	const chefId = thread.agentIds[0];
	const parsed = Date.parse(thread.updatedAt);
	return {
		chef: chefId
			? snapshot.agents.find((agent) => agent.id === chefId)
			: undefined,
		id: thread.id,
		state: TICKET_STATE[threadStatus(thread)],
		thread,
		title: thread.title.trim() || "Untitled order",
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

/**
 * Ticket timer since the last update. Cooking tickets run a live kitchen
 * timer (`m:ss`, then `1:02:05`); every other ticket shows a compact age
 * (`now`, `4m`, `3h`, `2d`, `5w`), so one rail never mixes the two for the
 * same kind of ticket.
 */
export function ticketTimer(
	updatedAt: number,
	now: number,
	live = false
): string {
	if (updatedAt <= 0) {
		return "";
	}
	const seconds = Math.max(0, Math.floor((now - updatedAt) / 1000));
	if (live) {
		const hours = Math.floor(seconds / 3600);
		const minutes = Math.floor((seconds % 3600) / 60);
		const rest = String(seconds % 60).padStart(2, "0");
		return hours > 0
			? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
			: `${minutes}:${rest}`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 1) {
		return "now";
	}
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h`;
	}
	const days = Math.floor(hours / 24);
	return days < 7 ? `${days}d` : `${Math.floor(days / 7)}w`;
}

/** Spoken form of the timer, for accessible names. */
export function spokenAge(updatedAt: number, now: number): string {
	if (updatedAt <= 0) {
		return "no updates yet";
	}
	const minutes = Math.max(0, Math.floor((now - updatedAt) / 60_000));
	if (minutes < 1) {
		return "updated just now";
	}
	if (minutes < 60) {
		return `updated ${plural(minutes, "minute")} ago`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `updated ${plural(hours, "hour")} ago`;
	}
	return `updated ${plural(Math.floor(hours / 24), "day")} ago`;
}

export function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Short duration for the estimate note ("about 6 min"). */
export function roughDuration(ms: number): string {
	const minutes = Math.max(1, Math.round(ms / 60_000));
	if (minutes < 60) {
		return `${minutes} min`;
	}
	const hours = Math.round(minutes / 6) / 10;
	return `${hours} h`;
}

/**
 * Accessible name for a ticket button. With the act layer (`act`) the
 * words come from the act and the only time said is the run's exact
 * elapsed time: a last-update time is never spoken.
 */
export function ticketLabel(
	ticket: KitchenTicket,
	now: number,
	act?: Pick<TicketAct, "elapsed" | "label"> | null
): string {
	const chef = ticket.chef ? `, ${ticket.chef.name}` : ", no chef";
	if (act) {
		const running = act.elapsed ? `, running ${act.elapsed}` : "";
		return `${ticket.title}: ${act.label}${chef}${running}`;
	}
	return `${ticket.title}: ${TICKET_LABELS[ticket.state]}${chef}, ${spokenAge(ticket.updatedAt, now)}`;
}

/** Accessible name for a chef (plate or roster button). */
export function chefLabel(station: KitchenStation): string {
	const parts = [station.agent.name];
	if (station.working) {
		parts.push("cooking");
	}
	const ready = station.orders.filter((order) => order.state === "ready");
	if (ready.length > 0) {
		parts.push(`${ready.length} ready`);
	}
	if (station.burnt) {
		parts.push("burnt order");
	}
	return parts.join(", ");
}

/** Next or previous index in a list, wrapping. */
export function cycleIndex(length: number, index: number, step: number) {
	if (length === 0) {
		return -1;
	}
	return (((index + step) % length) + length) % length;
}

/**
 * What a ticket shows when the host sends asks, from the acts alone: its
 * place on the rail (`rank`: an ask that needs you, a stop or limit, a
 * run, an unread answer), its words and colour, the ask its patience bar
 * drains from (a blocking ask, else an unread answer; never a suggestion),
 * the run's elapsed time (exact starts only) and its estimate (a cron
 * routine's own firing only).
 */
export interface TicketAct {
	ask: InterfaceAsk | null;
	elapsed: string | null;
	estimate: number | null;
	label: string;
	rank: number;
	state: TicketState;
}

/** The rail from the acts: what needs you first, in ask order, then the rest. */
export function actTickets(
	snapshot: InterfaceSnapshot,
	acts: ReadonlyMap<string, InterfaceAgentAct>,
	nowMs: number
): { rail: KitchenTicket[]; views: Map<string, TicketAct> } {
	const claims = threadClaims(snapshot);
	const asks = [...(snapshot.asks ?? [])].sort(compareAsks);
	const views = new Map<string, TicketAct>();
	const tickets: KitchenTicket[] = [];
	for (const thread of snapshot.threads) {
		const act = acts.get(claims.get(thread.id) ?? "");
		const blocking = asks.find(
			(ask) => ask.threadId === thread.id && ask.blocking
		);
		const reply = asks.find(
			(ask) => ask.threadId === thread.id && ask.kind === "reply"
		);
		// By value and claim (the kit's check), never object identity.
		const counted =
			act && actHasBlocker(act, thread, claims) ? thread.blocker : null;
		// A rate limit is not a failure: it reads 86'd, never burnt.
		const limit = counted?.kind === "rate-limited";
		const stopped = limit ? null : counted;
		let view: Omit<TicketAct, "ask" | "elapsed" | "estimate"> | null = null;
		if (blocking) {
			view = { label: "Needs you", rank: 0, state: "needs" };
		} else if (stopped) {
			view = {
				label: stopped.kind === "interrupted" ? "Pulled" : "Burnt",
				rank: 1,
				state: "burnt",
			};
		} else if (
			limit ||
			(act?.act === "limited" && act.threadId === thread.id)
		) {
			view = { label: "86'd", rank: 1, state: "limited" };
		} else if (thread.running) {
			view = { label: "Cooking", rank: 2, state: "cooking" };
		} else if (reply) {
			view = { label: "Ready", rank: 3, state: "ready" };
		}
		if (!view) {
			continue;
		}
		const estimate = estimateProgress(thread, nowMs, snapshot.events);
		views.set(thread.id, {
			...view,
			ask: blocking ?? reply ?? null,
			elapsed:
				act?.act === "working" && act.threadId === thread.id
					? act.elapsed
					: null,
			estimate:
				estimate && estimate.total > 0 ? estimate.done / estimate.total : null,
		});
		tickets.push(toTicket(snapshot, thread));
	}
	const order = (ticket: KitchenTicket) => views.get(ticket.id);
	tickets.sort((a, b) => {
		const left = order(a);
		const right = order(b);
		const rank = (left?.rank ?? 9) - (right?.rank ?? 9);
		if (rank !== 0) {
			return rank;
		}
		if (left?.ask && right?.ask && left.rank === 0) {
			return compareAsks(left.ask, right.ask);
		}
		return compareTickets(a, b);
	});
	return { rail: tickets, views };
}
