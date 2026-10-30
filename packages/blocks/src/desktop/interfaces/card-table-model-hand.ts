import {
	CARD_CLAMP,
	CARD_ORIGIN_Y,
	type CardPose,
	COMPACT_EMPTY_SEAT_HALF,
	COMPACT_FAN_EDGE,
	EMPTY_SEAT_HALF,
	FAN_EDGE,
	HAND_MARGIN,
	LABEL_RESERVE,
	MAX_SPREAD,
	type Point,
	READABLE_SPREAD,
	type Rect,
	type StageSize,
	type TableGeometry,
} from "./card-table-model-geometry.ts";

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
