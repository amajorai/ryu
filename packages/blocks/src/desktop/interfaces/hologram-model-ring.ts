import { INNER_RING_CAPACITY } from "./hologram-model.ts";

/** Hologram ring slots and the radial menu's placement around a planet. */

export interface RingSlot {
	/** Degrees clockwise from 12 o'clock, before the ring's spin. */
	angle: number;
	id: string;
	ring: 0 | 1;
}

/**
 * Places agents on one ring, or two when there are more than
 * {@link INNER_RING_CAPACITY}. The outer ring is offset by half a step so its
 * nodes sit between the inner ones.
 */
export function ringSlots(ids: readonly string[]): RingSlot[] {
	const inner =
		ids.length > INNER_RING_CAPACITY
			? ids.slice(0, Math.ceil(ids.length / 2.4))
			: ids;
	const outer = ids.slice(inner.length);
	const place = (list: readonly string[], ring: 0 | 1): RingSlot[] => {
		const step = 360 / Math.max(1, list.length);
		const offset = ring === 1 ? step / 2 : 0;
		return list.map((id, index) => ({
			angle: Math.round((offset + step * index) * 100) / 100,
			id,
			ring,
		}));
	};
	return [...place(inner, 0), ...place(outer, 1)];
}

/** A point on a circle, angle in degrees clockwise from 12 o'clock. */
export function polar(angle: number, radius: number): { x: number; y: number } {
	const radians = ((angle - 90) * Math.PI) / 180;
	return {
		x: Math.round(Math.cos(radians) * radius * 100) / 100,
		y: Math.round(Math.sin(radians) * radius * 100) / 100,
	};
}

/** Normalizes degrees to [0, 360). */
export function normalizeAngle(angle: number): number {
	return ((angle % 360) + 360) % 360;
}

export interface MenuLayoutInput {
	/** The box the menu must stay inside (the orbit). */
	box: { height: number; width: number };
	/** Clear space kept between an item and the box edge. */
	inset?: number;
	/** Item sizes, in menu order. */
	items: readonly { height: number; width: number }[];
	/**
	 * The node's own label under it, from the node centre; items keep clear
	 * of it.
	 */
	keepOut?: { bottom: number; left: number; right: number; top: number };
	/** Node centre inside the box. */
	nodeX: number;
	nodeY: number;
	/** Direction from the core to the node, degrees clockwise from 12 o'clock. */
	outward: number;
	/** Radius of the arc the items' near edges sit on, around the node. */
	radius: number;
}

export interface MenuItemPlacement {
	/** The item's direction from the node, degrees clockwise from 12 o'clock. */
	angle: number;
	/** The item's top-left corner, from the node centre. */
	left: number;
	/** Distance from the node centre to the arc point the item is anchored to. */
	reach: number;
	top: number;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Angles between neighbouring items, tried narrowest first. */
export const MENU_STEPS = [44, 56, 68] as const;
const MENU_ITEM_GAP = 4;

interface Rect {
	bottom: number;
	left: number;
	right: number;
	top: number;
}

const overlaps = (a: Rect, b: Rect, gap: number) =>
	a.left < b.right + gap &&
	b.left < a.right + gap &&
	a.top < b.bottom + gap &&
	b.top < a.bottom + gap;

/** Rays this close to vertical centre their item on the ray. */
const CENTRED_RAY = 0.35;

/**
 * One item on the fan, anchored where its ray meets the arc: on the right
 * the item starts there, on the left it ends there, and straight up or down
 * it is centred over or under it. Every item hugs the same arc, whatever
 * its width.
 */
function placeOnRay(
	angle: number,
	size: { height: number; width: number },
	radius: number
): MenuItemPlacement {
	const unit = polar(angle, 1);
	const point = polar(angle, radius);
	let left = point.x - size.width / 2;
	let top = unit.y > 0 ? point.y : point.y - size.height;
	if (unit.x > CENTRED_RAY) {
		left = point.x;
		top = point.y - size.height / 2;
	} else if (unit.x < -CENTRED_RAY) {
		left = point.x - size.width;
		top = point.y - size.height / 2;
	}
	return {
		angle: round2(normalizeAngle(angle)),
		left: round2(left),
		reach: radius,
		top: round2(top),
	};
}

/**
 * The items fanned around the node at equal angular steps, centred on
 * `centre`, assigned in reading order: top to bottom when the fan opens to
 * a side, left to right when it opens up or down.
 */
export function fanAround(
	items: MenuLayoutInput["items"],
	centre: number,
	step: number,
	radius: number
): MenuItemPlacement[] {
	const middle = (items.length - 1) / 2;
	const angles = items.map((_, index) => centre + (index - middle) * step);
	const sideways = Math.abs(polar(centre, 1).x) > 0.7;
	const key = (angle: number) => {
		const point = polar(angle, 1);
		return sideways ? point.y : point.x;
	};
	const ordered = [...angles].sort((a, b) => key(a) - key(b));
	return items.map((item, index) =>
		placeOnRay(ordered[index] ?? centre, item, radius)
	);
}

/**
 * Lays the radial menu out around the node: the items fan out on one arc,
 * toward the core first (where the deck is open), turning a step at a time
 * either way until one fits, widening the fan when items would crowd. A layout
 * must stay inside the box and off the node's label.
 */
export function radialMenuLayout(input: MenuLayoutInput): MenuItemPlacement[] {
	const { box, items, keepOut, nodeX, nodeY, outward, radius } = input;
	const inset = input.inset ?? 4;
	const fits = (placements: MenuItemPlacement[]) => {
		const rects = placements.map((place, index) => {
			const size = items[index] ?? { height: 0, width: 0 };
			return {
				bottom: place.top + size.height,
				left: place.left,
				right: place.left + size.width,
				top: place.top,
			};
		});
		for (const [index, rect] of rects.entries()) {
			if (
				nodeX + rect.left < inset ||
				nodeY + rect.top < inset ||
				nodeX + rect.right > box.width - inset ||
				nodeY + rect.bottom > box.height - inset
			) {
				return false;
			}
			if (keepOut && overlaps(rect, keepOut, 0)) {
				return false;
			}
			for (const other of rects.slice(index + 1)) {
				if (overlaps(rect, other, MENU_ITEM_GAP)) {
					return false;
				}
			}
		}
		return true;
	};
	const inward = outward + 180;
	// Straight toward the core, then turning 15 degrees at a time either way
	// until the fan points straight out.
	const centres = [inward];
	for (let turn = 15; turn <= 180; turn += 15) {
		centres.push(inward - turn, inward + turn);
	}
	for (const centre of centres) {
		for (const step of MENU_STEPS) {
			const placements = fanAround(items, centre, step, radius);
			if (fits(placements)) {
				return placements;
			}
		}
	}
	return fanAround(items, inward, MENU_STEPS[0], radius);
}
