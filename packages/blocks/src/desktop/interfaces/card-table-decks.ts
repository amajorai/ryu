import {
	type InterfaceAgent,
	type InterfaceSnapshot,
	type InterfaceThread,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import {
	byUrgency,
	type CardPose,
	jitter,
	type Point,
	type Rect,
	type SeatInfo,
	type StageSize,
	seatAgents,
	seatTone,
} from "./card-table-model.ts";

/**
 * The Cards layout: no table, just the cards on the page. Every agent is a
 * deck of its conversations (urgent ones on top); conversations with no agent
 * form an "Unassigned" deck. A deck fans out into face-up cards when opened
 * and the other decks move aside into a row along the bottom.
 *
 * Everything here is pure: decks, the resting grid, the pile, the fan and
 * the dock are poses in one stage coordinate space (CSS px, the top-left of
 * a card at its size in that place, tilted around its centre).
 */

export const UNASSIGNED_DECK = "unassigned";

export interface Deck {
	/** The agent, or `undefined` for the Unassigned deck. */
	agent: InterfaceAgent | undefined;
	/** Failed runs waiting on you. */
	attention: number;
	/** The agent's id, or {@link UNASSIGNED_DECK}. */
	id: string;
	name: string;
	/** Live runs in the deck. */
	running: number;
	/** The deck's conversations, most urgent first, then newest. */
	threads: InterfaceThread[];
	/** True while the agent works, or any of its threads runs. */
	working: boolean;
	/** Replies waiting on you. */
	yourTurn: number;
}

/** The agent a conversation's card belongs to: its first known agent. */
function deckOwner(
	thread: InterfaceThread,
	known: ReadonlySet<string>
): string | undefined {
	return thread.agentIds.find((id) => known.has(id));
}

function deckFrom(
	id: string,
	agent: InterfaceAgent | undefined,
	name: string,
	threads: InterfaceThread[],
	seat: SeatInfo | undefined
): Deck {
	let attention = 0;
	let yourTurn = 0;
	let running = 0;
	for (const thread of threads) {
		const status = threadStatus(thread);
		if (status === "working") {
			running += 1;
		} else if (status === "attention") {
			attention += 1;
		} else if (status === "your-turn") {
			yourTurn += 1;
		}
	}
	return {
		agent,
		attention,
		id,
		name,
		running,
		threads: threads.sort(byUrgency),
		working: running > 0 || (seat ? seatTone(seat) === "working" : false),
		yourTurn,
	};
}

/**
 * Every deck, in seat order (working agents first, then most recent activity,
 * then name), with the Unassigned deck last when it has cards. A conversation
 * with several agents is one card, in its lead agent's deck, so no card is
 * ever in two decks at once.
 */
export function buildDecks(snapshot: InterfaceSnapshot): Deck[] {
	const known = new Set(snapshot.agents.map((agent) => agent.id));
	const byOwner = new Map<string, InterfaceThread[]>();
	const unassigned: InterfaceThread[] = [];
	for (const thread of snapshot.threads) {
		const owner = deckOwner(thread, known);
		if (owner === undefined) {
			unassigned.push(thread);
			continue;
		}
		const list = byOwner.get(owner);
		if (list) {
			list.push(thread);
		} else {
			byOwner.set(owner, [thread]);
		}
	}
	const { rail, seated } = seatAgents(snapshot);
	const decks = [...seated, ...rail].map((seat) =>
		deckFrom(
			seat.agent.id,
			seat.agent,
			seat.agent.name,
			byOwner.get(seat.agent.id) ?? [],
			seat
		)
	);
	if (unassigned.length > 0) {
		decks.push(
			deckFrom(UNASSIGNED_DECK, undefined, "Unassigned", unassigned, undefined)
		);
	}
	return decks;
}

/** What a deck says about itself, for its button's accessible name. */
export function deckSummary(deck: Deck): string {
	const count = deck.threads.length;
	const parts = [`${count} ${count === 1 ? "card" : "cards"}`];
	if (deck.running > 0) {
		parts.push(`${deck.running} running`);
	}
	if (deck.attention > 0) {
		parts.push(`${deck.attention} failed`);
	}
	if (deck.yourTurn > 0) {
		parts.push(`${deck.yourTurn} for you`);
	}
	return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** A playing card's 5:7 proportion. */
const CARD_RATIO = 1.4;
/** Card widths the resting grid chooses between, largest first. */
const MAX_CARD = 168;
const MIN_CARD = 120;
const PHONE_MIN_CARD = 112;
const CARD_STEP = 4;
/** Below this stage width the grid uses phone gutters and gaps. */
export const PHONE_BELOW = 560;
/** Each card under the top one shows this much more edge than the last. */
export const STACK_EDGE = 7;
/** At most this many edges show under a pile's top card. */
export const MAX_STACK_EDGES = 4;
/** Space between a pile's deepest edge and its label. */
export const LABEL_GAP = 12;
/** A deck label's height: an avatar beside two lines. */
export const LABEL_HEIGHT = 40;
/** With the act layer: room under a deck's label for its act status line. */
export const ACT_STATUS_ROOM = 56;
/** Cards a deck renders at most; the rest are reached from "more". */
export const MAX_DECK_CARDS = 24;

/** The page's side gutter: tighter on a phone. */
export function stageGutter(stage: StageSize): number {
	return stage.width < PHONE_BELOW ? 16 : 32;
}

export interface DeckGrid {
	card: { height: number; width: number };
	/** The full height of the content: more than the stage when it scrolls. */
	contentHeight: number;
	/** Decks per row, for arrow keys moving up and down. */
	perRow: number;
	/** Each deck's pile, in deck order: the top card's resting box. */
	piles: Rect[];
}

/** How far under the top card a pile of `count` cards reaches. */
export function stackDepth(count: number): number {
	return Math.min(MAX_STACK_EDGES, Math.max(0, count - 1)) * STACK_EDGE;
}

/**
 * A deck's footprint at rest: the pile, its deepest edges and its label
 * (and `statusRoom` under it for the act status line).
 */
function slotHeight(card: { height: number }, statusRoom = 0): number {
	return (
		card.height +
		MAX_STACK_EDGES * STACK_EDGE +
		LABEL_GAP +
		LABEL_HEIGHT +
		statusRoom
	);
}

interface GridShape {
	cols: number;
	gapX: number;
	gapY: number;
	gutter: number;
	rows: number;
}

function gridShape(
	count: number,
	cardWidth: number,
	stage: StageSize
): GridShape {
	const phone = stage.width < PHONE_BELOW;
	const gutter = stageGutter(stage);
	const gapX = phone ? 16 : 40;
	const gapY = phone ? 24 : 32;
	const room = Math.max(cardWidth, stage.width - gutter * 2);
	const fit = Math.max(1, Math.floor((room + gapX) / (cardWidth + gapX)));
	const rows = Math.max(1, Math.ceil(count / fit));
	// Balanced rows (4 and 3, not 6 and 1) read as dealt, not as overflow.
	const cols = Math.max(1, Math.ceil(count / rows));
	return { cols, gapX, gapY, gutter, rows };
}

/**
 * The resting grid: the largest card that fits every deck on the stage in
 * balanced, centred rows. When even the smallest card does not fit, the grid
 * keeps that size and the stage scrolls.
 */
export function deckGrid(
	count: number,
	stage: StageSize,
	statusRoom = 0
): DeckGrid {
	const phone = stage.width < PHONE_BELOW;
	const smallest = phone ? PHONE_MIN_CARD : MIN_CARD;
	const largest = phone
		? Math.max(smallest, Math.floor((stage.width - 16 * 2 - 16) / 2))
		: MAX_CARD;
	let width = Math.max(smallest, Math.min(MAX_CARD, largest));
	let shape = gridShape(count, width, stage);
	while (width > smallest) {
		const card = { height: Math.round(width * CARD_RATIO), width };
		const height =
			shape.rows * slotHeight(card, statusRoom) + (shape.rows - 1) * shape.gapY;
		if (height <= stage.height - shape.gutter * 2) {
			break;
		}
		width -= CARD_STEP;
		shape = gridShape(count, width, stage);
	}
	const card = { height: Math.round(width * CARD_RATIO), width };
	const slot = slotHeight(card, statusRoom);
	const gridHeight = shape.rows * slot + (shape.rows - 1) * shape.gapY;
	const contentHeight = Math.max(stage.height, gridHeight + shape.gutter * 2);
	// A short grid sits a little above the middle, where the eye starts.
	const top = Math.max(shape.gutter, (contentHeight - gridHeight) * 0.42);
	const piles: Rect[] = [];
	for (let index = 0; index < count; index += 1) {
		const row = Math.floor(index / shape.cols);
		const inRow = Math.min(shape.cols, count - row * shape.cols);
		const rowWidth = inRow * card.width + (inRow - 1) * shape.gapX;
		const col = index - row * shape.cols;
		piles.push({
			height: card.height,
			width: card.width,
			x: Math.round(
				(stage.width - rowWidth) / 2 + col * (card.width + shape.gapX)
			),
			y: Math.round(top + row * (slot + shape.gapY)),
		});
	}
	return { card, contentHeight, perRow: shape.cols, piles };
}

/** The box a deck's pile covers, its edges included. */
export function pileBounds(pile: Rect, count: number): Rect {
	return { ...pile, height: pile.height + stackDepth(count) };
}

/** How far right each card under a pile's top card steps. */
const PILE_STEP_X = 3;

/** How far the top card of a hovered or focused deck rises. */
export const PILE_LIFT = 6;

/**
 * One card's pose in a resting pile. The top card (index 0) lies square; each
 * card under it shows {@link STACK_EDGE} more edge, a hair askew, so the pile
 * reads as a real stack; cards past {@link MAX_STACK_EDGES} hide under the
 * deepest edge. `lifted` raises the top card (hover or focus on the deck).
 */
export function pilePose({
	count,
	id,
	index,
	lifted = false,
	pile,
}: {
	count: number;
	id: string;
	index: number;
	lifted?: boolean;
	pile: Rect;
}): CardPose & { visible: boolean } {
	const depth = Math.min(index, MAX_STACK_EDGES);
	const visible = index <= MAX_STACK_EDGES;
	const deepest = index > 0 && index === Math.min(count - 1, MAX_STACK_EDGES);
	let tilt = 0;
	if (index > 0) {
		// The bottom card sits a little more askew, so a corner of it shows.
		tilt = jitter(id, 11) * (deepest ? 2.4 : 1.2);
	}
	return {
		rotate: tilt,
		scale: 1,
		visible,
		// Each card under the top steps down and a little right, so even a
		// pile of two shows its second card's edge and corner.
		x: pile.x + (index > 0 ? depth * PILE_STEP_X + jitter(id, 12) * 1.5 : 0),
		y: pile.y + depth * STACK_EDGE - (index === 0 && lifted ? PILE_LIFT : 0),
		z: 40 - Math.min(index, 39),
	};
}

// ---------------------------------------------------------------------------
// The fan and the dock
// ---------------------------------------------------------------------------

/** The bar over an open deck: back, who, and its Deal. */
export const SPREAD_HEADING = 40;
/** Space above the bar and around the dock. */
const SPREAD_INSET = 16;
/** Space between the bar or the dock and the fan's reach. */
const FAN_MARGIN = 24;
/** How far a hovered or focused card rises out of the fan. */
export const FAN_LIFT = 28;
/** How much larger than a resting card a fanned card is dealt, at most. */
const FAN_MAX_SCALE = 1.3;
const FAN_MIN_SCALE = 0.8;
/** Space between fanned cards when they all fit side by side. */
const FAN_GAP = 24;
/** Overlapping fanned cards still show this share of their face... */
const FAN_MIN_EXPOSED = 0.5;
/**
 * ...and never less than this many pixels of it (fewer on a phone), so a
 * title wraps between words instead of inside them. Past that, cards go
 * under "more" instead of thinning out.
 */
export const FAN_MIN_EXPOSED_PX = 108;
const PHONE_FAN_MIN_EXPOSED_PX = 88;
/** The step of a tight fan never opens past this share of a card. */
const FAN_MAX_OVERLAP_STEP = 0.62;
/** An overlapping fan's cards grow less: the hand matters more than the size. */
const FAN_OVERLAP_MAX_SCALE = 1.1;
/** The most cards a fan deals; past it the last slot counts the rest. */
export const MAX_FAN_CARDS = 12;
/** Each card's tilt, and the fan's whole tilt, when the cards overlap. */
const FAN_STEP_DEGREES = 2.5;
export const FAN_TOTAL_DEGREES = 16;
/** The deepest the arc droops at its ends. */
const FAN_DROOP = 16;
/** How far a parted neighbour moves, as a share of a card. */
const FAN_PART = 0.2;

/** A docked deck's card: a face-down pile shrunk into the row. */
export const DOCK_CARD = 40;
const DOCK_LABEL = 16;
const DOCK_LABEL_GAP = 8;
/** A docked deck's slot: wide enough for a short name. */
const DOCK_SLOT = 80;
const DOCK_GAP = 8;
/** Dock slots narrower than this drop their names (still in the button). */
export const DOCK_NAMED_MIN = 60;

export interface DockLayout {
	/** A docked card's size. */
	card: { height: number; width: number };
	/** Each deck's slot centre (the top card's centre), in deck order. */
	centers: Point[];
	/** True when slots are wide enough to show names under the cards. */
	named: boolean;
	slotWidth: number;
	/** The dock's top edge; the fan stops above it. */
	top: number;
}

export function dockLayout(count: number, stage: StageSize): DockLayout {
	const dockCardHeight = Math.round(DOCK_CARD * CARD_RATIO);
	const room = stage.width - stageGutter(stage) * 2;
	const slotWidth = Math.max(
		DOCK_CARD * 0.75,
		Math.min(DOCK_SLOT, (room + DOCK_GAP) / Math.max(1, count) - DOCK_GAP)
	);
	const named = slotWidth >= DOCK_NAMED_MIN;
	const bottom = stage.height - SPREAD_INSET;
	const labelRoom = named ? DOCK_LABEL + DOCK_LABEL_GAP : 0;
	const cy = bottom - labelRoom - dockCardHeight / 2;
	const total = count * slotWidth + Math.max(0, count - 1) * DOCK_GAP;
	const start = (stage.width - total) / 2 + slotWidth / 2;
	return {
		card: { height: dockCardHeight, width: DOCK_CARD },
		centers: Array.from({ length: count }, (_, index) => ({
			x: start + index * (slotWidth + DOCK_GAP),
			y: cy,
		})),
		named,
		slotWidth,
		top: cy - dockCardHeight / 2 - 2 * 2,
	};
}

/** A docked card's pose: the deck's top cards shrunk into a small pile. */
export function dockPose({
	center,
	dock,
	id,
	index,
}: {
	center: Point;
	dock: DockLayout;
	id: string;
	index: number;
}): CardPose & { visible: boolean } {
	const { card } = dock;
	const depth = Math.min(index, 2);
	return {
		rotate: index > 0 ? jitter(id, 11) : 0,
		scale: 1,
		visible: index <= 2,
		x: center.x - card.width / 2,
		y: center.y - card.height / 2 + depth * 2,
		z: 30 - Math.min(index, 29),
	};
}

/**
 * How far past its own box a card of `width` reaches sideways when tilted by
 * `degrees`: its far corners swing out.
 */
export function tiltOverhang(width: number, degrees: number): number {
	const height = width * CARD_RATIO;
	const radians = (Math.abs(degrees) * Math.PI) / 180;
	return Math.max(
		0,
		(width * Math.cos(radians) + height * Math.sin(radians) - width) / 2
	);
}

export interface FanLayout {
	/** A fanned card's size: larger than a resting card when there is room. */
	card: { height: number; width: number };
	/** Each slot's resting centre, in deal order; "more" takes the last one. */
	centers: Point[];
	/** How much of each card's face shows past the next one. */
	exposed: number;
	/** The fan's left and right reach, which the bar over it can line up with. */
	left: number;
	/** Cards past what the fan deals, counted on a face-down last card. */
	more: number;
	/** True when the cards overlap instead of lying side by side. */
	overlapped: boolean;
	/** Each slot's tilt. */
	rotations: number[];
	/** How many of the deck's cards are dealt face up. */
	shown: number;
	/** The distance between neighbouring cards' centres. */
	step: number;
	width: number;
}

/**
 * The open deck's fan: its cards face up in one arc between the bar and the
 * dock, as large as the room allows. A few cards lie side by side in a
 * row; more overlap like a held hand, each still showing
 * {@link FAN_MIN_EXPOSED} of its face. Past what the width holds (or
 * {@link MAX_FAN_CARDS}), the last slot is a face-down card counting the rest.
 */
export function fanLayout({
	card,
	count,
	dockTop,
	stage,
}: {
	card: { height: number; width: number };
	count: number;
	dockTop: number;
	stage: StageSize;
}): FanLayout {
	const gutter = stageGutter(stage);
	const areaTop = SPREAD_INSET + SPREAD_HEADING + FAN_MARGIN;
	const areaBottom = dockTop - FAN_MARGIN;
	const areaHeight = Math.max(
		card.height * FAN_MIN_SCALE,
		areaBottom - areaTop
	);
	const stageWidth = Math.max(card.width, stage.width - gutter * 2);
	// Room for the lift above the cards and the arc's droop under them.
	const scale = Math.max(
		FAN_MIN_SCALE,
		Math.min(FAN_MAX_SCALE, (areaHeight - FAN_LIFT - FAN_DROOP) / card.height)
	);
	let width = Math.round(card.width * scale);
	let slots = Math.min(count, MAX_FAN_CARDS);
	let overlapped = slots * width + (slots - 1) * FAN_GAP > stageWidth;
	let step = width + FAN_GAP;
	let areaWidth = stageWidth;
	if (overlapped) {
		width = Math.round(card.width * Math.min(scale, FAN_OVERLAP_MAX_SCALE));
		// The end cards tilt, so their far corners reach past their boxes: keep
		// those corners inside the gutter too.
		areaWidth = Math.max(
			width,
			stageWidth - 2 * tiltOverhang(width, FAN_TOTAL_DEGREES / 2)
		);
		const minExposed =
			stage.width < PHONE_BELOW ? PHONE_FAN_MIN_EXPOSED_PX : FAN_MIN_EXPOSED_PX;
		const minStep = Math.min(
			width,
			Math.max(width * FAN_MIN_EXPOSED, minExposed)
		);
		const fit = Math.max(1, Math.floor((areaWidth - width) / minStep) + 1);
		slots = Math.min(slots, fit);
		step =
			slots > 1
				? Math.min(
						(areaWidth - width) / (slots - 1),
						width * FAN_MAX_OVERLAP_STEP
					)
				: 0;
		overlapped = step < width;
	}
	const height = Math.round(width * CARD_RATIO);
	const more = count > slots ? count - (slots - 1) : 0;
	const shown = more > 0 ? slots - 1 : slots;
	const gaps = Math.max(1, slots - 1);
	// Cards side by side lie square in a row, so their faces stay crisp; only
	// an overlapping fan tilts and arcs like a held hand.
	const degrees = overlapped
		? Math.min(FAN_STEP_DEGREES, FAN_TOTAL_DEGREES / gaps)
		: 0;
	const outer = (slots - 1) / 2;
	const arc = overlapped ? Math.min(3, FAN_DROOP / Math.max(outer ** 2, 1)) : 0;
	const droop = outer ** 2 * arc;
	const blockHeight = height + droop;
	// The fan sits a little above the middle of its room, under the lift.
	const top =
		areaTop +
		FAN_LIFT +
		Math.max(0, (areaHeight - FAN_LIFT - blockHeight) * 0.4);
	const centers: Point[] = [];
	const rotations: number[] = [];
	for (let index = 0; index < slots; index += 1) {
		const offset = index - outer;
		centers.push({
			x: stage.width / 2 + offset * step,
			y: top + height / 2 + offset * offset * arc,
		});
		rotations.push(degrees === 0 ? 0 : offset * degrees);
	}
	const reach = (slots - 1) * step + width;
	return {
		card: { height, width },
		centers,
		exposed: overlapped ? Math.min(width, Math.round(step)) : width,
		left: (stage.width - reach) / 2,
		more,
		overlapped,
		rotations,
		shown,
		step,
		width: reach,
	};
}

/**
 * A fanned card's pose. A lifted card (hover or focus) rises out of the fan,
 * mostly straightens and comes to the front; in an overlapping fan its two
 * neighbours either side part to show it.
 */
export function fanPose({
	fan,
	index,
	lifted,
}: {
	fan: FanLayout;
	index: number;
	lifted: number | null;
}): CardPose {
	const { card } = fan;
	const center = fan.centers[index] ?? { x: 0, y: 0 };
	let x = center.x;
	let y = center.y;
	let rotate = fan.rotations[index] ?? 0;
	let z = 100 + index;
	if (lifted !== null) {
		const distance = index - lifted;
		if (distance === 0) {
			y -= FAN_LIFT;
			rotate *= 0.3;
			z = 300;
		} else if (fan.overlapped && Math.abs(distance) <= 2) {
			x += (Math.sign(distance) * card.width * FAN_PART) / Math.abs(distance);
		}
	}
	// Scaled text blurs on a composited card, so a lifted card only rises.
	return {
		rotate,
		scale: 1,
		x: x - card.width / 2,
		y: y - card.height / 2,
		z,
	};
}

/**
 * The card a move lands on in a row or grid of `count` cards, `perRow` to a
 * row: left and right step along the reading order, up and down keep the
 * column, Home and End jump to the ends. `undefined` for any other key.
 */
export function gridMove(
	key: string,
	index: number,
	count: number,
	perRow: number
): number | undefined {
	if (count === 0) {
		return;
	}
	const last = count - 1;
	const moves: Record<string, number> = {
		ArrowDown: index + perRow <= last ? index + perRow : index,
		ArrowLeft: Math.max(0, index - 1),
		ArrowRight: Math.min(last, index + 1),
		ArrowUp: index - perRow >= 0 ? index - perRow : index,
		End: last,
		Home: 0,
	};
	return moves[key];
}
