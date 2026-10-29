// apps/desktop/src/components/drafts/drafts-card-layout.ts
//
// Where each card of the Drafts card table sits: the face-down deck in the top
// corner, the fanned hand along the bottom, the send pile at the top, and the
// throw off the table when a pile is sent. Every pose is in one stage
// coordinate space: `x` is from the stage's centre line, `y` from its top.

import type { DraftWire } from "@/src/lib/api/drafts.ts";

/** Card face size, in CSS pixels. 5:7, the proportion of a real playing card. */
export const CARD_WIDTH = 148;
export const CARD_HEIGHT = 207;
/** Cards turn about a point below their foot, so the fan reads as held. */
export const CARD_ORIGIN = { x: 0.5, y: 1.2 };

/** More than this and the fan stops reading as a hand; the newest are dealt. */
export const MAX_HAND = 12;

/** The widest a single card's tilt gets in the fan, and the fan's total tilt. */
const MAX_STEP_DEGREES = 6;
const MAX_FAN_DEGREES = 48;
/** The fan's outermost drop, so a full hand bows instead of tipping over. */
const MAX_FAN_DROP = 28;

/** How far the hovered card rises out of the hand, and how far neighbours part. */
const HOVER_LIFT = 32;
const NEIGHBOUR_PART = CARD_WIDTH * 0.16;

/** The pile sits at the top of the table; cards land a little askew. */
export const PILE_TOP = 28;
const PILE_JITTER_X = 10;
const PILE_JITTER_Y = 6;
const PILE_JITTER_DEGREES = 8;
/** The pile fans a little so a buried card's edge can still be clicked back. */
const PILE_FAN_STEP = 16;
export const PILE_FAN_MAX = 64;

/** The deck sits in the top corner, scaled down, and shows a thin stacked edge. */
const EDGE = 16;
const DECK_SCALE = 0.6;
const DECK_MIN_SCALE = 0.3;
const DECK_EDGE_CARDS = 6;
const DECK_EDGE_STEP = 1;
/** Deck cards drawn under the top one; deeper cards are not rendered at all. */
export const DECK_SHOWN = DECK_EDGE_CARDS + 1;

export interface Pose {
	opacity: number;
	rotate: number;
	scale: number;
	x: number;
	y: number;
	z: number;
}

export interface StageSize {
	height: number;
	width: number;
}

/** A draft the table can deal: one a person could still choose to send. A draft
 *  already due on an `at` trigger is on its way out and is not dealt again. */
export function isDealable(draft: DraftWire, now: number): boolean {
	if (draft.state === "draft" || draft.state === "failed") {
		return true;
	}
	if (draft.state !== "armed") {
		return false;
	}
	return !(draft.trigger.kind === "at" && draft.trigger.epoch_ms <= now);
}

/** A stable value in `[-1, 1]` for an id, so a card always lands on the pile at
 *  the same skew instead of twitching on every re-render. */
export function jitter(id: string, salt: number): number {
	let hash = 2_166_136_261 ^ salt;
	for (const char of id) {
		hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16_777_619);
	}
	return ((hash >>> 0) % 2001) / 1000 - 1;
}

export function handPose(
	index: number,
	count: number,
	stage: StageSize,
	hoveredIndex: number | null
): Pose {
	const gaps = Math.max(count - 1, 1);
	const spread =
		count > 1
			? Math.max(
					0,
					Math.min(CARD_WIDTH * 0.62, (stage.width - CARD_WIDTH - 96) / gaps)
				)
			: 0;
	const step =
		count > 1 ? Math.min(MAX_STEP_DEGREES, MAX_FAN_DEGREES / gaps) : 0;
	const offset = index - (count - 1) / 2;
	const edge = Math.max((count - 1) / 2, 1);
	const reach = offset / edge;
	const drop = Math.min(2.4 * edge * edge, MAX_FAN_DROP);

	let x = offset * spread;
	let y = stage.height - CARD_HEIGHT - 20 + reach * reach * drop;
	let rotate = offset * step;
	let scale = 1;
	let z = 100 + index;

	if (hoveredIndex !== null) {
		const distance = index - hoveredIndex;
		if (distance === 0) {
			y -= HOVER_LIFT;
			rotate *= 0.4;
			scale = 1.04;
			z = 300;
		} else {
			x += Math.sign(distance) * NEIGHBOUR_PART;
		}
	}
	return { opacity: 1, rotate, scale, x, y, z };
}

export function pilePose(id: string, order: number, count: number): Pose {
	const step =
		count > 1 ? Math.min(PILE_FAN_STEP, PILE_FAN_MAX / (count - 1)) : 0;
	return {
		opacity: 1,
		rotate: jitter(id, 1) * PILE_JITTER_DEGREES,
		scale: 1,
		x: (order - (count - 1) / 2) * step + jitter(id, 2) * PILE_JITTER_X,
		y: PILE_TOP + jitter(id, 3) * PILE_JITTER_Y - order * 1.5,
		z: 400 + order,
	};
}

/** The left edge of the send pile's outline, from the stage's left edge. */
function pileLeft(stage: StageSize): number {
	return stage.width / 2 - (CARD_WIDTH + 32 + PILE_FAN_MAX) / 2;
}

/**
 * The deck in the top-start corner. It shrinks on a narrow stage so it never
 * reaches the send pile. `order` 0 is the top card, the next one dealt.
 */
export function deckPose(order: number, stage: StageSize): Pose {
	const room = pileLeft(stage) - EDGE * 2;
	const scale = Math.max(
		DECK_MIN_SCALE,
		Math.min(DECK_SCALE, room / CARD_WIDTH)
	);
	const depth = Math.min(order, DECK_EDGE_CARDS) * DECK_EDGE_STEP;
	// Scaling turns about the card's origin, so shift the frame back to put the
	// scaled card's top-start corner on the edge.
	const shiftX = CARD_WIDTH * CARD_ORIGIN.x * (1 - scale);
	const shiftY = CARD_HEIGHT * CARD_ORIGIN.y * (1 - scale);
	return {
		opacity: 1,
		rotate: 0,
		scale,
		x: EDGE - stage.width / 2 + CARD_WIDTH / 2 - shiftX + depth,
		y: EDGE - shiftY + depth,
		z: DECK_SHOWN - Math.min(order, DECK_SHOWN),
	};
}

/** A sent card thrown up and off the top of the window, to its own side. */
export function throwPose(id: string, from: Pose, order: number): Pose {
	const side = jitter(id, 4) >= 0 ? 1 : -1;
	return {
		opacity: 0,
		rotate: from.rotate + 22 * side,
		scale: 0.85,
		x: from.x + 90 * side,
		y: -(window.innerHeight + CARD_HEIGHT),
		z: 500 + order,
	};
}
