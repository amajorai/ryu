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

/** Seats around the felt. More agents than this sit on the rail. */
export const MAX_SEATS = 6;
/** More cards than this stop reading as a hand; the most urgent are dealt. */
export const MAX_HAND = 8;

/**
 * Where each seat sits on the table's oval, in degrees clockwise from the top.
 * The bottom of the table is yours (the hand is dealt there), so seats come in
 * three mirrored pairs and fill top pair first, then the sides, then the
 * bottom corners: the busiest agents always get the most visible chairs.
 */
export const SEAT_ANGLES: readonly number[] = [-35, 35, -86, 86, -128, 128];
/** Side chairs pull in over the rail a little so they never leave the stage. */
const SEAT_REACH: readonly number[] = [1, 1, 0.94, 0.94, 0.98, 0.98];
/** How far toward the pot each seat's chips sit (side chairs reach in less). */
const CHIP_REACH: readonly number[] = [0.6, 0.6, 0.48, 0.48, 0.56, 0.56];

/** Half a full seat plate (w-[200px], about 60px tall). */
export const PLATE_HALF = { height: 36, width: 120 } as const;
/** Half a compact plate (a face over a name). */
export const COMPACT_PLATE_HALF = { height: 32, width: 34 } as const;
/** Half an empty chair (w-36 h-12, or a 48px circle when compact). */
export const EMPTY_SEAT_HALF = { height: 24, width: 72 } as const;
export const COMPACT_EMPTY_SEAT_HALF = { height: 24, width: 24 } as const;
/** A full plate keeps at least this much stage on its outer side. */
const PLATE_EDGE = 28;
/** Half the chip group in front of a full seat: hole cards, a gap, a stack. */
const CHIP_GROUP_HALF = { height: 30, width: 42 } as const;
/** The status line hung under a full plate. */
const STATUS_LINE = 24;
/** Air between a plate (and its status line) and its own chips. */
const CHIP_GAP = 14;

/**
 * Pulls a seat's chips toward the pot until they clear the seat's plate and
 * the status line under it, so a stage narrowed by the drawer never lays the
 * hole cards against the plate.
 */
function clearChips(seat: Point, chip: Point, center: Point): Point {
	const above = PLATE_HALF.height + CHIP_GROUP_HALF.height + CHIP_GAP;
	const below = above + STATUS_LINE;
	const reachX = PLATE_HALF.width + CHIP_GROUP_HALF.width + CHIP_GAP;
	let scale = 1;
	let point = chip;
	while (scale > 0.2) {
		point = {
			x: center.x + (chip.x - center.x) * scale,
			y: center.y + (chip.y - center.y) * scale,
		};
		const dx = Math.abs(point.x - seat.x);
		const dy = point.y - seat.y;
		const clearY = dy >= 0 ? dy >= below : -dy >= above;
		if (dx >= reachX || clearY) {
			return point;
		}
		scale -= 0.04;
	}
	return point;
}

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

// ---------------------------------------------------------------------------
// Geometry: everything is laid out in one stage coordinate space (CSS px)
// ---------------------------------------------------------------------------

export interface Point {
	x: number;
	y: number;
}

export interface Rect extends Point {
	height: number;
	width: number;
}

export interface CardPose {
	rotate: number;
	scale: number;
	x: number;
	y: number;
	z: number;
}

export interface TableGeometry {
	card: { height: number; width: number };
	/** The chip stack in front of each seat, toward the pot. */
	chips: Point[];
	/** Seat plates shrink to a face and a name on narrow stages. */
	compact: boolean;
	/** Where cards are dealt from (the middle of the felt). */
	dealer: Point;
	felt: Rect;
	/**
	 * How far the hand is raised off the stage's bottom edge. A stage taller
	 * than the table needs splits its spare height above and below the table
	 * and the hand together, so the group sits centred instead of the felt
	 * floating over a hand pinned to the bottom.
	 */
	handLift: number;
	seats: Point[];
}

export interface StageSize {
	height: number;
	width: number;
}

