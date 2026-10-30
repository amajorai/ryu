import {
	askBubble,
	type InterfaceAgent,
	type InterfaceAgentAct,
	type InterfaceEvent,
	type InterfaceSnapshot,
	type InterfaceThread,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import { blockerEntries } from "./game3d-acts.ts";

export {
	CARD_ORIGIN_Y,
	type CardFaceMetrics,
	type CardPose,
	COMPACT_EMPTY_SEAT_HALF,
	COMPACT_PLATE_HALF,
	cardFaceMetrics,
	cardIndexRect,
	EMPTY_SEAT_HALF,
	LABEL_RESERVE,
	LARGE_CARD_FROM,
	PLATE_HALF,
	type Point,
	type Rect,
	SEAT_ANGLES,
	SMALL_CARD_BELOW,
	type StageSize,
	type TableGeometry,
	tableGeometry,
} from "./card-table-model-geometry.ts";
export {
	boxAround,
	EMPTY_HAND_BOTTOM,
	EMPTY_PANEL_HEIGHT,
	emptyHandRect,
	emptyPanelRect,
	exposedWidth,
	fanOverhang,
	type HandLayout,
	HOVER_LIFT,
	handLayout,
	handPose,
	handTop,
	jitter,
	LIFTED_TILT,
	NEIGHBOUR_PART,
	poseBounds,
	poseCorners,
	rectsOverlap,
} from "./card-table-model-hand.ts";

/** Seats around the felt. More agents than this sit on the rail. */
export const MAX_SEATS = 6;
/** More cards than this stop reading as a hand; the most urgent are dealt. */
export const MAX_HAND = 8;

/** A status's suit, so the hand reads at a glance even without color. */
export const STATUS_SUIT: Record<ThreadStatus, string> = {
	attention: "♦",
	quiet: "♢",
	waiting: "♥",
	working: "♣",
	"your-turn": "♠",
};

export interface SeatInfo {
	agent: InterfaceAgent;
	/** Threads where the agent holds the action: live runs and unanswered messages. */
	agentTurn: number;
	attention: number;
	/** Newest activity across the agent's threads (ms since epoch, 0 for none). */
	lastActivity: number;
	running: InterfaceThread[];
	/** Threads with the agent, most urgent first, then newest. */
	threads: InterfaceThread[];
	yourTurn: number;
}

/** The seat's single strongest signal, for its avatar ring. */
export type SeatTone = "attention" | "idle" | "working" | "your-turn";

export function seatTone(seat: SeatInfo): SeatTone {
	if (seat.agent.status === "working" || seat.running.length > 0) {
		return "working";
	}
	if (seat.attention > 0) {
		return "attention";
	}
	if (seat.yourTurn > 0) {
		return "your-turn";
	}
	return "idle";
}

function time(iso: string): number {
	const value = Date.parse(iso);
	return Number.isNaN(value) ? 0 : value;
}

function byRecency(a: InterfaceThread, b: InterfaceThread): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

/** Most urgent status first, then newest. */
export function byUrgency(a: InterfaceThread, b: InterfaceThread): number {
	return (
		THREAD_STATUS_ORDER.indexOf(threadStatus(a)) -
			THREAD_STATUS_ORDER.indexOf(threadStatus(b)) || byRecency(a, b)
	);
}

function seatFor(agent: InterfaceAgent, threads: InterfaceThread[]): SeatInfo {
	const mine = threads.filter((thread) => thread.agentIds.includes(agent.id));
	let agentTurn = 0;
	let attention = 0;
	let yourTurn = 0;
	let lastActivity = 0;
	const running: InterfaceThread[] = [];
	for (const thread of mine) {
		const status = threadStatus(thread);
		if (status === "working") {
			running.push(thread);
			agentTurn += 1;
		} else if (status === "waiting") {
			agentTurn += 1;
		} else if (status === "attention") {
			attention += 1;
		} else if (status === "your-turn") {
			yourTurn += 1;
		}
		lastActivity = Math.max(lastActivity, time(thread.updatedAt));
	}
	return {
		agent,
		agentTurn,
		attention,
		lastActivity,
		running: running.sort(byRecency),
		threads: mine.sort(byUrgency),
		yourTurn,
	};
}

/**
 * Who sits where: working agents first, then most recent activity, then name.
 * The first {@link MAX_SEATS} take the chairs; the rest wait on the rail.
 */
export function seatAgents(snapshot: InterfaceSnapshot): {
	rail: SeatInfo[];
	seated: SeatInfo[];
} {
	const seats = snapshot.agents.map((agent) =>
		seatFor(agent, snapshot.threads)
	);
	seats.sort(
		(a, b) =>
			Number(seatTone(b) === "working") - Number(seatTone(a) === "working") ||
			b.lastActivity - a.lastActivity ||
			a.agent.name.localeCompare(b.agent.name) ||
			a.agent.id.localeCompare(b.agent.id)
	);
	return { rail: seats.slice(MAX_SEATS), seated: seats.slice(0, MAX_SEATS) };
}

/**
 * Who sits where with the act layer: `stageAgents` order (the most urgent
 * acts get the chairs, never the working-first sort), so a failure or an
 * ask is never pushed onto the rail by a busy agent. `onStage` and
 * `offStage` are agent ids in that order.
 */
export function seatByActs(
	snapshot: InterfaceSnapshot,
	onStage: readonly string[],
	offStage: readonly string[]
): { rail: SeatInfo[]; seated: SeatInfo[] } {
	const seat = (id: string) => {
		const agent = snapshot.agents.find((item) => item.id === id);
		return agent ? [seatFor(agent, snapshot.threads)] : [];
	};
	return {
		rail: offStage.flatMap(seat),
		seated: onStage.slice(0, MAX_SEATS).flatMap(seat),
	};
}

/**
 * Your hand: every thread waiting on you, failures first, then the ones where
 * an agent replied, newest first within each. At most {@link MAX_HAND} are
 * dealt; `held` counts the rest.
 */
export function dealHand(snapshot: InterfaceSnapshot): {
	cards: InterfaceThread[];
	held: number;
	/** The threads past {@link MAX_HAND}, in the same order. */
	heldThreads: InterfaceThread[];
} {
	const waitingOnYou = snapshot.threads
		.filter((thread) => {
			const status = threadStatus(thread);
			return status === "attention" || status === "your-turn";
		})
		.sort(byUrgency);
	const heldThreads = waitingOnYou.slice(MAX_HAND);
	return {
		cards: waitingOnYou.slice(0, MAX_HAND),
		held: heldThreads.length,
		heldThreads,
	};
}

/** The pot: every live run, newest first. */
export function potThreads(snapshot: InterfaceSnapshot): InterfaceThread[] {
	return snapshot.threads.filter((thread) => thread.running).sort(byRecency);
}

// ---------------------------------------------------------------------------
// The act layer: what the table says when the snapshot carries acts
// ---------------------------------------------------------------------------

/** A counted failure that is a real failed run (not interrupted, not a limit). */
function failedRun(kind: string): boolean {
	return kind !== "interrupted" && kind !== "rate-limited";
}

/**
 * A seat's ring with the act layer, from its act alone: a counted failed
 * run shows whatever the act (a working agent's failure is never hidden),
 * then an ask or an answer for you, then work.
 */
export function actSeatTone(act: InterfaceAgentAct): SeatTone {
	if (act.blockers.some((blocker) => failedRun(blocker.kind))) {
		return "attention";
	}
	if (act.act === "asking" || act.act === "delivering") {
		return "your-turn";
	}
	return act.act === "working" ? "working" : "idle";
}

/** How one thread's card reads with the act layer. */
export interface CardVerdict {
	/** True when `since` is only estimated: its age reads "~14m". */
	approx: boolean;
	/**
	 * The ask's head ("Run deploy.sh?", `askBubble` of the act's carried
	 * ask), the card's message line in place of the thread's last message;
	 * null for a card with no ask.
	 */
	head: string | null;
	/** In your hand: an ask on it, or a counted stopped run. */
	inHand: boolean;
	/** The footer's words; null lets the suit speak. */
	label: string | null;
	/** Since when it waits: the ask's `since` or the blocker's `at`. */
	since: string | null;
	/** The suit and tone the card wears. */
	status: ThreadStatus;
}

/**
 * Every thread's card from the acts, never from its own run state: a
 * counted failed run is a red "Failed run"; an interrupted run or a limit
 * is a quiet "Interrupted" / "Limit hit"; a failure too old to count is a
 * quiet "Older failure" and leaves your hand; a thread with an ask is your
 * turn; a thread an agent works on is working. Ages come from the ask or
 * the failure, never from `updatedAt`.
 */
export function actCardVerdicts(
	snapshot: InterfaceSnapshot,
	acts: ReadonlyMap<string, InterfaceAgentAct>
): Map<string, CardVerdict> {
	const verdicts = new Map<string, CardVerdict>();
	for (const thread of snapshot.threads) {
		const status = threadStatus(thread);
		const old = status === "attention" || thread.blocker;
		verdicts.set(thread.id, {
			approx: old ? thread.blocker?.atApprox === true : false,
			head: null,
			inHand: false,
			label: old && thread.blocker ? "Older failure" : null,
			since: old ? (thread.blocker?.at ?? null) : null,
			status: old || status === "your-turn" ? "quiet" : status,
		});
	}
	for (const act of acts.values()) {
		if (act.threadId && act.act === "working") {
			verdicts.set(act.threadId, {
				approx: false,
				head: null,
				inHand: false,
				label: null,
				since: null,
				status: "working",
			});
		} else if (act.threadId && act.act === "limited") {
			verdicts.set(act.threadId, {
				approx: false,
				head: null,
				inHand: false,
				label: "Sitting out",
				since: null,
				status: "quiet",
			});
		}
	}
	const privacy = snapshot.privacy ?? "full";
	for (const ask of snapshot.asks ?? []) {
		if (ask.threadId) {
			const known = verdicts.get(ask.threadId);
			const kept = known?.inHand === true;
			verdicts.set(ask.threadId, {
				approx: kept ? known.approx : ask.sinceApprox === true,
				head: kept ? known.head : askBubble(ask, privacy),
				inHand: true,
				label: null,
				since: kept ? known.since : (ask.since ?? null),
				status: "your-turn",
			});
		}
	}
	// An asking agent's card reads the ask its act carries.
	for (const act of acts.values()) {
		const carried = act.ask;
		const verdict = carried?.threadId
			? verdicts.get(carried.threadId)
			: undefined;
		if (carried?.threadId && verdict) {
			verdicts.set(carried.threadId, {
				...verdict,
				approx: carried.sinceApprox === true,
				head: askBubble(carried, privacy),
				since: carried.since ?? verdict.since,
			});
		}
	}
	for (const entry of blockerEntries(snapshot, acts)) {
		const { kind } = entry.blocker;
		let label = "Failed run";
		if (kind === "interrupted") {
			label = "Interrupted";
		} else if (kind === "rate-limited") {
			label = "Limit hit";
		}
		verdicts.set(entry.threadId, {
			approx: entry.blocker.atApprox === true,
			head: null,
			inHand: true,
			label,
			since: entry.blocker.at ?? null,
			status: failedRun(kind) ? "attention" : "quiet",
		});
	}
	return verdicts;
}

/** Your hand with the act layer: failed runs, then stops, then asks; newest first. */
export function dealActHand(
	snapshot: InterfaceSnapshot,
	verdicts: ReadonlyMap<string, CardVerdict>
): ReturnType<typeof dealHand> {
	const rank = (thread: InterfaceThread) => {
		const verdict = verdicts.get(thread.id);
		if (verdict?.status === "attention") {
			return 0;
		}
		return verdict?.status === "quiet" ? 1 : 2;
	};
	const waiting = snapshot.threads
		.filter((thread) => verdicts.get(thread.id)?.inHand)
		.sort(
			(a, b) =>
				rank(a) - rank(b) ||
				time(verdicts.get(b.id)?.since ?? "") -
					time(verdicts.get(a.id)?.since ?? "") ||
				a.id.localeCompare(b.id)
		);
	const heldThreads = waiting.slice(MAX_HAND);
	return {
		cards: waiting.slice(0, MAX_HAND),
		held: heldThreads.length,
		heldThreads,
	};
}

/** The pot with the act layer: the threads the working agents are on. */
export function actPotThreads(
	snapshot: InterfaceSnapshot,
	acts: ReadonlyMap<string, InterfaceAgentAct>
): InterfaceThread[] {
	const working = new Set(
		[...acts.values()].flatMap((act) =>
			act.act === "working" && act.threadId ? [act.threadId] : []
		)
	);
	return snapshot.threads
		.filter((thread) => working.has(thread.id))
		.sort(byRecency);
}

/** Threads with no agent at all, so the rail can still reach them. */
export function unseatedThreads(
	snapshot: InterfaceSnapshot
): InterfaceThread[] {
	const known = new Set(snapshot.agents.map((agent) => agent.id));
	return snapshot.threads
		.filter((thread) => !thread.agentIds.some((id) => known.has(id)))
		.sort(byUrgency);
}

/** The next scheduled run, for the dealer's line on the felt. */
export function nextDeal(
	events: readonly InterfaceEvent[] | undefined,
	now: number
): InterfaceEvent | undefined {
	let next: InterfaceEvent | undefined;
	for (const event of events ?? []) {
		const start = time(event.start);
		if (
			event.kind === "upcoming" &&
			start >= now &&
			(next === undefined || start < time(next.start))
		) {
			next = event;
		}
	}
	return next;
}

/** "in 45m", "in 3h", "in 2d": how long until a scheduled run. */
export function untilLabel(iso: string, now: number): string {
	const minutes = Math.max(0, Math.round((time(iso) - now) / 60_000));
	if (minutes < 1) {
		return "now";
	}
	if (minutes < 60) {
		return `in ${minutes}m`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 24) {
		return `in ${hours}h`;
	}
	return `in ${Math.round(hours / 24)}d`;
}

/** The card's rank: the lead agent's initial, or a dash for nobody. */
export function cardRank(agentName: string | undefined): string {
	const letter = agentName?.trim().charAt(0).toUpperCase();
	return letter || "–";
}

/** Chips in a seat's stack: one per thread, capped so the stack stays a stack. */
export const MAX_STACK_CHIPS = 7;

export function stackChips(threadCount: number): number {
	return Math.min(MAX_STACK_CHIPS, Math.max(0, threadCount));
}

export function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}
