import {
	askBubble,
	blockerKindWord,
	type ClockOptions,
	clockLabel,
	compareAsks,
	type InterfaceAct,
	type InterfaceActivityKind,
	type InterfaceAgentAct,
	type InterfaceAsk,
	type InterfaceBlocker,
	type InterfaceSnapshot,
	type InterfaceThread,
	isSuggestion,
	waitBand,
} from "@ryuhq/protocol/interfaces";
import { ACT_ART } from "./game3d-acts-palette.ts";
import {
	ambientLife,
	LIFE_FACE_CAMERA,
	type LifeAction,
	type LifeBubble,
	type LifeItem,
	type LifePaths,
	type LifePlace,
	type LifeScript,
	type LifeStep,
	placeAt,
} from "./game3d-life.ts";
import type { Vec3 } from "./game3d-palette.ts";
import { CRAMPED_STAGE } from "./game3d-plates.ts";
import type { VillagerTool } from "./game3d-villager.tsx";

/**
 * The act layer: turns each agent's `InterfaceAgentAct` (from the
 * protocol's `agentActs`) into what the kit draws, with no WebGL, so every
 * game shares one vocabulary and it is unit-tested once.
 *
 * - `actLife`: the villager's `LifeScript` for its act (walk to the
 *   you-spot with the ask, deliver to the tray, work at the station...).
 * - `stageAgents`: who gets a station when a game has fewer than agents.
 * - `youSpotSlots`: which ask waits in which you-spot slot, carried by a
 *   villager or pinned as a notice, and how many overflow.
 * - `actorTarget`: the same placement for non-villager actors.
 * - `actTotals` / `actSummaryLine`: the HUD summary.
 * - `actAnnouncement`: the polite live-region sentence for new asks,
 *   new failures and asks about to expire.
 * - `toolForActivity`, `overlayBudget`, `actOverlays`.
 *
 * Words only ever come from the protocol helpers (`askBubble`, the act's
 * bubble, blocker titles) on a snapshot the host already redacted.
 */

/** The you-spot queue points every scene declares in its `LifePaths`. */
export type YouSlot = "you-1" | "you-2" | "you-3" | "you-4";
export const YOU_SLOTS: readonly YouSlot[] = [
	"you-1",
	"you-2",
	"you-3",
	"you-4",
];
/** The you-spot itself (asking villagers without a slot wait here). */
export const YOU_SPOT = "you";
/** Where deliverables are set down. */
export const YOU_TRAY = "you-tray";

/** Where one agent's act plays out. */
export interface ActSpots {
	/** The scene's waypoints, holding "you", "you-1".."you-4" and "you-tray". */
	paths: LifePaths;
	/** Where a limited agent rests (a bench, the coffee corner); default station. */
	rest?: LifePlace;
	/** This agent's you-spot slot (from `youSpotSlots`) while it asks. */
	slot?: YouSlot | null;
	/** This agent's station: where it works, stops and idles. */
	station: LifePlace;
	/** Facing at the station (default: the camera). */
	stationFacing?: number;
}

/** A game's look for the act items. */
export interface ActSkin {
	/**
	 * What an asking villager carries for its ask instead of the letter or
	 * scroll (a clue card, a ticket). Its accent turns to the letter's
	 * destructive accent when a choice is destructive.
	 */
	askItem?: LifeItem;
	/** The pose a downed (red-blocked) agent ends in (default "slump"; "kneel"). */
	blockedPose?: LifeAction;
	/** The game's produce for a deliverable (crate, plate, parcel...). */
	deliverable: LifeItem;
	/** Overrides for what the ask letter's seal looks like. */
	letter?: { accent: string; color?: string; destructiveAccent: string };
	/** The pose an idle agent holds at its station (default "idle"). */
	rest?: LifeAction;
}

/** How long a work bubble stays up before fading to the plate. */
export const WORK_BUBBLE_SECONDS = 6;
/** How long a done or waiting bubble stays up. */
export const SHORT_BUBBLE_SECONDS = 2.5;