/** A playing card's 5:7 proportion. */
const CARD_RATIO = 1.4;
/** The oval's width over its height. */
const FELT_RATIO = 1.9;
const MIN_FELT_RATIO = 1.28;
const COMPACT_FELT_RATIO = 0.8;
const MAX_FELT_WIDTH = 1040;
const COMPACT_BELOW = 760;
/** Space kept under the hand, which also absorbs the fan's droop. */
const HAND_MARGIN = 56;
/** The share of a tall stage's spare height that goes under the hand. */
const LIFT_SHARE = 0.5;
const COMPACT_LIFT_SHARE = 0.6;
/** Room the hand's label and key hints need beside the fan, gap included. */
export const LABEL_RESERVE = 224;
/** Space kept clear between the fan and the stage edge when there is no label. */
const FAN_EDGE = 28;
const COMPACT_FAN_EDGE = 16;
/** No card, lifted or parted, ever crosses closer than this to a stage edge. */
const CARD_CLAMP = 6;
/** Cards tilt around a point this far down their height (CSS `50% 135%`). */
export const CARD_ORIGIN_Y = 1.35;
/** Room kept between the bottom chairs and the top of the hand. */
const HAND_CLEARANCE = 10;
/**
 * A compact table has no room beside the fan for the hand's label, so it sits
 * over the fan; the felt stops this much higher to keep the bottom chairs
 * clear of it.
 */
const COMPACT_LABEL_ROOM = 46;
/**
 * The share of a card each card shows past the next one. Below
 * {@link READABLE_SPREAD} a title stops fitting in the visible strip, so the
 * label gives up its room first and then fewer cards are dealt.
 */
const READABLE_SPREAD = 0.8;
const MAX_SPREAD = 0.88;

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function tableGeometry(stage: StageSize): TableGeometry {
	const { height, width } = stage;
	const compact = width < COMPACT_BELOW;
	const cardWidth = Math.round(
		clamp(Math.min(width * 0.135, height * (compact ? 0.155 : 0.185)), 84, 152)
	);
	const cardHeight = Math.round(cardWidth * CARD_RATIO);
	// Room for the seat plates that hang off the rim.
	const sidePad = compact ? 40 : 96;
	const topPad = compact ? 64 : 50;
	// The hand is held just over the bottom rail, the way cards sit at a table.
	const feltBottom =
		height -
		cardHeight -
		HAND_MARGIN +
		cardHeight * 0.16 -
		HAND_CLEARANCE -
		(compact ? COMPACT_LABEL_ROOM : 0);
	const band = Math.max(80, feltBottom - topPad);
	const feltWidth = Math.max(
		160,
		Math.min(width - sidePad * 2, band * FELT_RATIO, MAX_FELT_WIDTH)
	);
	// A narrow stage gets a rounder oval, so the felt still fills the height.
	// A phone gets a portrait oval, so the table is not a coin in a tall void.
	const feltHeight = Math.max(
		feltWidth / FELT_RATIO,
		Math.min(band, feltWidth / (compact ? COMPACT_FELT_RATIO : MIN_FELT_RATIO))
	);
	// Spare height is shared above the table and below the hand; the felt
	// keeps its place just over the hand, so the hand stays at its rail.
	const spare = Math.max(0, band - feltHeight);
	const handLift = spare * (compact ? COMPACT_LIFT_SHARE : LIFT_SHARE);
	const felt: Rect = {
		height: feltHeight,
		width: feltWidth,
		x: (width - feltWidth) / 2,
		y: topPad + spare - handLift,
	};
	const cx = felt.x + felt.width / 2;
	const cy = felt.y + felt.height / 2;
	const rx = felt.width / 2;
	const ry = felt.height / 2;
	const seats: Point[] = [];
	const chips: Point[] = [];
	const center = { x: cx, y: cy };
	const plateReach = PLATE_HALF.width + PLATE_EDGE;
	for (const [slot, angle] of SEAT_ANGLES.entries()) {
		const radians = (angle * Math.PI) / 180;
		const sin = Math.sin(radians);
		const cos = Math.cos(radians);
		const reach = SEAT_REACH[slot] ?? 1;
		let seatX = cx + rx * reach * sin;
		if (!compact && width > plateReach * 2) {
			// A full plate keeps its distance from the stage (and drawer) edge.
			seatX = clamp(seatX, plateReach, width - plateReach);
		}
		const seat = { x: seatX, y: cy - ry * reach * cos };
		seats.push(seat);
		const chipReach = CHIP_REACH[slot] ?? 0.55;
		const chip = { x: cx + rx * chipReach * sin, y: cy - ry * 0.52 * cos };
		chips.push(compact ? chip : clearChips(seat, chip, center));
	}
	return {
		card: { height: cardHeight, width: cardWidth },
		chips,
		compact,
		dealer: { x: cx, y: cy },
		felt,
		handLift,
		seats,
	};
}

