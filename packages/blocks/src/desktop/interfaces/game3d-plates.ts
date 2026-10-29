/**
 * Keeps the 3D stage's plates (villager names, `IsoMarker`s, `IsoLabel`s)
 * from overlapping: pure, so it is testable without a DOM. `IsoStage`
 * measures every plate where the camera puts it, asks `separatePlates` for
 * small nudges and applies them, so a crowded diorama (a phone, a zoomed-out
 * view) stays readable and every plate stays clickable.
 *
 * Each overlapping pair is pushed apart along the axis it overlaps least
 * (plates are wide and short, so usually up and down), half each, over a
 * few relaxation passes. Nudges are capped at `MAX_NUDGE` so a plate never
 * drifts far from what it names; you-spot queue plates may spread to
 * `YOU_SPOT_NUDGE`, relaxing until they hold `YOU_SPOT_GAP`.
 */

/** A plate where the camera puts it: centre and size, in px. */
export interface PlateBox {
	/** An alarm plate: it moves off figures (its own and its neighbours'). */
	clearsFigures?: boolean;
	/**
	 * A villager's figure on screen (head to feet): never moves, and only
	 * plates that `clearsFigures` keep off it.
	 */
	figure?: boolean;
	height: number;
	/**
	 * An agent's name plate: an alarm plate moves wholly off it, as off a
	 * figure (other plates part from it as usual).
	 */
	namePlate?: boolean;
	width: number;
	x: number;
	y: number;
	/**
	 * A you-spot queue plate: two of them keep YOU_SPOT_GAP apart (touch
	 * targets), not PLATE_GAP.
	 */
	youSpot?: boolean;
}

/** Space kept between plates (px). */
export const PLATE_GAP = 3;
/** Space kept between two you-spot queue plates (px): a finger's margin. */
export const YOU_SPOT_GAP = 8;
/** The furthest a plate is nudged from its anchor (px). */
export const MAX_NUDGE = 34;
/** How far an alarm plate may move to clear a figure (px). */
export const FIGURE_CLEAR_NUDGE = 2 * MAX_NUDGE;
/**
 * The furthest a you-spot plate is nudged (px): a queue must hold
 * YOU_SPOT_GAP between its plates (touch targets), so it may spread further
 * than a name plate drifts.
 */
export const YOU_SPOT_NUDGE = 4 * MAX_NUDGE;
const PASSES = 10;
/** Passes allowed while two you-spot plates still sit closer than the gap. */
const YOU_SPOT_PASSES = 60;

function clamp(value: number, limit: number): number {
	return Math.max(-limit, Math.min(limit, value));
}

/**
 * The nudge `[dx, dy]` (px) for each plate so none overlap. With `room`,
 * every pass also holds each plate inside it, so a plate against an edge
 * stays put and its neighbours give way instead.
 */
