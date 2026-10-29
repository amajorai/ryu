import type { WorldLayout } from "@ryuhq/protocol/interfaces";
import type { Vec3 } from "./game3d-palette.ts";
import { tileToWorld } from "./world-3d-theme.ts";
import type { VillageHouse } from "./world-village.ts";

/**
 * Conversation-shot geometry, kept free of React and three.js so it can be
 * tested: which side of the pair to film from, and which cottages still sit
 * between the lens and the faces.
 */

/**
 * Direction from the pair toward the camera, before normalizing: from the
 * street in front of the pair, close to eye level (about 18 degrees down,
 * a dialogue camera rather than a toy-box view from above), and swung
 * about 23 degrees to one side (`FocusSide`). From the player's side that
 * is a three-quarter over-the-shoulder two-shot: the player in the
 * foreground with its back half turned, the agent beyond it facing the
 * player and the lens.
 */
export const FOCUS_ANGLE: Vec3 = [2.4, 2.0, 5.6];
/**
 * Closest the conversation shot comes to the pair: far enough back that the
 * agent's cottage behind it never fills the frame.
 */
export const FOCUS_DISTANCE = 5.6;
/**
 * Where the player stands while talking, relative to the agent: a step to
 * the agent's left as seen from the street (screen right), a little toward
 * the street, clear of the mailbox and the lamp post, far enough aside that
 * the player's hat never covers the agent's face.
 */
export const TALK_SPOT: Vec3 = [1.25, 0, 0.45];
/** Face height: what must stay unblocked between the lens and the pair. */
export const FOCUS_LOOK_HEIGHT = 0.8;
/**
 * Where the lens aims, below the faces, and how far it rises above its
 * angle: the faces sit in the upper third of the shot, with the ground
 * (not a roof) filling the rest.
 */
export const FOCUS_AIM_HEIGHT = 1.0;
export const FOCUS_EYE_LIFT = 0.25;

/**
 * Film from the player's side (1), the agent's side (-1) or straight in
 * front (0); always from the street.
 */
export type FocusSide = 1 | -1 | 0;

/** Height that covers a cottage, its roof, chimney and smoke. */
const HOUSE_TOP = 2.6;
/** Roof overhang past the 3x2 plot, in tiles. */
const HOUSE_PAD = 0.1;
/** Points tested along the lens-to-pair line. */
const SAMPLES = 6;
/** The occlusion test assumes a slightly longer lens distance than the minimum. */
const TEST_DISTANCE = FOCUS_DISTANCE + 1.2;

/** A tree as a rough upright cylinder, trunk to crown. */
export interface TreeObstacle {
	radius: number;
	top: number;
	x: number;
	z: number;
}

/** Points tested along the line against trees (they are slimmer). */
const TREE_SAMPLES = 14;
/** Extra clearance around a crown, in tiles. */
const TREE_PAD = 0.15;
/**
 * Near the lens a tree fills the frame even beside the line of sight: the
 * half of the line nearest the lens is tested this much wider, in tiles.
 */
const LENS_CORRIDOR = 1.4;

export interface HouseBox {
	agentId: string;
	maxX: number;
	maxZ: number;
	minX: number;
	minZ: number;
}

/** Unit vector from the pair toward the camera for `side`. */
export function focusDirection(side: FocusSide): Vec3 {
	const [x, y, z] = FOCUS_ANGLE;
	const length = Math.hypot(side * x, y, z);
	return [(side * x) / length, y / length, z / length];
}

/** Screen-right as seen from `focusDirection(side)`, on the ground plane. */
export function focusRight(side: FocusSide): Vec3 {
	const [x, , z] = FOCUS_ANGLE;
	const flat = Math.hypot(side * x, z);
	return [z / flat, 0, (-side * x) / flat];
}

/** World-space footprints of every cottage (as drawn, after spreading). */
export function houseBoxes(
	layout: WorldLayout,
	houses: readonly VillageHouse[]
): HouseBox[] {
	return houses.map((house) => {
		const [minX, , minZ] = tileToWorld(layout, { x: house.x, y: house.y });
		return {
			agentId: house.agentId,
			maxX: minX + house.w - 0.5 + HOUSE_PAD,
			maxZ: minZ + house.h - 0.5 + HOUSE_PAD,
			minX: minX - 0.5 - HOUSE_PAD,
			minZ: minZ - 0.5 - HOUSE_PAD,
		};
	});
}

function inside(box: HouseBox, point: Vec3): boolean {
	return (
		point[1] < HOUSE_TOP &&
		point[0] > box.minX &&
		point[0] < box.maxX &&
		point[2] > box.minZ &&
		point[2] < box.maxZ
	);
}

/** Whether any of `SAMPLES` points from `from` to `to` falls in a house. */
export function lineBlocked(
	from: Vec3,
	to: Vec3,
	boxes: readonly HouseBox[]
): boolean {
	return boxes.some((box) => segmentHits(box, from, to));
}

/** Whether the line from `from` to `to` passes through `box`. */
export function segmentHits(box: HouseBox, from: Vec3, to: Vec3): boolean {
	for (let index = 1; index <= SAMPLES; index++) {
		const t = index / SAMPLES;
		const point: Vec3 = [
			from[0] + (to[0] - from[0]) * t,
			from[1] + (to[1] - from[1]) * t,
			from[2] + (to[2] - from[2]) * t,
		];
		if (inside(box, point)) {
			return true;
		}
	}
	return false;
}

