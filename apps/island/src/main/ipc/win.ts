import { type BrowserWindow, ipcMain, screen } from "electron";
import {
	type ContentSizePayload,
	type IslandMaterialContour,
	type MoveByPayload,
	type SetMouseCapturePayload,
	WIN_CHANNELS,
} from "../../shared/ipc.ts";
import { notchWindowRect } from "../../shared/notch.ts";
import { isIslandPlacement } from "../../shared/placement.ts";
import { rectCenter, type Size } from "../anchor.ts";
import { getEdgeOffset } from "../edge-offset.ts";
import { applyMaterialMask } from "../material-mask.ts";
import { getNotchGeometry } from "../notch.ts";
import {
	destroyZoneOverlay,
	hideZoneOverlay,
	setActiveZone,
	showZoneOverlay,
} from "../overlay.ts";
import { positionerFor } from "../positioner.ts";
import { raiseWindow } from "../visibility.ts";
import {
	nearestSnapZone,
	type Rect,
	SNAP_THRESHOLD_PX,
	zoneAnchorPosition,
} from "../zones.ts";

/**
 * Per window: whether its island sits at the resting dock. Set by
 * {@link registerWinIpc} from the renderer's footprint reports and the
 * window's positioner.
 */
const restingQueries = new WeakMap<BrowserWindow, () => boolean>();

/**
 * Whether the island in `win` is at rest: it is not being dragged, and its
 * latest footprint is not the expanded panel and has not been shifted off its
 * anchor to stay on-screen. Only then does the window sit where the resting
 * geometry says, so only then may auto-jump relocate it. A window with no
 * footprint report yet counts as at rest.
 */
export function isIslandAtRest(win: BrowserWindow): boolean {
	return restingQueries.get(win)?.() ?? true;
}

/** Live state for the in-flight drag gesture. Null when not dragging. */
interface DragState {
	area: Rect;
	/** Id of the display whose work area `area` belongs to. */
	displayId: number;
	/** The island footprint being dragged (the whole group, not one shape). */
	footprint: Size;
	/** An island-shaped outline at each of the nine snap spots (overlay ghosts). */
	ghosts: Rect[];
	/**
	 * The zone the drag will snap to on release, or `null` when the island is far
	 * from every zone and should be left exactly where it was dropped (free).
	 */
	snapZone: number | null;
}

/**
 * Register the window-control IPC channels for a window. The renderer drives
 * these from pointer events on the island element; all positioning is delegated
 * to the window's {@link import("../positioner.ts").IslandPositioner}.
 *
 * - `win:setMouseCapture` toggles click-through. Everything outside the island
 *   shape is click-through, so we capture only while the pointer is over it.
 * - `win:dragStart` / `win:moveBy` / `win:dragEnd` implement a manual,
 *   pointer-based drag that snaps the *whole island footprint* to a 3x3 grid of
 *   screen zones: the overlay appears on drag start, follows the nearest zone on
 *   move, and on release the island is re-anchored (and persisted) there.
 * - `win:setContentSize` reports the visible footprint. The positioner pins it
 *   to the island's anchor and shifts it to stay on the display.
 * - `win:placementApplied` acknowledges that the renderer re-aligned to a new
 *   placement, so the translucent window can move without a misaligned frame.
 */
