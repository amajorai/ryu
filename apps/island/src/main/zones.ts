// Snap-zone geometry for the island's drag-to-snap feature.
//
// The work area of a display is divided into a 3x3 grid of nine zones (the four
// corners, the four edge-midpoints, and the center). While the user drags the
// island, an overlay draws these zones; on release the window snaps to the
// anchor position of whichever zone its center landed in.
//
// Everything here is pure: it takes plain rectangles (never the `screen`/Display
// objects) so it is trivially unit-testable. `win.ts` feeds it `Display.workArea`.

/** Default resting snap zone on first launch (8 = bottom-right). */
export const DEFAULT_DOCK_ZONE = 8;

/** An axis-aligned rectangle in screen coordinates. */
export interface Rect {
	height: number;
	width: number;
	x: number;
	y: number;
}

/** A 2D point in screen coordinates. */
export interface Point {
	x: number;
	y: number;
}

/** Number of rows/columns in the snap grid (3x3 = nine zones). */
const GRID = 3;

/**
 * How close (in screen pixels) the island's center must be to a zone's landing
 * anchor for that zone to "grab" it. Inside this radius the island snaps to the
 * zone on release; outside every zone's radius the drag is free (the island stays
 * exactly where it was dropped). A tunable feel knob — bigger = stickier snapping,
 * smaller = more free placement.
 */
export const SNAP_THRESHOLD_PX = 140;

/** Clamp `value` into the inclusive `[min, max]` range. */
function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

/**
 * Split a work area into nine equal cells, row-major (index 0 = top-left,
 * 4 = center, 8 = bottom-right). The cells tile the area with no gaps, so every
 * point inside the area maps to exactly one zone (see {@link zoneIndexForPoint}).
 */
export function computeZoneCells(area: Rect): Rect[] {
	const colWidth = area.width / GRID;
	const rowHeight = area.height / GRID;
	const cells: Rect[] = [];
	for (let row = 0; row < GRID; row++) {
		for (let col = 0; col < GRID; col++) {
			cells.push({
				x: Math.round(area.x + col * colWidth),
				y: Math.round(area.y + row * rowHeight),
				width: Math.round(colWidth),
				height: Math.round(rowHeight),
			});
		}
	}
	return cells;
}

/**
 * Which of the nine zones a point falls into. Points outside the area clamp to
 * the nearest edge zone, so a window dragged slightly offscreen still resolves
 * to a sensible target.
 */
export function zoneIndexForPoint(area: Rect, point: Point): number {
	const colWidth = area.width / GRID;
	const rowHeight = area.height / GRID;
	const col = clamp(Math.floor((point.x - area.x) / colWidth), 0, GRID - 1);
	const row = clamp(Math.floor((point.y - area.y) / rowHeight), 0, GRID - 1);
	return row * GRID + col;
}

/**
 * The result of testing where a drag would snap: the nearest zone, the distance
 * from the island center to that zone's landing anchor, and whether that distance
 * is within {@link SNAP_THRESHOLD_PX} (i.e. the island should snap there rather
 * than be left free).
 */
export interface SnapResult {
	distance: number;
	index: number;
	withinRange: boolean;
}

/**
 * Pick the zone whose landing anchor is closest to `center` (the island's visible
 * center), and decide whether the island is close enough to snap. The anchor for
 * each zone is where the island's contour would land if snapped there
 * ({@link zoneAnchorPosition}); we measure to that anchor's center, so a drag only
 * snaps when it is genuinely near a dock position — anywhere else stays free.
 *
 * Pure (no `screen`/Display objects) so the snap-vs-free boundary is unit-testable.
 */
export function nearestSnapZone(
	area: Rect,
	center: Point,
	pill: { height: number; width: number },
	margin: number,
	threshold: number
): SnapResult {
	let bestIndex = 0;
	let bestDist = Number.POSITIVE_INFINITY;
	for (let index = 0; index < GRID * GRID; index++) {
		const anchor = zoneAnchorPosition(
			area,
			index,
			pill.width,
			pill.height,
			margin
		);
		const ax = anchor.x + pill.width / 2;
		const ay = anchor.y + pill.height / 2;
		const dx = center.x - ax;
		const dy = center.y - ay;
		const dist = Math.hypot(dx, dy);
		if (dist < bestDist) {
			bestDist = dist;
			bestIndex = index;
		}
	}
	return {
		index: bestIndex,
		distance: bestDist,
		withinRange: bestDist <= threshold,
	};
}

/** Anchor a length along one axis: start, centered, or end (with a margin). */
function axisAnchor(
	slot: number,
	areaStart: number,
	areaLength: number,
	winLength: number,
	margin: number
): number {
	if (slot === 0) {
		return areaStart + margin;
	}
	if (slot === GRID - 1) {
		return areaStart + areaLength - winLength - margin;
	}
	return areaStart + (areaLength - winLength) / 2;
}

/**
 * The top-left window position that snaps a `winWidth`x`winHeight` window into
 * the given zone: corners hug the corner (inset by `margin`), edge zones center
 * along that edge, and the center zone centers in the work area. The result is
 * clamped so the window never lands partly offscreen on small displays.
 */
export function zoneAnchorPosition(
	area: Rect,
	index: number,
	winWidth: number,
	winHeight: number,
	margin: number
): Point {
	const col = index % GRID;
	const row = Math.floor(index / GRID);
	const x = axisAnchor(col, area.x, area.width, winWidth, margin);
	const y = axisAnchor(row, area.y, area.height, winHeight, margin);
	const maxX = area.x + area.width - winWidth;
	const maxY = area.y + area.height - winHeight;
	return {
		x: Math.round(clamp(x, area.x, Math.max(area.x, maxX))),
		y: Math.round(clamp(y, area.y, Math.max(area.y, maxY))),
	};
}

/** Squared distance from a point to the nearest edge of a rect (0 if inside). */
function squaredDistanceToRect(point: Point, rect: Rect): number {
	const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
	const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
	return dx * dx + dy * dy;
}

/**
 * The work area nearest a point: the one containing it, else the closest by edge
 * distance. `areas` must be non-empty (callers pass every display's work area).
 */
export function nearestArea(point: Point, areas: Rect[]): Rect {
	let best = areas[0];
	let bestDist = squaredDistanceToRect(point, best);
	for (let i = 1; i < areas.length; i++) {
		const dist = squaredDistanceToRect(point, areas[i]);
		if (dist < bestDist) {
			best = areas[i];
			bestDist = dist;
		}
	}
	return best;
}
