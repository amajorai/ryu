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

/**
 * New window bounds that keep the island's top-center anchor fixed while the
 * content footprint changes (acrylic appearance, where the window *is* the
 * island). The top edge stays put; the window grows/shrinks symmetrically about
 * its horizontal center, the way a real dynamic island does.
 */
export function topCenteredBounds(
	currentX: number,
	currentWidth: number,
	currentY: number,
	nextWidth: number,
	nextHeight: number
): Rect {
	const centerX = currentX + currentWidth / 2;
	return {
		x: Math.round(centerX - nextWidth / 2),
		y: Math.round(currentY),
		width: Math.round(nextWidth),
		height: Math.round(nextHeight),
	};
}

/**
 * The natural (unclamped) on-screen rect for an island footprint of size
 * `content`, anchored to the resting island (`anchor`): centered on the anchor's
 * horizontal center and with its top at the anchor's top. This is where the
 * footprint *wants* to render before any edge correction.
 */
export function naturalFootprintRect(
	anchor: Rect,
	content: { height: number; width: number }
): Rect {
	return {
		x: Math.round(anchor.x + anchor.width / 2 - content.width / 2),
		y: Math.round(anchor.y),
		width: Math.round(content.width),
		height: Math.round(content.height),
	};
}

/**
 * Where an island footprint should sit on screen so it stays fully visible,
 * given the resting island (`anchor`) it grows out of. The footprint is anchored
 * to the anchor's horizontal center with its top at the anchor's top
 * ({@link naturalFootprintRect}), then **shifted** (never resized) so it lies
 * wholly inside the work area minus `margin`: an island near the right/left edge
 * is pulled in horizontally, and one near the bottom edge is pulled **up** (so a
 * bottom-docked panel grows upward instead of running off the lower edge).
 * Degrades gracefully when the footprint is larger than the work area (clamps to
 * the top-left inset). Returns the unchanged natural rect when it already fits,
 * so the common (non-edge) case is a pixel-exact no-op.
 *
 * Pure (plain rectangles, no `screen`/Display objects) so the edge math is
 * unit-testable, matching the rest of this module. Used for every island state,
 * not just the expanded panel.
 */
export function placeFootprint(
	anchor: Rect,
	content: { height: number; width: number },
	area: Rect,
	margin: number
): Rect {
	const natural = naturalFootprintRect(anchor, content);
	const minX = area.x + margin;
	const minY = area.y + margin;
	const maxX = area.x + area.width - content.width - margin;
	const maxY = area.y + area.height - content.height - margin;
	return {
		x: clamp(natural.x, minX, Math.max(minX, maxX)),
		y: clamp(natural.y, minY, Math.max(minY, maxY)),
		width: natural.width,
		height: natural.height,
	};
}

/**
 * The visible island shape's geometry inside its (oversized) window: `offsetX`/
 * `offsetY` are the shape's top-left relative to the window origin, and
 * `width`/`height` its size. Used so snapping aligns the pill, not the window.
 */
export interface PillRect {
	height: number;
	offsetX: number;
	offsetY: number;
	width: number;
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
 * each zone is where the island's shape would land if snapped there
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

/** Whether `box` lies entirely within `area`. */
function boxWithinArea(box: Rect, area: Rect): boolean {
	return (
		box.x >= area.x &&
		box.y >= area.y &&
		box.x + box.width <= area.x + area.width &&
		box.y + box.height <= area.y + area.height
	);
}

/**
 * The visible-island geometry inside its (possibly oversized) window: the island
 * is centered horizontally and pinned `topInset` below the window top.
 */
export interface VisibleIsland {
	height: number;
	topInset: number;
	width: number;
	/** Full window width; the island is centered within it. */
	windowWidth: number;
}

/**
 * Keep the *visible island* (not the oversized window) wholly on one display.
 *
 * The translucent window is far wider than the island and overflows the screen
 * by design, so testing a window corner -- or even the window's center point --
 * gives false positives. The worst case is a multi-monitor seam: an island
 * dragged to x=-242 in a [-2560,0]+[0,2560] layout has its center at x=-32,
 * which a single-point test reads as "on the left display" while the island
 * actually straddles the bezel gap and is invisible. This tests the island's
 * full box: if it fits on some display, the window position is kept as-is
 * (edge/corner snaps where only the transparent window overflows survive);
 * otherwise the window is re-homed to the top-center of the nearest display.
 */
export function fitVisibleIsland(
	win: Point,
	island: VisibleIsland,
	topMargin: number,
	areas: Rect[]
): Point {
	const kept = { x: Math.round(win.x), y: Math.round(win.y) };
	if (areas.length === 0) {
		return kept;
	}
	const box: Rect = {
		x: win.x + (island.windowWidth - island.width) / 2,
		y: win.y + island.topInset,
		width: island.width,
		height: island.height,
	};
	if (areas.some((area) => boxWithinArea(box, area))) {
		return kept;
	}
	const center: Point = {
		x: box.x + box.width / 2,
		y: box.y + box.height / 2,
	};
	const area = nearestArea(center, areas);
	return {
		x: Math.round(area.x + (area.width - island.windowWidth) / 2),
		y: Math.round(area.y + topMargin),
	};
}

/**
 * The window top-left that snaps the *visible island shape* into `index`'s zone:
 * first the shape's target position is computed (corners hug the edge inset by
 * `margin`, edges/center are centered), then the window is offset so the shape
 * lands there. The window itself may overflow the screen edge -- that is fine,
 * it is transparent and click-through outside the shape.
 */
export function zoneWindowPosition(
	area: Rect,
	index: number,
	pill: PillRect,
	margin: number
): Point {
	const shape = zoneAnchorPosition(
		area,
		index,
		pill.width,
		pill.height,
		margin
	);
	return {
		x: Math.round(shape.x - pill.offsetX),
		y: Math.round(shape.y - pill.offsetY),
	};
}

/**
 * Re-dock the island onto a different display while preserving the zone it is
 * resting in. Used by the "auto-jump to active monitor" feature: given the island's
 * current visible center and the work areas of its current and the target display,
 * it works out which of the nine zones the island occupies on its current display
 * and returns the window position that lands it in the *same* zone on the target
 * display (so an island parked top-center stays top-center after the jump).
 *
 * Pure (plain rectangles, no `screen`/Display objects) so the cross-seam math is
 * unit-testable; {@link import("./position.ts").moveToActiveDisplay} is the thin
 * Electron wrapper that feeds it live cursor + display data.
 */
export function crossDisplayPosition(
	currentArea: Rect,
	targetArea: Rect,
	center: Point,
	pill: PillRect,
	margin: number
): Point {
	const zone = zoneIndexForPoint(currentArea, center);
	return zoneWindowPosition(targetArea, zone, pill, margin);
}