export function separatePlates(
	boxes: readonly PlateBox[],
	gap = PLATE_GAP,
	limit = MAX_NUDGE,
	room: StageRoom | null = null,
	margin = STAGE_MARGIN
): [number, number][] {
	const nudges: [number, number][] = boxes.map(() => [0, 0]);
	const reach = boxes.map((box) => {
		if (box.youSpot) {
			return Math.max(limit, YOU_SPOT_NUDGE);
		}
		return box.clearsFigures ? Math.max(limit, FIGURE_CLEAR_NUDGE) : limit;
	});
	// Relaxes every overlapping pair (from wherever the nudges are now).
	const relax = () => {
		for (let pass = 0; pass < YOU_SPOT_PASSES; pass++) {
			let moved = false;
			let queueTight = false;
			for (let i = 0; i < boxes.length; i++) {
				for (let j = i + 1; j < boxes.length; j++) {
					const a = boxes[i];
					const b = boxes[j];
					const na = nudges[i];
					const nb = nudges[j];
					if (!(a && b && na && nb)) {
						continue;
					}
					// A figure is an obstacle for alarm plates only, and never moves.
					const figureA = a.figure === true;
					const figureB = b.figure === true;
					if (
						(figureA && (figureB || !b.clearsFigures)) ||
						(figureB && !a.clearsFigures)
					) {
						continue;
					}
					const dx = b.x + nb[0] - (a.x + na[0]);
					const dy = b.y + nb[1] - (a.y + na[1]);
					// Nudges are rounded to whole px at the end, which can take back
					// up to 1px: solve two queue plates for one px more than the gap.
					const pairGap =
						a.youSpot && b.youSpot ? Math.max(gap, YOU_SPOT_GAP) + 1 : gap;
					const overlapX = (a.width + b.width) / 2 + pairGap - Math.abs(dx);
					const overlapY = (a.height + b.height) / 2 + pairGap - Math.abs(dy);
					if (overlapX <= 0 || overlapY <= 0) {
						continue;
					}
					moved = true;
					queueTight ||= a.youSpot === true && b.youSpot === true;
					const reachA = reach[i] ?? limit;
					const reachB = reach[j] ?? limit;
					// Ties (stacked exactly) part by order: the later plate goes down
					// or right, so the result is stable frame to frame. An alarm takes
					// the whole move off a figure or a name plate.
					const blocksA = figureA || (a.namePlate === true && b.clearsFigures);
					const blocksB = figureB || (b.namePlate === true && a.clearsFigures);
					let shareA = 0.5;
					if (blocksA && !blocksB) {
						shareA = 0;
					} else if (blocksB && !blocksA) {
						shareA = 1;
					}
					const shareB = 1 - shareA;
					if (overlapY <= overlapX) {
						const sign = dy === 0 ? 1 : Math.sign(dy);
						na[1] = clamp(na[1] - sign * overlapY * shareA, reachA);
						nb[1] = clamp(nb[1] + sign * overlapY * shareB, reachB);
					} else {
						const sign = dx === 0 ? 1 : Math.sign(dx);
						na[0] = clamp(na[0] - sign * overlapX * shareA, reachA);
						nb[0] = clamp(nb[0] + sign * overlapX * shareB, reachB);
					}
				}
			}
			if (room) {
				for (const [index, box] of boxes.entries()) {
					const nudge = nudges[index];
					if (!nudge || box.figure) {
						continue;
					}
					const [sx, sy] = stageShift(
						{ ...box, x: box.x + nudge[0], y: box.y + nudge[1] },
						room,
						margin
					);
					nudge[0] += sx;
					nudge[1] += sy;
				}
			}
			// Name plates settle in PASSES; a queue keeps relaxing until its
			// plates hold the gap.
			if (!moved || (pass + 1 >= PASSES && !queueTight)) {
				break;
			}
		}
	};
	relax();
	// Alarms have the last word: apart from each other, then off any figure
	// or name plate they are boxed in against, then everything relaxes again
	// from there and alarms part once more.
	partAlarms(boxes, nudges, gap, reach);
	rehomeAlarms(boxes, nudges, gap, room);
	relax();
	partAlarms(boxes, nudges, gap, reach);
	return nudges.map(([x, y]) => [Math.round(x), Math.round(y)]);
}

/** How much two boxes (with their nudges) overlap, in px², with a gap. */
function overlapArea(
	a: PlateBox,
	na: readonly [number, number],
	b: PlateBox,
	nb: readonly [number, number],
	gap: number
): number {
	const x =
		(a.width + b.width) / 2 + gap - Math.abs(b.x + nb[0] - (a.x + na[0]));
	const y =
		(a.height + b.height) / 2 + gap - Math.abs(b.y + nb[1] - (a.y + na[1]));
	return x > 0 && y > 0 ? x * y : 0;
}

/** The step (px) of the spots a boxed-in alarm plate tries. */
const REHOME_STEP = 4;

