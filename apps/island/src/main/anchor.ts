// Anchor geometry for the island's popover-style positioning.
//
// The island never stores "where the window is". It stores an *anchor*: a point
// on screen plus a placement saying which point of the island's footprint sits on
// it (see `shared/placement.ts`). Every footprint -- the resting pill, the
// suggestion chip, the tall chat panel -- is laid out from that one anchor, then
// shifted (never resized) to stay on the display, the way a popover's `shift`
// middleware keeps it in the viewport. The shift is never written back to the
// anchor, so collapsing always returns to exactly where the island was docked,
// and dragging the expanded panel into a corner leaves the collapsed pill in that
// same corner.
//
// Everything here is pure: plain rectangles, no `screen`/Display objects, so the
// edge/corner math is unit-testable. `positioner.ts` feeds it live display data.

import {
	type IslandAlign,
	type IslandPlacement,
	placementForZone,
	type TRANSLUCENT_WINDOW_INSET,
	zoneForPlacement,
} from "../shared/placement.ts";
import {
	nearestArea,
	type Point,
	type Rect,
	zoneAnchorPosition,
	zoneIndexForPoint,
} from "./zones.ts";

/** A width/height pair in screen pixels. */
export interface Size {
	height: number;
	width: number;
}

/** A screen point the island footprint is pinned to, and how it is pinned. */
export interface IslandAnchor extends Point {
	placement: IslandPlacement;
}

/** Window insets around the aligned island group (translucent appearance). */
export type WindowInset = typeof TRANSLUCENT_WINDOW_INSET;

/**
 * The resting island footprint: the logo circle (40) + split gap (8) + idle
 * detail pill (96) = 144 wide, 40 tall. Used wherever a decision must not depend
 * on the island's current (possibly expanded) size, e.g. "is this anchor on a
 * display?" or the first window placement before the renderer reports.
 */
export const RESTING_FOOTPRINT: Size = { width: 144, height: 40 };

/**
 * The fixed translucent window. It must hold the largest footprint (the expanded
 * chat, 448x480 with its logo) plus the alignment insets, so the shapes' drop
 * shadows are never clipped. Everything outside the island is click-through.
 */
export const TRANSLUCENT_WINDOW_SIZE: Size = { width: 600, height: 620 };

/** Offset of an aligned point from a span's start: 0, half, or the full length. */
function alignOffset(align: IslandAlign, length: number): number {
	if (align === "start") {
		return 0;
	}
	if (align === "center") {
		return length / 2;
	}
	return length;
}

/** Clamp `value` into `[min, max]`, preferring `min` when the range is empty. */
function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}