/** The step a working act is on: its activity kind, or stalled. */
function stepOf(act: InterfaceAgentAct): string {
	if (act.act !== "working") {
		return act.carry ?? "";
	}
	return act.stalled ? "stalled" : (act.carry ?? "");
}

/**
 * The life script key: changes only when the act, its thread, its ask,
 * its step (activity kind) or its you-spot slot changes, so a ticking
 * timer or a new bubble word never restarts the walk. The slot is part of
 * the key so that when a slot frees, the villagers behind it get a new
 * script and step forward (spec 4.1 item 1); `spots.slot` is the only
 * thing that moves them.
 */
export function actKey(act: InterfaceAgentAct, spots: ActSpots): string {
	const slot = act.act === "asking" ? (spots.slot ?? YOU_SPOT) : "";
	return `${act.act}:${act.threadId ?? ""}:${act.ask?.id ?? ""}:${stepOf(act)}:${slot}`;
}

/** A villager bubble for an act's bubble (the text is already short). */
export function actBubble(act: InterfaceAgentAct): LifeBubble | null {
	const bubble = act.bubble;
	if (!bubble?.text) {
		return null;
	}
	switch (bubble.tone) {
		case "ask":
			return { icon: "alert", label: bubble.text, tone: "ask" };
		case "error":
			return { icon: "cross", label: bubble.text, tone: "bad" };
		case "limit":
			return { label: bubble.text, tone: "warn" };
		case "done":
			return { icon: "check", label: bubble.text, tone: "good" };
		case "work":
			return {
				icon: "dots",
				label: bubble.text,
				partial: bubble.partial,
				tone: "plain",
			};
		default:
			return { label: bubble.text, tone: "plain" };
	}
}

const DEFAULT_LETTER = {
	accent: ACT_ART.sealAmber,
	destructiveAccent: ACT_ART.sealRed,
};

/** What an asking villager carries: a letter, a scroll, or nothing. */
export function askItem(
	act: InterfaceAgentAct,
	skin: ActSkin
): LifeItem | null {
	if (act.carry !== "question" && act.carry !== "approval") {
		return null;
	}
	const letter = skin.letter ?? DEFAULT_LETTER;
	const destructive = act.ask?.choices?.some((choice) => choice.destructive);
	if (skin.askItem) {
		return {
			...skin.askItem,
			accent: destructive
				? letter.destructiveAccent
				: (skin.askItem.accent ?? letter.accent),
		};
	}
	if (act.carry === "question") {
		return { shape: "scroll" };
	}
	return {
		accent: destructive ? letter.destructiveAccent : letter.accent,
		color: skin.letter?.color,
		shape: "letter",
	};
}

/** What a working villager holds in both hands for its step, if anything. */
function workItem(kind: string | null): LifeItem | null {
	if (kind === "run") {
		return { shape: "tablet" };
	}
	if (kind === "plan") {
		return { shape: "laptop" };
	}
	return null;
}

/** Blocker kinds drawn as a red alarm (smoke and a slump). */
export function isRedBlocker(blocker: InterfaceBlocker | undefined): boolean {
	return (
		blocker !== undefined &&
		blocker.kind !== "interrupted" &&
		blocker.kind !== "rate-limited" &&
		blocker.kind !== "schedule-failed"
	);
}

function atStation(
	spots: ActSpots,
	place: LifePlace = spots.station
): LifeStep[] {
	return [
		{ do: "goTo", to: place },
		{ do: "face", toward: spots.stationFacing ?? LIFE_FACE_CAMERA },
	];
}

/**
 * The villager's script for its act. Asking: carry the ask to its slot,
 * face the camera, show the ask. Working: the tool at the station, a work
 * bubble that fades after 6 s (none under `reduced`, none when stalled).
 * Blocked / limited: at the station (the alarm or limit plate carries the
 * words, so no bubble). Delivering: set the produce down at the tray and
 * walk back. Waiting / idle: at the station with a subtle idle loop.
 */