/**
 * An alarm plate boxed in between obstacles (its own figure on one side, a
 * neighbour's name plate on the other) settles into one of them. Such a
 * plate looks for a better spot within FIGURE_CLEAR_NUDGE of where it is
 * (and inside `room`): the least overlap with figures and name plates
 * first, then with other plates, then the shortest move.
 */
function rehomeAlarms(
	boxes: readonly PlateBox[],
	nudges: [number, number][],
	gap: number,
	room: StageRoom | null
) {
	const isObstacle = (box: PlateBox) =>
		box.figure === true || box.namePlate === true;
	for (const [index, alarm] of boxes.entries()) {
		const nudge = nudges[index];
		if (!(alarm.clearsFigures && nudge)) {
			continue;
		}
		const cost = (at: readonly [number, number]) => {
			let obstacles = 0;
			let plates = 0;
			for (const [other, box] of boxes.entries()) {
				if (other === index) {
					continue;
				}
				const area = overlapArea(alarm, at, box, nudges[other] ?? [0, 0], gap);
				if (isObstacle(box)) {
					obstacles += area;
				} else {
					plates += area;
				}
			}
			return { obstacles, plates };
		};
		if (cost(nudge).obstacles === 0) {
			continue;
		}
		let best: { at: [number, number]; score: number } | null = null;
		const span = FIGURE_CLEAR_NUDGE;
		for (let dx = -span; dx <= span; dx += REHOME_STEP) {
			for (let dy = -span; dy <= span; dy += REHOME_STEP) {
				const at: [number, number] = [nudge[0] + dx, nudge[1] + dy];
				if (
					room &&
					(stageShift(
						{ ...alarm, x: alarm.x + at[0], y: alarm.y + at[1] },
						room
					)[0] !== 0 ||
						stageShift(
							{ ...alarm, x: alarm.x + at[0], y: alarm.y + at[1] },
							room
						)[1] !== 0)
				) {
					continue;
				}
				const { obstacles, plates } = cost(at);
				const score = obstacles * 1e6 + plates * 1e3 + Math.hypot(dx, dy);
				if (!best || score < best.score) {
					best = { at, score };
				}
			}
		}
		if (best) {
			nudge[0] = best.at[0];
			nudge[1] = best.at[1];
		}
	}
}

/**
 * The last word on alarm plates: two alarms (a stack at one station, or
 * neighbours) never overlap, even where moving off a figure or a name plate
 * pushed one into the other. Parts every overlapping pair of alarm plates,
 * half each, over a few passes (one px over the gap, for the rounding).
 */
function partAlarms(
	boxes: readonly PlateBox[],
	nudges: [number, number][],
	gap: number,
	reach: readonly number[]
) {
	for (let pass = 0; pass < PASSES; pass++) {
		let moved = false;
		for (let i = 0; i < boxes.length; i++) {
			for (let j = i + 1; j < boxes.length; j++) {
				const a = boxes[i];
				const b = boxes[j];
				const na = nudges[i];
				const nb = nudges[j];
				if (!(a?.clearsFigures && b?.clearsFigures && na && nb)) {
					continue;
				}
				const dx = b.x + nb[0] - (a.x + na[0]);
				const dy = b.y + nb[1] - (a.y + na[1]);
				const overlapX = (a.width + b.width) / 2 + gap + 1 - Math.abs(dx);
				const overlapY = (a.height + b.height) / 2 + gap + 1 - Math.abs(dy);
				if (overlapX <= 0 || overlapY <= 0) {
					continue;
				}
				moved = true;
				const reachA = (reach[i] ?? MAX_NUDGE) * 2;
				const reachB = (reach[j] ?? MAX_NUDGE) * 2;
				if (overlapY <= overlapX) {
					const sign = dy === 0 ? 1 : Math.sign(dy);
					na[1] = clamp(na[1] - (sign * overlapY) / 2, reachA);
					nb[1] = clamp(nb[1] + (sign * overlapY) / 2, reachB);
				} else {
					const sign = dx === 0 ? 1 : Math.sign(dx);
					na[0] = clamp(na[0] - (sign * overlapX) / 2, reachA);
					nb[0] = clamp(nb[0] + (sign * overlapX) / 2, reachB);
				}
			}
		}
		if (!moved) {
			return;
		}
	}
}

