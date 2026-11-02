import { translate as tr } from "@ryu/i18n/lite";
import type { LiteralMessage } from "@ryu/i18n/react";
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
	type Rect,
	type SeatInfo,
	type StageSize,
	seatAgents,
	seatTone,
	tableCount,
} from "./card-table-model.ts";

export {
	DOCK_CARD,
	DOCK_NAMED_MIN,
	type DockLayout,
	dockLayout,
	dockPose,
	FAN_LIFT,
	FAN_MIN_EXPOSED_PX,
	FAN_TOTAL_DEGREES,
	type FanLayout,
	fanLayout,
	fanPose,
	gridMove,
	MAX_FAN_CARDS,
	SPREAD_HEADING,
	tiltOverhang,
} from "./card-table-decks-fan.ts";

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
export function deckSummary(deck: Deck, tl: LiteralMessage = tr): string {
	const parts = [tableCount(deck.threads.length, "card", tl)];
	if (deck.running > 0) {
		parts.push(
			tl("{count, plural, other {# running}}", { count: deck.running })
		);
	}
	if (deck.attention > 0) {
		parts.push(
			tl("{count, plural, other {# failed}}", { count: deck.attention })
		);
	}
	if (deck.yourTurn > 0) {
		parts.push(
			tl("{count, plural, other {# for you}}", { count: deck.yourTurn })
		);
	}
	return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** A playing card's 5:7 proportion. */
export const CARD_RATIO = 1.4;
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