export function actLife(
	act: InterfaceAgentAct,
	spots: ActSpots,
	skin: ActSkin,
	{ reduced }: { reduced: boolean }
): LifeScript {
	const key = actKey(act, spots);
	const bubble = actBubble(act);
	const rest = skin.rest ?? "idle";
	const clear: LifeStep = { bubble: null, do: "say" };
	switch (act.act) {
		case "asking": {
			const steps: LifeStep[] = [
				clear,
				{ do: "carry", item: askItem(act, skin) },
				{ do: "goTo", to: spots.slot ?? YOU_SPOT },
				{ do: "face", toward: LIFE_FACE_CAMERA },
				{ action: act.carry === null ? "wave" : "idle", do: "pose" },
			];
			if (bubble) {
				steps.push({ bubble, do: "say" });
			}
			return {
				idle: [
					{ do: "wait", seconds: 4 },
					{ action: "look", do: "pose" },
					{ do: "wait", seconds: 1.6 },
					{ action: act.carry === null ? "wave" : "idle", do: "pose" },
				],
				key,
				steps,
			};
		}
		case "working": {
			const steps: LifeStep[] = [
				clear,
				{ do: "carry", item: workItem(act.stalled ? null : act.carry) },
				...atStation(spots),
				{ action: act.stalled ? "idle" : "work", do: "pose" },
			];
			if (bubble && !reduced && !act.stalled) {
				steps.push({ bubble, do: "say", seconds: WORK_BUBBLE_SECONDS });
			}
			return { idle: [{ do: "wait", seconds: 5 }], key, steps };
		}
		case "blocked": {
			const red = isRedBlocker(act.blockers[0]);
			const steps: LifeStep[] = [
				clear,
				{ do: "carry", item: null },
				...atStation(spots),
			];
			if (red) {
				steps.push(
					{ action: "stumble", do: "pose" },
					{ do: "effect", effect: "smoke" },
					{ action: skin.blockedPose ?? "slump", do: "pose" }
				);
				return {
					idle: [
						{ do: "wait", seconds: 4 },
						{ do: "effect", effect: "smoke" },
					],
					key,
					steps,
				};
			}
			steps.push({ action: "look", do: "pose" });
			return { idle: [{ do: "wait", seconds: 5 }], key, steps };
		}
		case "limited":
			return {
				idle: [
					{ do: "wait", seconds: 5 },
					{ action: "sip", do: "pose" },
					{ do: "wait", seconds: 2.2 },
					{ action: "idle", do: "pose" },
				],
				key,
				steps: [
					clear,
					{ do: "carry", item: null },
					...atStation(spots, spots.rest ?? spots.station),
					{ action: "idle", do: "pose" },
				],
			};
		case "delivering": {
			const steps: LifeStep[] = [
				clear,
				{ do: "carry", item: skin.deliverable },
				{ do: "goTo", to: YOU_TRAY },
				{ do: "face", toward: LIFE_FACE_CAMERA },
				{ do: "carry", item: null },
				{ do: "effect", effect: "sparkle" },
			];
			if (bubble) {
				steps.push({ bubble, do: "say", seconds: SHORT_BUBBLE_SECONDS });
			}
			steps.push({ do: "wait", seconds: 1 }, ...atStation(spots), {
				action: rest,
				do: "pose",
			});
			return { idle: ambientLife(act.agentId, { rest }), key, steps };
		}
		case "waiting": {
			const steps: LifeStep[] = [
				clear,
				{ do: "carry", item: null },
				...atStation(spots),
				{ action: "look", do: "pose" },
			];
			if (bubble) {
				steps.push({ bubble, do: "say", seconds: WORK_BUBBLE_SECONDS });
			}
			return { idle: [{ do: "wait", seconds: 5 }], key, steps };
		}
		default:
			return {
				idle: ambientLife(act.agentId, { rest }),
				key,
				steps: [
					clear,
					{ do: "carry", item: null },
					...atStation(spots),
					{ action: rest, do: "pose" },
				],
			};
	}
}

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

/**
 * "3 need you · 2 working · 1 failed · 1 limited" (+ " · 1 stalled?").
 * Zero terms are left out; all zero reads "Nothing running", never "all
 * clear" (a host may have blind spots).
 */
