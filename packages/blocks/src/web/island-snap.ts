/*
 * Pure 3x3 snap-zone math for the web demo Island, mirrored from the real app's
 * `apps/island/src/main/zones.ts`. Zones are numeric indices 0-8, row-major:
 *   0 top-left    1 top-center    2 top-right
 *   3 mid-left    4 center        5 mid-right
 *   6 bottom-left 7 bottom-center 8 bottom-right
 * In the desktop app the math runs on an oversized transparent window with the
 * visible pill offset inside it; in a pure-DOM page the "pill" offset is 0 and the
 * "area" is the viewport, so the window/anchor positions collapse to one value.
 */

export interface Point {
	x: number;
	y: number;
}
export interface Rect {
	height: number;
	width: number;
	x: number;
	y: number;
}
export interface Pill {
	height: number;
	width: number;
}
export interface SnapResult {
	distance: number;
	index: number;
	withinRange: boolean;
}

export const GRID = 3;
/** Radius in px from the island center to a zone anchor center that triggers a snap. */
export const SNAP_THRESHOLD_PX = 140;
/** Inset from the work-area edge for corner/edge zones (non-macOS default). */
export const EDGE_MARGIN_PX = 20;

const clamp = (value: number, min: number, max: number): number =>
	Math.min(Math.max(value, min), max);

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

/** Top-left where the visible pill lands for a given zone index. */
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

/** Nearest zone to the island center, measured against each zone's anchor center. */
export function nearestSnapZone(
	area: Rect,
	center: Point,
	pill: Pill,
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

/**
 * Clamp a footprint's top-left so the whole box stays inside the work area minus
 * margin, shifting (never resizing) it inward. Mirrors `placeFootprint`: a panel
 * near the right/bottom edge is pulled in so it opens inward instead of off-screen.
 */
export function clampFootprint(
	topLeft: Point,
	content: Pill,
	area: Rect,
	margin: number
): Point {
	const minX = area.x + margin;
	const minY = area.y + margin;
	const maxX = area.x + area.width - content.width - margin;
	const maxY = area.y + area.height - content.height - margin;
	return {
		x: Math.round(clamp(topLeft.x, minX, Math.max(minX, maxX))),
		y: Math.round(clamp(topLeft.y, minY, Math.max(minY, maxY))),
	};
}
