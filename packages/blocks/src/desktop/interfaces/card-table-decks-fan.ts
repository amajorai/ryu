import { CARD_RATIO, PHONE_BELOW, stageGutter } from "./card-table-decks.ts";
import {
	type CardPose,
	jitter,
	type Point,
	type StageSize,
} from "./card-table-model.ts";

/** The Cards layout's fan and dock: where an opened deck's cards spread. */

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