/** Center point of a rect. */
export function rectCenter(rect: Rect): Point {
	return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** The anchor that pins `rect` at the point `placement` names. */
export function anchorOf(rect: Rect, placement: IslandPlacement): IslandAnchor {
	return {
		x: rect.x + alignOffset(placement.h, rect.width),
		y: rect.y + alignOffset(placement.v, rect.height),
		placement,
	};
}

/** The (unshifted) footprint rect of `size` pinned to `anchor`, in whole pixels. */
export function rectAt(anchor: IslandAnchor, size: Size): Rect {
	return {
		x: Math.round(anchor.x - alignOffset(anchor.placement.h, size.width)),
		y: Math.round(anchor.y - alignOffset(anchor.placement.v, size.height)),
		width: Math.round(size.width),
		height: Math.round(size.height),
	};
}

/**
 * Shift (never resize) `rect` so it lies inside `area` inset by `margin`. A rect
 * larger than the inset area pins to its top/left, so the island's head (logo and
 * header) stays reachable. Returns an equal rect when it already fits.
 */
export function shiftInto(rect: Rect, area: Rect, margin: number): Rect {
	const minX = area.x + margin;
	const minY = area.y + margin;
	const maxX = area.x + area.width - rect.width - margin;
	const maxY = area.y + area.height - rect.height - margin;
	return {
		x: Math.round(clamp(rect.x, minX, maxX)),
		y: Math.round(clamp(rect.y, minY, maxY)),
		width: rect.width,
		height: rect.height,
	};
}

/**
 * Where a footprint of `size` renders for `anchor`: pinned to the anchor, then
 * shifted onto `area` (inset by `margin`). This is the popover `placement` +
 * `shift` pair; the anchor is untouched, so a later smaller footprint returns to
 * the pinned spot with no drift.
 */
export function placeAtAnchor(
	anchor: IslandAnchor,
	size: Size,
	area: Rect,
	margin: number
): Rect {
	return shiftInto(rectAt(anchor, size), area, margin);
}

/** Offset of the aligned group's top-left inside a window (per axis). */
function groupOffset(
	align: IslandAlign,
	windowLength: number,
	groupLength: number,
	insetStart: number,
	insetEnd: number
): number {
	const free = windowLength - insetStart - insetEnd - groupLength;
	return insetStart + alignOffset(align, free);
}

/**
 * The window top-left that lands an island group aligned by `placement` inside a
 * fixed `windowSize` window (padded by `inset`, mirroring the renderer's layout)
 * exactly on `rect`.
 */
export function windowOriginFor(
	rect: Rect,
	placement: IslandPlacement,
	windowSize: Size,
	inset: WindowInset
): Point {
	return {
		x: Math.round(
			rect.x -
				groupOffset(
					placement.h,
					windowSize.width,
					rect.width,
					inset.left,
					inset.right
				)
		),
		y: Math.round(
			rect.y -
				groupOffset(
					placement.v,
					windowSize.height,
					rect.height,
					inset.top,
					inset.bottom
				)
		),
	};
}

/**
 * Where a `size` group aligned by `placement` currently sits on screen, given the
 * window's top-left (inverse of {@link windowOriginFor}). Used to read the
 * footprint's live position while the user drags the window.
 */
export function groupRectInWindow(
	origin: Point,
	windowSize: Size,
	size: Size,
	placement: IslandPlacement,
	inset: WindowInset
): Rect {
	return {
		x: Math.round(
			origin.x +
				groupOffset(
					placement.h,
					windowSize.width,
					size.width,
					inset.left,
					inset.right
				)
		),
		y: Math.round(
			origin.y +
				groupOffset(
					placement.v,
					windowSize.height,
					size.height,
					inset.top,
					inset.bottom
				)
		),
		width: Math.round(size.width),
		height: Math.round(size.height),
	};
}

/**
 * The anchor that docks the island in the snap zone `placement` names on `area`:
 * corners/edges pin to the edge inset by `margin`, centered axes to the middle.
 * Independent of the footprint size except on displays too small to hold it.
 */
export function dockedAnchor(
	area: Rect,
	placement: IslandPlacement,
	size: Size,
	margin: number
): IslandAnchor {
	const topLeft = zoneAnchorPosition(
		area,
		zoneForPlacement(placement),
		size.width,
		size.height,
		margin
	);
	return anchorOf({ ...topLeft, ...size }, placement);
}

/**
 * The anchor for a footprint the user dropped at `rect` on `area`.
 *
 * - Near a snap zone (`snapZone`): the footprint docks to that zone and takes the
 *   zone's placement.
 * - Free drop: the footprint stays where it was dropped (shifted onto the area if
 *   it hangs off an edge or a monitor seam), and its placement comes from the
 *   zone its center landed in -- so an island dropped in the lower-right third
 *   still grows up and to the left, like a popover flipping away from the edge.
 */
export function anchorForDrop(
	area: Rect,
	rect: Rect,
	snapZone: number | null,
	margin: number
): IslandAnchor {
	if (snapZone !== null) {
		const placement = placementForZone(snapZone);
		const topLeft = zoneAnchorPosition(
			area,
			snapZone,
			rect.width,
			rect.height,
			margin
		);
		return anchorOf(
			{ ...topLeft, width: rect.width, height: rect.height },
			placement
		);
	}
	const kept = shiftInto(rect, area, margin);
	const placement = placementForZone(zoneIndexForPoint(area, rectCenter(kept)));
	return anchorOf(kept, placement);
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
 * Keep an anchor usable after the display layout changed (or when restoring one
 * from disk): if the resting island pinned there sits wholly on some display it
 * is kept as-is; otherwise -- a monitor was unplugged, the resolution shrank, or
 * the island straddles a seam -- it re-docks to the same zone on the nearest
 * display. Tested with the resting footprint so an expanded panel's size never
 * decides whether the dock itself is valid.
 */
export function fitAnchor(
	anchor: IslandAnchor,
	areas: Rect[],
	margin: number
): IslandAnchor {
	if (areas.length === 0) {
		return anchor;
	}
	const resting = rectAt(anchor, RESTING_FOOTPRINT);
	if (areas.some((area) => boxWithinArea(resting, area))) {
		return anchor;
	}
	const area = nearestArea(rectCenter(resting), areas);
	return dockedAnchor(area, anchor.placement, RESTING_FOOTPRINT, margin);
}

/**
 * Convert a position persisted by older builds (the window's top-left, with the
 * resting island centered in the translucent window `topInset` below its top, or
 * filling the material window) into an anchor, inferring the placement from the
 * zone the island rests in.
 */
export function legacyAnchor(
	windowOrigin: Point,
	material: boolean,
	areas: Rect[]
): IslandAnchor {
	const legacyTopInset = 8;
	const rect: Rect = material
		? { ...windowOrigin, ...RESTING_FOOTPRINT }
		: {
				x:
					windowOrigin.x +
					(TRANSLUCENT_WINDOW_SIZE.width - RESTING_FOOTPRINT.width) / 2,
				y: windowOrigin.y + legacyTopInset,
				...RESTING_FOOTPRINT,
			};
	const center = rectCenter(rect);
	const zone =
		areas.length > 0
			? zoneIndexForPoint(nearestArea(center, areas), center)
			: 0;
	return anchorOf(rect, placementForZone(zone));
}