/** Under this width a card uses its small face: smaller corner and text. */
export const SMALL_CARD_BELOW = 100;
/** From this width (a card picked up out of a deck) the face reads larger. */
export const LARGE_CARD_FROM = 196;

/**
 * Where a card face's parts sit, in px from its top-left corner. The corner
 * index stacks the rank over the suit; the agent's name and the age sit
 * beside them, one per glyph row; the title starts on its own row under the
 * whole index, so it never runs under the suit and every card in the fan
 * starts its title at the same left edge.
 */
export interface CardFaceMetrics {
	/** Gap between the rank and the suit (and the name and age rows). */
	gap: number;
	/** Rank and suit glyph size, and the height of each row beside them. */
	glyph: number;
	/** Where the meta rows beside the index start. */
	gutter: number;
	/** The index column's distance from the card's top and start edges. */
	indexInset: number;
	/** The index column's width. */
	indexWidth: number;
	/** A picked-up card: larger corner, title and message. */
	large: boolean;
	small: boolean;
	/** Horizontal padding of the title and message. */
	textInset: number;
	/** Where the title's first line starts. */
	titleTop: number;
}

export function cardFaceMetrics(cardWidth: number): CardFaceMetrics {
	if (cardWidth < SMALL_CARD_BELOW) {
		return {
			gap: 2,
			glyph: 12,
			gutter: 22,
			indexInset: 5,
			indexWidth: 14,
			large: false,
			small: true,
			textInset: 8,
			titleTop: 36,
		};
	}
	if (cardWidth >= LARGE_CARD_FROM) {
		return {
			gap: 4,
			glyph: 18,
			gutter: 34,
			indexInset: 10,
			indexWidth: 20,
			large: true,
			small: false,
			textInset: 14,
			titleTop: 62,
		};
	}
	return {
		gap: 3,
		glyph: 15,
		gutter: 28,
		indexInset: 6,
		indexWidth: 18,
		large: false,
		small: false,
		textInset: 10,
		titleTop: 44,
	};
}

/** The corner index's box on the card face: the rank over the suit. */
export function cardIndexRect(metrics: CardFaceMetrics): Rect {
	return {
		height: metrics.glyph * 2 + metrics.gap,
		width: metrics.indexWidth,
		x: metrics.indexInset,
		y: metrics.indexInset,
	};
}

/** The tilt of one card step and of the whole fan. */
const MAX_STEP_DEGREES = 4;
const MAX_FAN_DEGREES = 22;
/** How far the lifted card rises, and how far its neighbours part. */
export const HOVER_LIFT = 30;
export const NEIGHBOUR_PART = 0.24;
/** The share of its fan tilt a lifted card keeps. */
export const LIFTED_TILT = 0.55;

export interface HandLayout {
	/** How many cards are dealt; the rest are held back (counted, not drawn). */
	dealt: number;
	/** True when the label and key hints sit beside the fan, left of it. */
	labelBeside: boolean;
	/** Horizontal step from one card to the next. */
	spread: number;
}

/**
 * How the hand fans out on this stage. Each card shows at least
 * {@link READABLE_SPREAD} of its width past the next, so every title stays
 * whole: when the fan is too wide, the label beside it moves above the fan,
 * and if that is still not enough, fewer cards are dealt.
 */
export function handLayout(
	count: number,
	geometry: TableGeometry,
	stage: StageSize
): HandLayout {
	const cardWidth = geometry.card.width;
	const readable = cardWidth * READABLE_SPREAD;
	const widest = cardWidth * MAX_SPREAD;
	// The outer cards tilt, so their corners reach past their unrotated box:
	// that overhang is budgeted on both sides along with the edge reserve.
	const fanRoom = (reserve: number, dealt: number) =>
		Math.max(
			0,
			Math.min(
				stage.width -
					cardWidth -
					(reserve + fanOverhang(dealt, geometry.card)) * 2,
				geometry.felt.width * 0.9
			)
		);
	if (count <= 1) {
		return {
			dealt: count,
			labelBeside:
				!geometry.compact && stage.width - cardWidth - LABEL_RESERVE * 2 >= 0,
			spread: 0,
		};
	}
	const besideRoom = geometry.compact ? 0 : fanRoom(LABEL_RESERVE, count);
	if (besideRoom / (count - 1) >= readable) {
		return {
			dealt: count,
			labelBeside: true,
			spread: Math.min(widest, besideRoom / (count - 1)),
		};
	}
	const edge = geometry.compact ? COMPACT_FAN_EDGE : FAN_EDGE;
	for (let dealt = count; dealt > 1; dealt -= 1) {
		const room = fanRoom(edge, dealt);
		if (room / (dealt - 1) >= readable) {
			return {
				dealt,
				labelBeside: false,
				spread: Math.min(widest, room / (dealt - 1)),
			};
		}
	}
	return { dealt: 1, labelBeside: false, spread: 0 };
}