export function actSummaryLine(totals: ActTotals): string {
	const terms: string[] = [];
	if (totals.needYou > 0) {
		terms.push(`${totals.needYou} need you`);
	}
	if (totals.working > 0) {
		terms.push(`${totals.working} working`);
	}
	if (totals.failed > 0) {
		terms.push(`${totals.failed} failed`);
	}
	if (totals.limited > 0) {
		terms.push(`${totals.limited} limited`);
	}
	if (totals.stalled > 0) {
		terms.push(`${totals.stalled} stalled?`);
	}
	return terms.length > 0 ? terms.join(" · ") : "Nothing running";
}

/** What the announcer has already said. */
export interface AnnounceState {
	/** Blocking ask ids already seen. */
	asks: Set<string>;
	/** Thread ids with a counted blocker already announced. */
	blockerThreads: Set<string>;
	/** Ask ids already announced (or first seen) as expiring. */
	expiring: Set<string>;
}

const MAX_CLAUSES = 3;

/** One counted blocker, with the thread it stopped and its agent. */
export interface BlockerEntry {
	agentId: string;
	agentName: string;
	blocker: InterfaceBlocker;
	threadId: string;
}

function atMs(blocker: InterfaceBlocker): number {
	return blocker.at ? Date.parse(blocker.at) : Number.NEGATIVE_INFINITY;
}

/**
 * Every counted blocker of every agent (on stage or not) with its thread,
 * newest `at` first (unknown times last): the "runs stopped" group and the
 * blocker card's lookups.
 */
export function blockerEntries(
	snapshot: Pick<InterfaceSnapshot, "threads">,
	acts: ReadonlyMap<string, InterfaceAgentAct>
): BlockerEntry[] {
	const entries: BlockerEntry[] = [];
	const used = new Set<string>();
	for (const act of acts.values()) {
		for (const blocker of act.blockers) {
			const thread =
				snapshot.threads.find(
					(item) => item.blocker === blocker && !used.has(item.id)
				) ??
				snapshot.threads.find(
					(item) =>
						!used.has(item.id) &&
						item.blocker &&
						item.agentIds.includes(act.agentId) &&
						item.blocker.kind === blocker.kind &&
						item.blocker.title === blocker.title &&
						(item.blocker.at ?? null) === (blocker.at ?? null)
				);
			if (!thread) {
				continue;
			}
			used.add(thread.id);
			entries.push({
				agentId: act.agentId,
				agentName: act.agentName,
				blocker,
				threadId: thread.id,
			});
		}
	}
	return entries.sort((a, b) => {
		const order = atMs(b.blocker) - atMs(a.blocker);
		if (order !== 0 && !Number.isNaN(order)) {
			return order;
		}
		return a.threadId < b.threadId ? -1 : 1;
	});
}

/** Two blockers say the same thing (kind, title, time, source, clearsAt). */
function sameBlocker(a: InterfaceBlocker, b: InterfaceBlocker): boolean {
	return (
		a.kind === b.kind &&
		a.title === b.title &&
		(a.at ?? null) === (b.at ?? null) &&
		(a.source ?? null) === (b.source ?? null) &&
		(a.clearsAt ?? null) === (b.clearsAt ?? null)
	);
}

/**
 * Whether `thread`'s blocker is one of `act`'s counted blockers, by value:
 * snapshot objects must never be compared by identity across renders (an
 * act and a thread can come from different snapshots). With `claims`
 * (`threadClaims(snapshot)`), the thread must also be the agent's own.
 */
export function actHasBlocker(
	act: Pick<InterfaceAgentAct, "agentId" | "blockers">,
	thread: Pick<InterfaceThread, "blocker" | "id">,
	claims?: ReadonlyMap<string, string>
): boolean {
	const blocker = thread.blocker;
	if (!blocker) {
		return false;
	}
	if (claims && claims.get(thread.id) !== act.agentId) {
		return false;
	}
	return act.blockers.some(
		(item) => item === blocker || sameBlocker(item, blocker)
	);
}

