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
export const HAND_MARGIN = 56;
/** The share of a tall stage's spare height that goes under the hand. */
const LIFT_SHARE = 0.5;
const COMPACT_LIFT_SHARE = 0.6;
/** Room the hand's label and key hints need beside the fan, gap included. */
export const LABEL_RESERVE = 224;
/** Space kept clear between the fan and the stage edge when there is no label. */
export const FAN_EDGE = 28;
export const COMPACT_FAN_EDGE = 16;
/** No card, lifted or parted, ever crosses closer than this to a stage edge. */
export const CARD_CLAMP = 6;
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
export const READABLE_SPREAD = 0.8;
export const MAX_SPREAD = 0.88;

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