/** The stage's box in px: plates stay inside it. */
export interface StageRoom {
	bottom: number;
	left: number;
	right: number;
	top: number;
}

/** Space kept between a plate and the stage's edge (px). */
export const STAGE_MARGIN = 2;

/**
 * The whole-px shift `[dx, dy]` that brings a plate inside `room`, kept
 * `margin` from each edge: zero for a plate already inside. A plate wider
 * or taller than the room keeps its left or top edge in.
 */
export function stageShift(
	box: PlateBox,
	room: StageRoom,
	margin = STAGE_MARGIN
): [number, number] {
	const axis = (centre: number, size: number, low: number, high: number) => {
		const start = centre - size / 2;
		if (start < low + margin) {
			return Math.ceil(low + margin - start);
		}
		const over = start + size - (high - margin);
		if (over > 0) {
			return 0 - Math.min(Math.ceil(over), Math.floor(start - low - margin));
		}
		return 0;
	};
	return [
		axis(box.x, box.width, room.left, room.right),
		axis(box.y, box.height, room.top, room.bottom),
	];
}

/**
 * The nudges that part `boxes` and keep each inside `room` (the stage minus
 * its HUD insets, so a plate never hides under the title plate or the
 * controls): each plate is brought inside first, then parted with the room
 * as a wall (separatePlates), so the clamp never pushes plates back
 * together. Whole px.
 */
export function partOnStage(
	boxes: readonly PlateBox[],
	room: StageRoom | null,
	margin = STAGE_MARGIN
): [number, number][] {
	const shiftOf = (box: PlateBox): [number, number] =>
		room && !box.figure ? stageShift(box, room, margin) : [0, 0];
	const moved = (box: PlateBox, [dx, dy]: readonly [number, number]) => ({
		...box,
		x: box.x + dx,
		y: box.y + dy,
	});
	const inside = boxes.map((box) => moved(box, shiftOf(box)));
	const parts = separatePlates(inside, PLATE_GAP, MAX_NUDGE, room, margin);
	const placed = inside.map((box, index) => moved(box, parts[index] ?? [0, 0]));
	return placed.map((box, index) => {
		const from = boxes[index] as PlateBox;
		return [Math.round(box.x - from.x), Math.round(box.y - from.y)];
	});
}

/** Whether any two plates (after their nudges) still overlap. */
export function platesOverlap(
	boxes: readonly PlateBox[],
	nudges: readonly (readonly [number, number])[] = []
): boolean {
	for (let i = 0; i < boxes.length; i++) {
		for (let j = i + 1; j < boxes.length; j++) {
			const a = boxes[i];
			const b = boxes[j];
			if (!(a && b)) {
				continue;
			}
			const [ax, ay] = nudges[i] ?? [0, 0];
			const [bx, by] = nudges[j] ?? [0, 0];
			const overlapX =
				(a.width + b.width) / 2 - Math.abs(b.x + bx - (a.x + ax));
			const overlapY =
				(a.height + b.height) / 2 - Math.abs(b.y + by - (a.y + ay));
			if (overlapX > 0.5 && overlapY > 0.5) {
				return true;
			}
		}
	}
	return false;
}

/**
 * A plate for the stage's content fit: its anchor (the point drei projects,
 * which a side- or row-hung plate sits a fixed px away from) and how far
 * the plate and its speech bubble reach from it, in px. Only the anchor
 * moves with the camera; the reach is screen-sized.
 */