/** Every counted blocker's thread that is not running again. */
export function countedBlockerThreads(
	snapshot: Pick<InterfaceSnapshot, "threads">,
	acts: ReadonlyMap<string, InterfaceAgentAct>
): Map<string, { agentName: string; blocker: InterfaceBlocker }> {
	const found = new Map<
		string,
		{ agentName: string; blocker: InterfaceBlocker }
	>();
	for (const entry of blockerEntries(snapshot, acts)) {
		const thread = snapshot.threads.find((item) => item.id === entry.threadId);
		if (thread && !thread.running) {
			found.set(entry.threadId, {
				agentName: entry.agentName,
				blocker: entry.blocker,
			});
		}
	}
	return found;
}

/** Who an ask belongs to, by name ("Inbox" when no agent owns it). */
function askOwnerName(
	ask: InterfaceAsk,
	acts: ReadonlyMap<string, InterfaceAgentAct>
): string {
	for (const act of acts.values()) {
		if (
			act.ask?.id === ask.id ||
			act.parkedAsks.some((item) => item.id === ask.id)
		) {
			return act.agentName;
		}
	}
	if (ask.agentId) {
		const owner = acts.get(ask.agentId);
		if (owner) {
			return owner.agentName;
		}
	}
	return "Inbox";
}

/**
 * The act announcement for this snapshot (or tick): one polite sentence
 * of what is new since `prev`, in order: new blocking asks, threads that
 * newly stopped, and asks that just entered their last 2 minutes. At most
 * 3 clauses joined by "; " plus "+N more". Silent on the first call
 * (`prev` null). A blocker is keyed by its thread, so a richer re-read of
 * the same failure is not announced again; a thread that runs again is
 * forgotten, so its next failure is. Suggestions and replies never speak.
 */
export function actAnnouncement(
	prev: AnnounceState | null,
	acts: ReadonlyMap<string, InterfaceAgentAct>,
	unowned: readonly InterfaceAsk[],
	snapshot: Pick<InterfaceSnapshot, "asks" | "threads">,
	nowMs: number,
	privacy: "full" | "redacted" = "full"
): { sentence: string | null; state: AnnounceState } {
	const blocking = (snapshot.asks ?? []).filter((ask) => ask.blocking);
	for (const ask of unowned) {
		if (ask.blocking && !blocking.some((item) => item.id === ask.id)) {
			blocking.push(ask);
		}
	}
	blocking.sort(compareAsks);
	const stopped = countedBlockerThreads(snapshot, acts);
	const expiringNow = (ask: InterfaceAsk) =>
		waitBand(
			ask.since ? Date.parse(ask.since) : null,
			nowMs,
			ask.expiresAt ? Date.parse(ask.expiresAt) : null
		) === "expiring";
	const state: AnnounceState = {
		asks: new Set(blocking.map((ask) => ask.id)),
		blockerThreads: new Set(stopped.keys()),
		expiring: new Set(),
	};
	const clauses: string[] = [];
	const expiring: string[] = [];
	for (const ask of blocking) {
		const seen = prev?.asks.has(ask.id) ?? true;
		const wasExpiring = prev?.expiring.has(ask.id) ?? false;
		if (expiringNow(ask) || wasExpiring) {
			state.expiring.add(ask.id);
		}
		if (prev === null) {
			continue;
		}
		const name = askOwnerName(ask, acts);
		if (!seen) {
			clauses.push(`${name} asks: ${askBubble(ask, privacy)}`);
		} else if (expiringNow(ask) && !wasExpiring) {
			expiring.push(`${name}'s ask expires soon`);
		}
	}
	if (prev !== null) {
		for (const [threadId, { agentName, blocker }] of stopped) {
			if (!prev.blockerThreads.has(threadId)) {
				const words =
					privacy === "redacted"
						? blockerKindWord(blocker.kind)
						: blocker.title;
				clauses.push(`${agentName}: ${words}`);
			}
		}
	}
	clauses.push(...expiring);
	if (clauses.length === 0) {
		return { sentence: null, state };
	}
	const shown = clauses.slice(0, MAX_CLAUSES);
	const more = clauses.length - shown.length;
	return {
		sentence:
			more > 0 ? `${shown.join("; ")}; +${more} more` : shown.join("; "),
		state,
	};
}

