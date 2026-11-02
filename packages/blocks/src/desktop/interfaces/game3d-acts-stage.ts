import {
	type ClockOptions,
	clockLabel,
	compareAsks,
	type InterfaceAct,
	type InterfaceAgentAct,
	type InterfaceAsk,
	type InterfaceSnapshot,
	isSuggestion,
} from "@ryuhq/protocol/interfaces";
import {
	type ActSpots,
	YOU_SLOTS,
	YOU_SPOT,
	YOU_TRAY,
	type YouSlot,
} from "./game3d-acts.ts";
import { type LifePlace, placeAt } from "./game3d-life.ts";

/** Where acts happen on a stage: actor targets, who is on stage, you-spots and totals. */

/** Where a non-villager actor (creature, probe, car, card) goes for its act. */
export function actorTarget(
	act: InterfaceAgentAct,
	spots: ActSpots,
	still = false
): { phase: "settled" | "travel"; position: [number, number, number] } {
	const point = (place: LifePlace): [number, number, number] => {
		const at =
			placeAt(place, spots.paths) ?? placeAt(spots.station, spots.paths);
		return at ? [at[0], at[1], at[2]] : [0, 0, 0];
	};
	let place: LifePlace = spots.station;
	if (act.act === "asking") {
		place = spots.slot ?? YOU_SPOT;
	} else if (act.act === "delivering" && !still) {
		place = YOU_TRAY;
	} else if (act.act === "limited") {
		place = spots.rest ?? spots.station;
	}
	const away = place !== spots.station && place !== spots.rest;
	return {
		phase: still || !away ? "settled" : "travel",
		position: point(place),
	};
}

/** Stage order: the most urgent acts get stations first. */
const STAGE_ORDER: Record<InterfaceAct, number> = {
	asking: 0,
	blocked: 1,
	limited: 2,
	working: 3,
	delivering: 4,
	waiting: 5,
	idle: 6,
};

function blockingAsksOf(act: InterfaceAgentAct): number {
	return (act.ask?.blocking ? 1 : 0) + act.parkedAsks.length;
}

function byName(a: InterfaceAgentAct, b: InterfaceAgentAct): number {
	if (a.agentName !== b.agentName) {
		return a.agentName < b.agentName ? -1 : 1;
	}
	if (a.agentId === b.agentId) {
		return 0;
	}
	return a.agentId < b.agentId ? -1 : 1;
}

/** Who is off stage: how many, by act, and their blocking asks. */
export interface OffStage {
	asks: number;
	byAct: Partial<Record<InterfaceAct, number>>;
	count: number;
}

/**
 * Which agents get a station when a game has `capacity` of them:
 * urgency first (asking > blocked > limited > working > delivering >
 * waiting > idle); asking agents by their carried ask, the rest by name.
 * `pinned` agents (a user's picks) sort first within their own act only,
 * so a pick never displaces a more urgent agent.
 */
/** An agent's next scheduled run: its projected start and how it reads. */
export interface NextRun {
	/** "tomorrow 09:00", "15:10" (`clockLabel`). */
	label: string;
	/** RFC 3339 UTC projected start. */
	start: string;
}

/**
 * The agent's soonest upcoming run from the snapshot's events (the one an
 * act's "Next run ..." words name), or null: never invented. For a game's
 * "upcoming" prop (tomorrow's door).
 */
export function nextRunOf(
	agentId: string,
	snapshot: InterfaceSnapshot,
	nowMs: number,
	clock?: ClockOptions
): NextRun | null {
	let soonest: { ms: number; start: string } | null = null;
	for (const event of snapshot.events ?? []) {
		const ms = Date.parse(event.start);
		if (
			event.kind === "upcoming" &&
			event.agentId === agentId &&
			Number.isFinite(ms) &&
			ms >= nowMs &&
			(soonest === null || ms < soonest.ms)
		) {
			soonest = { ms, start: event.start };
		}
	}
	return soonest
		? { label: clockLabel(soonest.start, nowMs, clock), start: soonest.start }
		: null;
}