/** The tilt of the outermost card in a fan of `count`. */
function outerTilt(count: number): number {
	const gaps = Math.max(count - 1, 1);
	const step =
		count > 1 ? Math.min(MAX_STEP_DEGREES, MAX_FAN_DEGREES / gaps) : 0;
	return ((count - 1) / 2) * step;
}

/** How far the outer card's tilted corner reaches past its unrotated box. */
export function fanOverhang(
	count: number,
	card: { height: number; width: number }
): number {
	if (count <= 1) {
		return 0;
	}
	const bounds = poseBounds(
		{ rotate: outerTilt(count), scale: 1, x: 0, y: 0, z: 0 },
		card
	);
	return Math.max(0, bounds.x + bounds.width - card.width);
}

/**
 * A posed card's four corners on the stage (top-left, top-right,
 * bottom-right, bottom-left), after its scale and tilt around
 * {@link CARD_ORIGIN_Y}.
 */
export function poseCorners(
	pose: CardPose,
	card: { height: number; width: number }
): Point[] {
	const originX = card.width / 2;
	const originY = card.height * CARD_ORIGIN_Y;
	const radians = (pose.rotate * Math.PI) / 180;
	const cos = Math.cos(radians);
	const sin = Math.sin(radians);
	const local: [number, number][] = [
		[0, 0],
		[card.width, 0],
		[card.width, card.height],
		[0, card.height],
	];
	return local.map(([px, py]) => {
		const dx = (px - originX) * pose.scale;
		const dy = (py - originY) * pose.scale;
		return {
			x: pose.x + originX + dx * cos - dy * sin,
			y: pose.y + originY + dx * sin + dy * cos,
		};
	});
}

/** The on-stage box a posed card covers, tilt and scale included. */
export function poseBounds(
	pose: CardPose,
	card: { height: number; width: number }
): Rect {
	const corners = poseCorners(pose, card);
	const xs = corners.map((corner) => corner.x);
	const ys = corners.map((corner) => corner.y);
	const left = Math.min(...xs);
	const top = Math.min(...ys);
	return {
		height: Math.max(...ys) - top,
		width: Math.max(...xs) - left,
		x: left,
		y: top,
	};
}

/**
 * How much of a card's face shows past the card dealt over it: the step to
 * the next card, or the whole card for the last one.
 */
export function exposedWidth(
	index: number,
	count: number,
	layout: HandLayout,
	cardWidth: number
): number {
	return index >= count - 1 ? cardWidth : Math.min(layout.spread, cardWidth);
}

/**
 * One card's resting pose in the fan, as the top-left offset of an unrotated
 * card plus a tilt around a point below it, so the hand arcs like one held.
 * `lifted` is the card under the pointer or focus: it rises and straightens,
 * and the two cards either side of it part to show it. `spread` comes from
 * {@link handLayout}; it is worked out from `count` when left out.
 */