/** The kit's tool for each step kind; a game overrides any of them. */
const ACTIVITY_TOOLS: Record<InterfaceActivityKind, VillagerTool | undefined> =
	{
		answer: "quill",
		ask: undefined,
		delegate: "clipboard",
		edit: "quill",
		plan: "clipboard",
		read: "book",
		run: "wrench",
		search: "lens",
		think: "book",
		tool: "wrench",
		web: "globe",
		write: "quill",
	};

/** The tool a working villager holds for its step kind. */
export function toolForActivity(
	kind: InterfaceActivityKind | string | null | undefined,
	gameDefaults: Partial<Record<InterfaceActivityKind, VillagerTool>> = {}
): VillagerTool | undefined {
	if (!(kind && kind in ACTIVITY_TOOLS)) {
		return undefined;
	}
	const activity = kind as InterfaceActivityKind;
	return gameDefaults[activity] ?? ACTIVITY_TOOLS[activity];
}

/** A status text overlay competing for the budget. */
export interface BudgetItem {
	/** Within work bubbles: the focus agent's goes first. */
	focus?: boolean;
	id: string;
	kind: "ask-bubble" | "limit" | "tally" | "text" | "work-bubble";
}

/** How many status overlays a stage may draw, and how plates collapse. */
export interface OverlayBudget {
	/** Ask bubbles allowed for queued villagers (none on narrow stages). */
	askBubbles: number;
	/** Budgeted status overlays allowed in all. */
	cap: number;
	/**
	 * The stage is short (a thread view squeezes it): the budget halves again
	 * and board "Next:" lines go first.
	 */
	cramped: boolean;
	/** Picks the overlays to draw, in the fill order, up to the caps. */
	fill: (items: readonly BudgetItem[]) => Set<string>;
	/** Exempt props are DOM keyboard targets (pass as their `focusable`). */
	focusable: boolean;
	/** Exempt plates (other than queue plates) collapse to a glyph. */
	iconOnly: boolean;
	narrow: boolean;
}

/** Below this stage width plates go icon-only and the budget halves. */
export const NARROW_STAGE = 640;
/** Below this stage height the budget halves again ("Next:" lines first). */
export { CRAMPED_STAGE };

const KIND_ORDER: BudgetItem["kind"][] = [
	"tally",
	"limit",
	"ask-bubble",
	"work-bubble",
	"text",
];
const KIND_CAP: Record<BudgetItem["kind"], number> = {
	"ask-bubble": 4,
	limit: 2,
	tally: 2,
	text: Number.POSITIVE_INFINITY,
	"work-bubble": Number.POSITIVE_INFINITY,
};

/**
 * The overlay budget for a stage `width` px wide. Focus and pointer
 * targets (plates, alarm and notice plates, queue plates, tray, marks,
 * notes) are exempt and never dropped; on narrow stages all but the queue
 * plates collapse to `iconOnly`, and with `domTargets` they are also the
 * keyboard targets (`focusable`). Status text
 * overlays are capped at 16 (8 narrow), filled tallies, limit plates, ask
 * bubbles (none narrow), work bubbles (focus first), then other text.
 * With the stage's measured `height` (`useStageSize`), a stage shorter
 * than CRAMPED_STAGE (squeezed beside a thread view) halves the cap again
 * and fills board "Next:" lines last, so they go first. Without it, as
 * before.
 */
export function overlayBudget(
	width: number,
	{ domTargets, height }: { domTargets: boolean; height?: number }
): OverlayBudget {
	const narrow = width < NARROW_STAGE;
	const cramped = height !== undefined && height > 0 && height < CRAMPED_STAGE;
	const cap = (narrow ? 8 : 16) / (cramped ? 2 : 1);
	const askBubbles = narrow ? 0 : KIND_CAP["ask-bubble"];
	return {
		askBubbles,
		cap,
		fill: (items) => {
			const chosen = new Set<string>();
			for (const kind of KIND_ORDER) {
				const limit = kind === "ask-bubble" ? askBubbles : KIND_CAP[kind];
				const group = items
					.filter((item) => item.kind === kind)
					.sort(
						(a, b) =>
							Number(Boolean(b.focus)) - Number(Boolean(a.focus)) ||
							(cramped ? nextLast(a) - nextLast(b) : 0)
					);
				let taken = 0;
				for (const item of group) {
					if (chosen.size >= cap || taken >= limit) {
						break;
					}
					chosen.add(item.id);
					taken += 1;
				}
			}
			return chosen;
		},
		cramped,
		focusable: domTargets,
		iconOnly: narrow,
		narrow,
	};
}