export function stageAgents(
	acts: ReadonlyMap<string, InterfaceAgentAct>,
	capacity: number,
	pinned: readonly string[] = []
): { offStage: OffStage; onStage: InterfaceAgentAct[] } {
	const picks = new Set(pinned);
	const ordered = [...acts.values()].sort((a, b) => {
		const rank = STAGE_ORDER[a.act] - STAGE_ORDER[b.act];
		if (rank !== 0) {
			return rank;
		}
		const pick = Number(picks.has(b.agentId)) - Number(picks.has(a.agentId));
		if (pick !== 0) {
			return pick;
		}
		if (a.act === "asking" && a.ask && b.ask) {
			const order = compareAsks(a.ask, b.ask);
			if (order !== 0) {
				return order;
			}
		}
		return byName(a, b);
	});
	const onStage = ordered.slice(0, Math.max(0, capacity));
	const rest = ordered.slice(onStage.length);
	const offStage: OffStage = { asks: 0, byAct: {}, count: rest.length };
	for (const act of rest) {
		offStage.byAct[act.act] = (offStage.byAct[act.act] ?? 0) + 1;
		offStage.asks += blockingAsksOf(act);
	}
	return { offStage, onStage };
}

/** One ask waiting at the you-spot. */
export interface YouSpotSlot {
	agentId: string | null;
	ask: InterfaceAsk;
	/** A villager carries it, or it is pinned as a notice on a post. */
	carrier: "notice" | "villager";
	point: YouSlot;
}

/**
 * The you-spot queue: every blocking ask that waits there (asks carried by
 * on-stage asking villagers, every parked ask of on-stage agents, and
 * unowned blocking asks), in one `compareAsks` order over you-1..you-4.
 * The rest, plus the off-stage agents' blocking asks, is `overflow` (the
 * "+N more" tally): `slots.length + overflow` is every blocking ask.
 * Pass `onStage` (agent ids) when some agents are off stage.
 */
export function youSpotSlots(
	acts: ReadonlyMap<string, InterfaceAgentAct> | readonly InterfaceAgentAct[],
	unowned: readonly InterfaceAsk[],
	onStage?: Iterable<string>
): { overflow: number; slots: YouSpotSlot[] } {
	const list = Array.isArray(acts)
		? acts
		: [...(acts as ReadonlyMap<string, InterfaceAgentAct>).values()];
	const staged = onStage ? new Set(onStage) : null;
	const waiting: Omit<YouSpotSlot, "point">[] = [];
	let offStage = 0;
	for (const act of list) {
		if (staged && !staged.has(act.agentId)) {
			offStage += blockingAsksOf(act);
			continue;
		}
		if (act.act === "asking" && act.ask?.blocking) {
			waiting.push({ agentId: act.agentId, ask: act.ask, carrier: "villager" });
		}
		for (const ask of act.parkedAsks) {
			waiting.push({ agentId: act.agentId, ask, carrier: "notice" });
		}
	}
	for (const ask of unowned) {
		if (ask.blocking) {
			waiting.push({ agentId: null, ask, carrier: "notice" });
		}
	}
	waiting.sort((a, b) => compareAsks(a.ask, b.ask));
	const slots = waiting.slice(0, YOU_SLOTS.length).map((entry, index) => ({
		...entry,
		point: YOU_SLOTS[index] as YouSlot,
	}));
	return { overflow: waiting.length - slots.length + offStage, slots };
}

/** The slot an agent's carried ask waits in, if any. */
export function slotOf(
	slots: readonly YouSpotSlot[],
	agentId: string
): YouSlot | null {
	return (
		slots.find(
			(slot) => slot.agentId === agentId && slot.carrier === "villager"
		)?.point ?? null
	);
}

/** The HUD summary counts. */
export interface ActTotals {
	failed: number;
	limited: number;
	/** Blocking asks, owned or not, on stage or not. */
	needYou: number;
	/** Blocking asks + counted blockers + suggestions + unread replies. */
	queue: number;
	stalled: number;
	working: number;
}

export function actTotals(
	snapshot: Pick<InterfaceSnapshot, "asks">,
	acts: ReadonlyMap<string, InterfaceAgentAct>
): ActTotals {
	const asks = snapshot.asks ?? [];
	const totals: ActTotals = {
		failed: 0,
		limited: 0,
		needYou: asks.filter((ask) => ask.blocking).length,
		queue: 0,
		stalled: 0,
		working: 0,
	};
	let blockers = 0;
	for (const act of acts.values()) {
		blockers += act.blockers.length;
		if (
			act.blockers.some(
				(blocker) =>
					blocker.kind !== "interrupted" && blocker.kind !== "rate-limited"
			)
		) {
			totals.failed += 1;
		}
		if (act.act === "limited") {
			totals.limited += 1;
		} else if (act.act === "working") {
			if (act.stalled) {
				totals.stalled += 1;
			} else {
				totals.working += 1;
			}
		}
	}
	const suggestions = asks.filter((ask) => isSuggestion(ask)).length;
	const replies = asks.filter((ask) => ask.kind === "reply").length;
	totals.queue = totals.needYou + blockers + suggestions + replies;
	return totals;
}
