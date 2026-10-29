import { type BrowserWindow, screen } from "electron";
import { placementForZone } from "../shared/placement.ts";
import {
	dockedAnchor,
	fitAnchor,
	type IslandAnchor,
	legacyAnchor,
	RESTING_FOOTPRINT,
} from "./anchor.ts";
import { getEdgeOffset } from "./edge-offset.ts";
import { getNotchGeometry } from "./notch.ts";
import { readStoredPosition } from "./position-store.ts";
import { positionerFor } from "./positioner.ts";
import { DEFAULT_DOCK_ZONE } from "./zones.ts";

/**
 * The anchor a freshly created island window starts from: the persisted one
 * (converted from an older window-origin record if needed), kept only while it
 * still lands on a connected display -- otherwise re-docked to the same zone on
 * the nearest display. With nothing persisted, the island docks to the default
 * zone (bottom-right) of the primary display.
 */
export function initialAnchor(material: boolean): IslandAnchor {
	const areas = screen.getAllDisplays().map((display) => display.workArea);
	const stored = readStoredPosition();
	if (stored) {
		const anchor =
			stored.kind === "anchor"
				? stored.anchor
				: legacyAnchor(stored.origin, material, areas);
		return fitAnchor(anchor, areas, getEdgeOffset());
	}
	return dockedAnchor(
		screen.getPrimaryDisplay().workArea,
		placementForZone(DEFAULT_DOCK_ZONE),
		RESTING_FOOTPRINT,
		getEdgeOffset()
	);
}

/**
 * Re-dock the island to the edge offset currently in {@link getEdgeOffset}.
 *
 * The snap inset only takes effect during a drag, so a live offset change would
 * otherwise not move a docked island until the user dragged it again. The
 * island's placement already names the zone it docks to, so this re-pins it to
 * that zone with the new offset. Centered axes are offset-independent, so an
 * island parked in the middle simply stays put.
 */
export function applyEdgeOffset(win: BrowserWindow): void {
	positionerFor(win)?.redock();
}

/**
 * Whether the island already sits on the display the user is active on (the one
 * under the cursor). The auto-jump loop polls this to debounce: it only counts
 * toward a jump while the cursor is genuinely on another monitor. A single-monitor
 * setup always returns `true`, so the feature is a no-op there.
 */
export function isIslandOnActiveDisplay(win: BrowserWindow): boolean {
	const positioner = positionerFor(win);
	if (getNotchGeometry() || !positioner || win.isDestroyed()) {
		return true;
	}
	const active = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
	return positioner.display().id === active.id;
}

/**
 * Move the island onto the display the user is currently active on (the one
 * under the cursor), keeping the zone it is docked in. Backs the "auto-jump to
 * active monitor" preference.
 *
 * No-op (returns `false`) when the island is already on the active display, so a
 * single-monitor setup never moves and the poll loop never churns position writes.
 * Returns `true` when it actually moved.
 */
export function moveToActiveDisplay(win: BrowserWindow): boolean {
	if (isIslandOnActiveDisplay(win)) {
		return false;
	}
	const positioner = positionerFor(win);
	if (!positioner) {
		return false;
	}
	positioner.redock(
		screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
	);
	return true;
}