export interface FitBox {
	bottom: number;
	left: number;
	right: number;
	top: number;
	x: number;
	y: number;
}

/** A content fit: pan (world units along the screen axes) and zoom factor. */
export interface ContentFitBox {
	right: number;
	scale: number;
	up: number;
}

/** The room a fit frames: the canvas size and the HUD insets (px). */
export interface FitRoom {
	height: number;
	insets: { bottom: number; left: number; right: number; top: number };
	width: number;
}

/**
 * The content fit framing `boxes`, measured at `zoom` under a camera that
 * already carries `applied`. With `toView`, each anchor is mapped into
 * another camera's view first (the base one), so the result does not depend
 * on the fit the camera carries: anchors move with the camera, the plates'
 * px reach does not.
 */
export function fitBoxes(
	boxes: readonly FitBox[],
	room: FitRoom,
	zoom: number,
	pad: { above: number; below: number; max: number; side: number },
	applied: ContentFitBox = { right: 0, scale: 1, up: 0 },
	toView?: (points: [number, number][]) => [number, number][]
): ContentFitBox | null {
	const anchors = toView
		? toView(boxes.map((box) => [box.x, box.y]))
		: boxes.map((box): [number, number] => [box.x, box.y]);
	let left = Number.POSITIVE_INFINITY;
	let right = Number.NEGATIVE_INFINITY;
	let top = Number.POSITIVE_INFINITY;
	let bottom = Number.NEGATIVE_INFINITY;
	for (const [index, box] of boxes.entries()) {
		const [x, y] = anchors[index] ?? [box.x, box.y];
		left = Math.min(left, x + box.left);
		right = Math.max(right, x + box.right);
		top = Math.min(top, y + box.top);
		bottom = Math.max(bottom, y + box.bottom);
	}
	if (!Number.isFinite(left)) {
		return null;
	}
	const { insets } = room;
	const roomWidth = room.width - insets.left - insets.right;
	const roomHeight = room.height - insets.top - insets.bottom;
	const width = right - left + pad.side * zoom * 2;
	const height = bottom - top + (pad.above + pad.below) * zoom;
	const scale = Math.max(
		1,
		Math.min(
			pad.max,
			(applied.scale * roomWidth) / width,
			(applied.scale * roomHeight) / height
		)
	);
	const middleX = (left + right) / 2;
	const middleY = (top + bottom) / 2 + ((pad.below - pad.above) / 2) * zoom;
	return {
		right: applied.right + (middleX - (insets.left + roomWidth / 2)) / zoom,
		scale,
		up: applied.up + (insets.top + roomHeight / 2 - middleY) / zoom,
	};
}

/** A box in px (viewport or canvas coordinates). */
export interface PxBox {
	bottom: number;
	left: number;
	right: number;
	top: number;
}

/**
 * A plate's FitBox, in canvas px: anchored at `anchor` (drei's root for the
 * plate, viewport px), or at the plate's own centre without one, and
 * reaching as far as `reach` (the plate and its bubble), with its separation
 * nudge taken back out.
 */
export function plateFitBox({
	anchor,
	canvas,
	nudge,
	plate,
	reach,
}: {
	anchor: readonly [number, number] | null;
	canvas: { left: number; top: number };
	nudge: readonly [number, number];
	plate: PxBox;
	reach: PxBox;
}): FitBox {
	const [dx, dy] = nudge;
	const x = anchor ? anchor[0] : (plate.left + plate.right) / 2 - dx;
	const y = anchor ? anchor[1] : (plate.top + plate.bottom) / 2 - dy;
	return {
		bottom: reach.bottom - dy - y,
		left: reach.left - dx - x,
		right: reach.right - dx - x,
		top: reach.top - dy - y,
		x: x - canvas.left,
		y: y - canvas.top,
	};
}

/** Below this stage height a stage is cramped (squeezed beside a thread view). */
export const CRAMPED_STAGE = 480;