/** Midpoint of the pair at face height: what the conversation shot looks at. */
export function pairCenter(agent: Vec3, player: Vec3): Vec3 {
	return [
		(agent[0] + player[0]) / 2,
		FOCUS_LOOK_HEIGHT,
		(agent[2] + player[2]) / 2,
	];
}

/** Where the player stands to talk to the agent standing at `agent`. */
export function conversationSpot(agent: Vec3): Vec3 {
	return [agent[0] + TALK_SPOT[0], agent[1], agent[2] + TALK_SPOT[2]];
}

/** Where the lens sits for `side`, `distance` away from `center`. */
export function focusEye(
	center: Vec3,
	side: FocusSide,
	distance: number
): Vec3 {
	const direction = focusDirection(side);
	return [
		center[0] + direction[0] * distance,
		center[1] + direction[1] * distance + FOCUS_EYE_LIFT,
		center[2] + direction[2] * distance,
	];
}

/**
 * Whether the line from `from` to `to` passes through `tree`'s crown, or
 * (with `corridor`) within that much of it over the half nearest `to`.
 */
export function treeHits(
	tree: TreeObstacle,
	from: Vec3,
	to: Vec3,
	corridor = 0
): boolean {
	for (let index = 1; index <= TREE_SAMPLES; index++) {
		const t = index / TREE_SAMPLES;
		const wide = corridor > 0 && t > 0.5;
		const reach = tree.radius + TREE_PAD + (wide ? corridor : 0);
		const y = from[1] + (to[1] - from[1]) * t;
		const x = from[0] + (to[0] - from[0]) * t;
		const z = from[2] + (to[2] - from[2]) * t;
		// Beside the lens a crown fills the frame whatever its height.
		const below = wide || y < tree.top;
		if (below && Math.hypot(x - tree.x, z - tree.z) < reach) {
			return true;
		}
	}
	return false;
}

/**
 * How many cottages and trees stand between the lens for `side` and
 * either face: zero is a clear shot.
 */
export function shotBlockers(
	agent: Vec3,
	player: Vec3,
	side: FocusSide,
	boxes: readonly HouseBox[],
	trees: readonly TreeObstacle[] = []
): number {
	const eye = focusEye(pairCenter(agent, player), side, TEST_DISTANCE);
	const faces: Vec3[] = [
		[agent[0], FOCUS_LOOK_HEIGHT, agent[2]],
		[player[0], FOCUS_LOOK_HEIGHT, player[2]],
	];
	let count = 0;
	for (const box of boxes) {
		if (faces.some((face) => segmentHits(box, face, eye))) {
			count += 1;
		}
	}
	const center = pairCenter(agent, player);
	for (const tree of trees) {
		if (
			faces.some((face) => treeHits(tree, face, eye)) ||
			treeHits(tree, center, eye, LENS_CORRIDOR)
		) {
			count += 1;
		}
	}
	return count;
}

/**
 * The side to film a conversation from: the first of over the player's
 * shoulder, straight on and the agent's side whose lines of sight to both
 * faces clear every cottage and tree, otherwise the one with the fewest
 * in the way. Anything still in the way is drawn see-through.
 */
export function chooseFocusSide(
	agent: Vec3,
	player: Vec3,
	boxes: readonly HouseBox[],
	trees: readonly TreeObstacle[] = []
): FocusSide {
	const candidates: FocusSide[] = [1, 0, -1];
	let best: FocusSide = 1;
	let fewest = Number.POSITIVE_INFINITY;
	for (const side of candidates) {
		const blockers = shotBlockers(agent, player, side, boxes, trees);
		if (blockers === 0) {
			return side;
		}
		if (blockers < fewest) {
			fewest = blockers;
			best = side;
		}
	}
	return best;
}

/**
 * Cottages between the lens and either face: drawn see-through while the
 * conversation is framed, so nothing hides the pair.
 */
export function occludingHouses(
	agent: Vec3,
	player: Vec3,
	eye: Vec3,
	boxes: readonly HouseBox[]
): Set<string> {
	const faces: Vec3[] = [
		[agent[0], FOCUS_LOOK_HEIGHT, agent[2]],
		[player[0], FOCUS_LOOK_HEIGHT, player[2]],
	];
	const hidden = new Set<string>();
	for (const box of boxes) {
		if (faces.some((face) => segmentHits(box, face, eye))) {
			hidden.add(box.agentId);
		}
	}
	return hidden;
}

/**
 * Half the width of ground the conversation shot sees at the pair, in
 * tiles (a little wider than the lens, for crowns reaching in).
 */
const SHOT_HALF_WIDTH = 3.6;

/**
 * Trees standing in the conversation shot, in front of the pair or beside
 * it: the shot is a little stage, so these step out while the pair talks
 * (as bystanders do), and no canopy fills the frame. Returns their indices
 * in `trees`.
 */
export function treesInShot(
	center: Vec3,
	eye: Vec3,
	trees: readonly TreeObstacle[]
): Set<number> {
	const ax = eye[0] - center[0];
	const az = eye[2] - center[2];
	const length = Math.hypot(ax, az) || 1;
	const hidden = new Set<number>();
	for (const [index, tree] of trees.entries()) {
		const px = tree.x - center[0];
		const pz = tree.z - center[2];
		// 0 at the pair, 1 at the lens; negative behind the pair.
		const t = (px * ax + pz * az) / (length * length);
		if (t < -0.2 || t > 1.15) {
			continue;
		}
		const lateral = Math.abs(px * az - pz * ax) / length;
		const reach = Math.max(0.6, (1 - t) * SHOT_HALF_WIDTH) + tree.radius;
		if (lateral < reach) {
			hidden.add(index);
		}
	}
	return hidden;
}
