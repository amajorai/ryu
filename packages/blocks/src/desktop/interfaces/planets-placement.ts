import { type Box, overlapArea } from "./planets-model.ts";

/**
 * Label placement for the scene overlay: name plates under (or beside) their
 * bodies and moon titles beside their moons. Pure, so it can be tested
 * without a canvas. Each label tries a few sides of its anchor and keeps the
 * first that is clear of the bodies, the HUD and the labels already placed.
 */

export const SIDES = ["below", "above", "right", "left"] as const;
export type Side = (typeof SIDES)[number];

export interface Anchor {
	/** On-screen radius of the body, px. */
	radius: number;
	x: number;
	y: number;
}

export interface Placement {
	box: Box;
	/** Square pixels of the label that still overlap something. */
	overlap: number;
	side: Side;
}

const LABEL_GAP = 6;

/** The box a label of `size` takes on one `side` of its anchor. */
export function sideBox(
	side: Side,
	anchor: Anchor,
	size: { height: number; width: number },
	gap = LABEL_GAP
): Box {
	const reach = anchor.radius + gap;
	let left = anchor.x - size.width / 2;
	let top = anchor.y + reach;
	if (side === "above") {
		top = anchor.y - reach - size.height;
	} else if (side === "right") {
		left = anchor.x + reach + 2;
		top = anchor.y - size.height / 2;
	} else if (side === "left") {
		left = anchor.x - reach - 2 - size.width;
		top = anchor.y - size.height / 2;
	}
	return {
		bottom: top + size.height,
		left,
		right: left + size.width,
		top,
	};
}

/** Slides a box inside `bounds` (when it fits), keeping its size. */
export function clampBox(box: Box, bounds: Box): Box {
	const width = box.right - box.left;
	const height = box.bottom - box.top;
	const left = Math.min(
		Math.max(box.left, bounds.left),
		Math.max(bounds.left, bounds.right - width)
	);
	const top = Math.min(
		Math.max(box.top, bounds.top),
		Math.max(bounds.top, bounds.bottom - height)
	);
	return { bottom: top + height, left, right: left + width, top };
}

/** The bounding box of a disc, shrunk a little so labels may graze it. */
export function discBox(anchor: Anchor, shrink = 0.86): Box {
	const radius = Math.max(2, anchor.radius * shrink);
	return {
		bottom: anchor.y + radius,
		left: anchor.x - radius,
		right: anchor.x + radius,
		top: anchor.y - radius,
	};
}

function overlapWith(box: Box, obstacles: readonly Box[]): number {
	let total = 0;
	for (const obstacle of obstacles) {
		total += overlapArea(box, obstacle);
	}
	return total;
}

/** Clear space a label's usual side needs before the label moves back. */
const HOME_MARGIN = 10;

function grow(box: Box, by: number): Box {
	return {
		bottom: box.bottom + by,
		left: box.left - by,
		right: box.right + by,
		top: box.top - by,
	};
}

/** Covering the label's own body costs this much more than other overlaps. */
const OWN_WEIGHT = 40;

/**
 * Picks a side for a label: the previous side while it stays clear (so
 * labels don't flicker as bodies move), else the first clear side in
 * `sides`, else the side that overlaps least. `own` is the body the label
 * names (with its clear space): a label slid back inside the scene must
 * never land on it, so covering it weighs far more than anything else.
 * `keepClear` (such as the star's face) weighs the same.
 */
export function placeLabel({
	anchor,
	bounds,
	keepClear = [],
	obstacles,
	own,
	previous,
	sides,
	size,
}: {
	anchor: Anchor;
	bounds: Box;
	keepClear?: readonly Box[];
	obstacles: readonly Box[];
	own?: Box;
	previous?: Side | null;
	sides: readonly Side[];
	size: { height: number; width: number };
}): Placement {
	const at = (side: Side): Placement => {
		const box = clampBox(sideBox(side, anchor, size), bounds);
		const covers =
			((own ? overlapArea(box, own) : 0) + overlapWith(box, keepClear)) *
			OWN_WEIGHT;
		return { box, overlap: overlapWith(box, obstacles) + covers, side };
	};
	const home = sides[0];
	if (previous && sides.includes(previous)) {
		const kept = at(previous);
		// A label that stepped aside goes home once its usual side is clear
		// with room to spare (the margin keeps it from flickering back).
		if (home && previous !== home && kept.overlap === 0) {
			const back = at(home);
			if (
				back.overlap === 0 &&
				overlapWith(grow(back.box, HOME_MARGIN), obstacles) === 0
			) {
				return back;
			}
		}
		if (kept.overlap === 0) {
			return kept;
		}
	}
	let best: Placement | null = null;
	for (const side of sides) {
		const placement = at(side);
		if (placement.overlap === 0) {
			return placement;
		}
		if (!best || placement.overlap < best.overlap) {
			best = placement;
		}
	}
	return best ?? at("below");
}

/**
 * Sides to try for a moon's title: away from its planet first (above when
 * the moon is in the planet's upper half, below otherwise), then beside it
 * on the far side, then the rest.
 */
export function moonSides(moon: Anchor, body: Anchor): Side[] {
	const dx = moon.x - body.x;
	const dy = moon.y - body.y;
	const outward: Side = dx >= 0 ? "right" : "left";
	const inward: Side = dx >= 0 ? "left" : "right";
	const vertical: Side = dy < 0 ? "above" : "below";
	const opposite: Side = dy < 0 ? "below" : "above";
	if (Math.abs(dx) > Math.abs(dy) * 1.6) {
		return [outward, vertical, opposite, inward];
	}
	return [vertical, outward, inward, opposite];
}

/** True when most of a box sits under one of the HUD's boxes. */
export function mostlyUnder(box: Box, cover: readonly Box[]): boolean {
	const area = Math.max(1, (box.right - box.left) * (box.bottom - box.top));
	return cover.some((item) => overlapArea(box, item) > area * 0.35);
}