export function registerWinIpc(win: BrowserWindow, acrylic = false): void {
	let drag: DragState | null = null;
	const positioner = positionerFor(win);

	/** Screen-space center of the dragged footprint, following the window. */
	const footprintCenter = () =>
		rectCenter(positioner?.liveRect() ?? win.getBounds());

	// Whether the latest footprint report was the expanded panel.
	let expanded = false;
	restingQueries.set(
		win,
		() =>
			drag === null && !expanded && !(positioner?.isShiftedOffAnchor() ?? false)
	);

	/** Screen-space rect the footprint will snap to for the given zone. */
	const ghostRect = (state: DragState, zone: number): Rect => ({
		...zoneAnchorPosition(
			state.area,
			zone,
			state.footprint.width,
			state.footprint.height,
			getEdgeOffset()
		),
		...state.footprint,
	});

	/**
	 * The zone the island would snap to *if close enough*, else `null` (free). Uses
	 * the distance from the footprint center to each zone's landing spot, so the
	 * island only snaps when dragged near a dock spot -- anywhere else stays put.
	 */
	const resolveSnapZone = (state: DragState): number | null => {
		const result = nearestSnapZone(
			state.area,
			footprintCenter(),
			state.footprint,
			getEdgeOffset(),
			SNAP_THRESHOLD_PX
		);
		return result.withinRange ? result.index : null;
	};

	/** An island-shaped outline at every one of the nine snap spots. */
	const allGhosts = (state: DragState): Rect[] =>
		Array.from({ length: 9 }, (_unused, zone) => ghostRect(state, zone));

	/** Index of the active snap target for the overlay (`-1` = free, none). */
	const activeIndex = (state: DragState): number => state.snapZone ?? -1;

	ipcMain.on(
		WIN_CHANNELS.setMouseCapture,
		(_event, payload: SetMouseCapturePayload) => {
			if (win.isDestroyed()) {
				return;
			}
			// capture === true  -> normal mouse handling (ignore = false)
			// capture === false -> click-through, forwarding move events so the
			// renderer still receives pointerenter to re-capture.
			win.setIgnoreMouseEvents(!payload.capture, { forward: true });
		}
	);

	ipcMain.on(
		WIN_CHANNELS.setContentSize,
		(_event, payload: ContentSizePayload) => {
			if (win.isDestroyed()) {
				return;
			}
			const { width, height } = payload;
			if (width <= 0 || height <= 0) {
				return;
			}
			expanded = payload.expanded;
			const notch = getNotchGeometry();
			if (notch) {
				win.setBounds(notchWindowRect(notch, width, height));
				return;
			}
			const rect = positioner?.setFootprint({ width, height });
			if (acrylic && rect) {
				applyMaterialMask(win, rect.width, rect.height, payload.shapes);
			}
		}
	);

	ipcMain.on(WIN_CHANNELS.placementApplied, (_event, placement: unknown) => {
		if (isIslandPlacement(placement)) {
			positioner?.commitPlacement(placement);
		}
	});

	ipcMain.on(
		WIN_CHANNELS.setMaterialShapes,
		(_event, contours: IslandMaterialContour[]) => {
			if (!acrylic || getNotchGeometry() || win.isDestroyed()) {
				return;
			}
			const [width, height] = win.getContentSize();
			applyMaterialMask(win, width, height, contours);
		}
	);

	ipcMain.on(WIN_CHANNELS.dragStart, () => {
		if (getNotchGeometry() || win.isDestroyed() || !positioner) {
			return;
		}
		// A drag wins over any in-flight footprint glide or placement change.
		positioner.beginDrag();
		const display = screen.getDisplayNearestPoint(footprintCenter());
		drag = {
			area: display.workArea,
			footprint: positioner.footprintSize(),
			ghosts: [],
			displayId: display.id,
			snapZone: null,
		};
		drag.ghosts = allGhosts(drag);
		drag.snapZone = resolveSnapZone(drag);
		showZoneOverlay(display, drag.ghosts, activeIndex(drag));
		// The overlay is topmost; keep the dragged island above it.
		raiseWindow(win);
	});

	ipcMain.on(WIN_CHANNELS.moveBy, (_event, payload: MoveByPayload) => {
		if (win.isDestroyed()) {
			return;
		}
		const [x, y] = win.getPosition();
		win.setPosition(Math.round(x + payload.dx), Math.round(y + payload.dy));
		if (!drag) {
			return;
		}
		const center = footprintCenter();
		// Follow the island across monitors: snap zones live on whichever display
		// the island now sits over, not the one the drag started on. Without this
		// the snap outlines stay stranded on the origin display and the island can
		// never be snapped onto another monitor.
		const display = screen.getDisplayNearestPoint(center);
		if (display.id !== drag.displayId) {
			drag.displayId = display.id;
			drag.area = display.workArea;
			drag.ghosts = allGhosts(drag);
			drag.snapZone = resolveSnapZone(drag);
			showZoneOverlay(display, drag.ghosts, activeIndex(drag));
			// Re-showing the overlay raises it; keep the dragged island above it.
			raiseWindow(win);
			return;
		}
		const zone = resolveSnapZone(drag);
		if (zone !== drag.snapZone) {
			drag.snapZone = zone;
			setActiveZone(activeIndex(drag));
		}
	});

	ipcMain.on(WIN_CHANNELS.dragEnd, () => {
		if (win.isDestroyed()) {
			return;
		}
		hideZoneOverlay();
		const state = drag;
		drag = null;
		if (!state) {
			return;
		}
		// Re-anchor where it landed: near a zone it docks there; anywhere else it
		// stays put and takes the placement of the zone it was dropped in.
		positioner?.drop(state.area, state.snapZone);
	});

	// Re-home on display layout changes so the island never strands offscreen
	// when a monitor is unplugged or the resolution changes.
	const rehome = (): void => {
		positioner?.rehome();
	};
	screen.on("display-metrics-changed", rehome);
	screen.on("display-removed", rehome);

	win.on("closed", () => {
		ipcMain.removeAllListeners(WIN_CHANNELS.setMouseCapture);
		ipcMain.removeAllListeners(WIN_CHANNELS.setContentSize);
		ipcMain.removeAllListeners(WIN_CHANNELS.setMaterialShapes);
		ipcMain.removeAllListeners(WIN_CHANNELS.placementApplied);
		ipcMain.removeAllListeners(WIN_CHANNELS.dragStart);
		ipcMain.removeAllListeners(WIN_CHANNELS.moveBy);
		ipcMain.removeAllListeners(WIN_CHANNELS.dragEnd);
		screen.removeListener("display-metrics-changed", rehome);
		screen.removeListener("display-removed", rehome);
		destroyZoneOverlay();
	});
}