/** 1 for a board "Next:" line (dropped first on a cramped stage), else 0. */
function nextLast(item: BudgetItem): number {
	return item.id.startsWith("next:") ? 1 : 0;
}

/**
 * The status text overlays an act stage would draw, for `overlayBudget`,
 * with ids a game looks up when it draws them:
 * - `tally:you`, `tally:off`: the you-spot and off-stage tallies;
 * - `limit:<agent>`: limit plates;
 * - `ask:<ask>`: ask bubbles of queued villagers;
 * - `work:<agent>` (none under reduced motion, where `actLife` scripts no
 *   work bubble), `done:<agent>`, `wait:<agent>`: the other bubbles;
 * - `progress:`, `next:`, `elapsed:`, `cue:` (longer than usual or
 *   stalled) and `count:<agent>` (the tray sticker): station text.
 * Hide a villager's bubble with `VillagerSpec.bubble: false` when its id
 * is not chosen; the life script stays the same.
 */
export function actOverlays(
	onStage: readonly InterfaceAgentAct[],
	slots: { overflow: number; slots: readonly YouSpotSlot[] },
	offStage: Pick<OffStage, "count">,
	focusAgentId: string | null = null,
	{ reduced = false }: { reduced?: boolean } = {}
): BudgetItem[] {
	const items: BudgetItem[] = [];
	if (slots.overflow > 0) {
		items.push({ id: "tally:you", kind: "tally" });
	}
	if (offStage.count > 0) {
		items.push({ id: "tally:off", kind: "tally" });
	}
	for (const act of onStage) {
		if (act.act === "limited") {
			items.push({ id: `limit:${act.agentId}`, kind: "limit" });
		}
	}
	for (const slot of slots.slots) {
		if (slot.carrier === "villager") {
			items.push({ id: `ask:${slot.ask.id}`, kind: "ask-bubble" });
		}
	}
	for (const act of onStage) {
		const focus = act.agentId === focusAgentId;
		if (act.act === "working" && act.bubble && !act.stalled && !reduced) {
			items.push({ focus, id: `work:${act.agentId}`, kind: "work-bubble" });
		}
		if (act.act === "delivering" && act.bubble) {
			items.push({ focus, id: `done:${act.agentId}`, kind: "work-bubble" });
		}
		if (act.act === "waiting" && act.bubble) {
			items.push({ focus, id: `wait:${act.agentId}`, kind: "work-bubble" });
		}
		if (act.progress) {
			items.push({ id: `progress:${act.agentId}`, kind: "text" });
		}
		if (act.next) {
			items.push({ id: `next:${act.agentId}`, kind: "text" });
		}
		if (act.elapsed) {
			items.push({ id: `elapsed:${act.agentId}`, kind: "text" });
		}
		if (act.stalled || act.longerThanUsual) {
			items.push({ id: `cue:${act.agentId}`, kind: "text" });
		}
		if (act.act === "delivering") {
			items.push({ id: `count:${act.agentId}`, kind: "text" });
		}
	}
	return items;
}

/** The budget id of a villager's bubble for its act, or null for none. */
export function bubbleOverlayId(act: InterfaceAgentAct): string | null {
	switch (act.act) {
		case "asking":
			return act.ask ? `ask:${act.ask.id}` : null;
		case "working":
			return `work:${act.agentId}`;
		case "delivering":
			return `done:${act.agentId}`;
		case "waiting":
			return `wait:${act.agentId}`;
		default:
			return null;
	}
}

/** A world point for a waypoint id or point (station lookups for props). */
export function spotPoint(paths: LifePaths, place: LifePlace): Vec3 | null {
	return placeAt(place, paths);
}