export function handPose({
	count,
	geometry,
	index,
	lifted,
	spread: givenSpread,
	stage,
}: {
	count: number;
	geometry: TableGeometry;
	index: number;
	lifted: number | null;
	spread?: number;
	stage: StageSize;
}): CardPose {
	const { height: cardHeight, width: cardWidth } = geometry.card;
	const gaps = Math.max(count - 1, 1);
	const spread =
		count > 1 ? (givenSpread ?? handLayout(count, geometry, stage).spread) : 0;
	const step =
		count > 1 ? Math.min(MAX_STEP_DEGREES, MAX_FAN_DEGREES / gaps) : 0;
	const offset = index - (count - 1) / 2;
	const outer = (count - 1) / 2;
	const arc = Math.min(3, 14 / Math.max(outer ** 2, 1));
	// Lift the whole hand by the outer cards' droop so every card shows whole.
	const droop =
		outer ** 2 * arc +
		(cardWidth / 2) * Math.sin((outer * step * Math.PI) / 180);
	const rest =
		stage.height -
		cardHeight -
		HAND_MARGIN +
		14 -
		droop * 0.6 -
		geometry.handLift;

	let x = stage.width / 2 - cardWidth / 2 + offset * spread;
	let y = rest + offset * offset * arc;
	let rotate = offset * step;
	let scale = 1;
	let z = index + 1;

	if (lifted !== null) {
		const distance = index - lifted;
		if (distance === 0) {
			y -= HOVER_LIFT;
			// It keeps part of its tilt, so the hand still reads as a fan.
			rotate *= LIFTED_TILT;
			scale = 1.04;
			z = 100;
		} else if (Math.abs(distance) <= 2) {
			x +=
				(Math.sign(distance) * cardWidth * NEIGHBOUR_PART) / Math.abs(distance);
		}
	}
	// A parted outer card (or a lifted one at the end of a tight fan) stops at
	// the stage edge instead of sliding off it.
	const bounds = poseBounds({ rotate, scale, x, y, z }, geometry.card);
	if (bounds.x < CARD_CLAMP) {
		x += CARD_CLAMP - bounds.x;
	} else if (bounds.x + bounds.width > stage.width - CARD_CLAMP) {
		x -= bounds.x + bounds.width - (stage.width - CARD_CLAMP);
	}
	return { rotate, scale, x, y, z };
}

/** The top of the fan's middle card at rest, for a caption over the hand. */
export function handTop(
	count: number,
	geometry: TableGeometry,
	stage: StageSize,
	spread: number
): number {
	const middle = Math.floor(Math.max(count - 1, 0) / 2);
	return handPose({
		count,
		geometry,
		index: middle,
		lifted: null,
		spread,
		stage,
	}).y;
}

/** Where the empty hand's dashed outline sits: centred, just over the bottom. */
export const EMPTY_HAND_BOTTOM = 28;

export function emptyHandRect(geometry: TableGeometry, stage: StageSize): Rect {
	const width = Math.round(geometry.card.width * 1.6);
	const height = geometry.card.height;
	return {
		height,
		width,
		x: (stage.width - width) / 2,
		y: stage.height - EMPTY_HAND_BOTTOM - height - geometry.handLift,
	};
}

/** The "nobody is at the table" panel: at most this wide, about this tall. */
const EMPTY_PANEL_MAX_WIDTH = 288;
export const EMPTY_PANEL_HEIGHT = 176;
const EMPTY_PANEL_GAP = 12;

/**
 * The empty table's welcome panel, centred on the felt and narrowed so it
 * stays clear of the open chairs beside it.
 */
export function emptyPanelRect(geometry: TableGeometry): Rect {
	const { dealer } = geometry;
	const half = geometry.compact ? COMPACT_EMPTY_SEAT_HALF : EMPTY_SEAT_HALF;
	let width = Math.min(EMPTY_PANEL_MAX_WIDTH, geometry.felt.width - 32);
	for (const seat of geometry.seats) {
		const level =
			Math.abs(seat.y - dealer.y) < EMPTY_PANEL_HEIGHT / 2 + half.height;
		if (level) {
			const room = Math.abs(seat.x - dealer.x) - half.width - EMPTY_PANEL_GAP;
			width = Math.min(width, room * 2);
		}
	}
	return {
		height: EMPTY_PANEL_HEIGHT,
		width,
		x: dealer.x - width / 2,
		y: dealer.y - EMPTY_PANEL_HEIGHT / 2,
	};
}

/** A box of the given half size centred on a point. */
export function boxAround(
	point: Point,
	half: { height: number; width: number }
): Rect {
	return {
		height: half.height * 2,
		width: half.width * 2,
		x: point.x - half.width,
		y: point.y - half.height,
	};
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
	return (
		a.x < b.x + b.width &&
		b.x < a.x + a.width &&
		a.y < b.y + b.height &&
		b.y < a.y + a.height
	);
}

/**
 * A stable value in `[-1, 1]` for an id, so a chip or card always lands at the
 * same skew instead of twitching on every render.
 */
export function jitter(id: string, salt: number): number {
	let hash = 2_166_136_261 ^ salt;
	for (const char of id) {
		hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16_777_619);
	}
	return ((hash >>> 0) % 2001) / 1000 - 1;
}
