import { type BrowserWindow, ipcMain, screen } from "electron";
import {
	type ContentSizePayload,
	type DragStartPayload,
	type MoveByPayload,
	type SetMouseCapturePayload,
	WIN_CHANNELS,
} from "../../shared/ipc.ts";
import { getEdgeOffset } from "../edge-offset.ts";
import {
	destroyZoneOverlay,
	hideZoneOverlay,
	setActiveZone,
	showZoneOverlay,
} from "../overlay.ts";
import {
	ensureOnScreen,
	restingPill,
	writeStoredPosition,
} from "../position.ts";
import {
	naturalFootprintRect,
	nearestSnapZone,
	type PillRect,
	type Point,
	placeFootprint,
	type Rect,
	SNAP_THRESHOLD_PX,
	zoneAnchorPosition,
	zoneWindowPosition,
} from "../zones.ts";

/**
 * Top inset of the island content inside the translucent window: the content is
 * pinned `pt-2` (8px) below the window top and horizontally centered (mirrors
 * `renderer/components/Island.tsx`). Used to map a target content rect back to a
 * window position for the fixed-size translucent window.
 */
const TRANSLUCENT_CONTENT_TOP_INSET = 8;

/**
 * Duration (ms) of the window glide used when a footprint change forces the
 * window to move (e.g. expanding the tall panel near a screen edge, or restoring
 * the dock on collapse). Tuned to roughly track the content morph spring
 * (`ISLAND_SPRING`, ~0.5s) so the island slides into place instead of teleporting.
 */
const WINDOW_GLIDE_MS = 360;
/** Frame interval (ms) for the glide tween (~60fps). */
const GLIDE_FRAME_MS = 16;

/** Ease-out cubic: fast start, gentle settle — close to the spring's feel. */
function easeOutCubic(t: number): number {
	return 1 - (1 - t) ** 3;
}

/** Live state for the in-flight drag gesture. Null when not dragging. */
interface DragState {
	area: Rect;
	/** Id of the display whose work area `area` belongs to. */
	displayId: number;
	/** An island-shaped outline at each of the nine snap spots (overlay ghosts). */
	ghosts: Rect[];
	pill: PillRect;
	/**
	 * The zone the drag will snap to on release, or `null` when the island is far
	 * from every zone and should be left exactly where it was dropped (free).
	 */
	snapZone: number | null;
}

/**
 * Register the window-control IPC channels for a window. The renderer drives
 * these from pointer events on the island element:
 *
 * - `win:setMouseCapture` toggles click-through. The BrowserWindow stays at its
 *   max panel size; everything outside the island shape is click-through, so we
 *   capture only while the pointer is over the island element.
 * - `win:dragStart` / `win:moveBy` / `win:dragEnd` implement a manual,
 *   pointer-based drag that snaps the *visible island* to a 3x3 grid of screen
 *   zones: the overlay appears on drag start, follows the nearest zone on move,
 *   and the pill snaps to that zone's anchor (persisted) on release.
 * - `win:setContentSize` reports the visible footprint. The material window is
 *   resized to it; in either appearance the window is shifted when the footprint
 *   would overflow a screen edge, so the island never grows off-screen, and
 *   restored to its dock once a smaller footprint fits again.
 */
export function registerWinIpc(win: BrowserWindow, acrylic = false): void {
	let drag: DragState | null = null;

	// Edge-aware footprint anchoring. The island content (label, suggestion chip +
	// action row, or the expanded panel) renders centered on the resting island
	// ("pill"); when it grows near a screen edge it would overflow, so we shift the
	// window to keep the whole footprint on-screen. That shift moves the window off
	// the dock, so `dockAnchor` remembers the resting window bounds captured on the
	// first shift; once a later footprint fits again we restore the dock with no
	// drift. Null whenever the island sits at its dock (nothing shifted).
	let dockAnchor: Rect | null = null;

	/** Forget the captured dock (a drag or display change re-establishes it). */
	const clearDockAnchor = (): void => {
		dockAnchor = null;
	};

	// In-flight window glide (footprint-driven moves are animated so the island
	// slides into place instead of teleporting; see `WINDOW_GLIDE_MS`). Null when
	// no glide is running. A drag, display change, or new glide cancels it.
	let glideTimer: ReturnType<typeof setInterval> | null = null;

	const cancelGlide = (): void => {
		if (glideTimer !== null) {
			clearInterval(glideTimer);
			glideTimer = null;
		}
	};

	/**
	 * Animate the window's top-left from its current position to `(targetX,
	 * targetY)` over {@link WINDOW_GLIDE_MS}, easing out so it tracks the content
	 * morph. Cancels any in-flight glide first and no-ops when already on target.
	 */
	const glideTo = (targetX: number, targetY: number): void => {
		cancelGlide();
		const [startX, startY] = win.getPosition();
		if (startX === targetX && startY === targetY) {
			return;
		}
		const startedAt = Date.now();
		glideTimer = setInterval(() => {
			if (win.isDestroyed()) {
				cancelGlide();
				return;
			}
			const progress = Math.min(1, (Date.now() - startedAt) / WINDOW_GLIDE_MS);
			const eased = easeOutCubic(progress);
			win.setPosition(
				Math.round(startX + (targetX - startX) * eased),
				Math.round(startY + (targetY - startY) * eased)
			);
			if (progress >= 1) {
				cancelGlide();
			}
		}, GLIDE_FRAME_MS);
	};

	/** The resting island ("pill") rect in screen coords for the given window bounds. */
	const pillScreenRect = (bounds: Rect): Rect => {
		const pill = restingPill(bounds.width, bounds.height, acrylic);
		return {
			x: bounds.x + pill.offsetX,
			y: bounds.y + pill.offsetY,
			width: pill.width,
			height: pill.height,
		};
	};

	/** Screen-space center of the *visible island shape* for the current drag. */
	const pillCenter = (pill: PillRect): Point => {
		const [x, y] = win.getPosition();
		return {
			x: x + pill.offsetX + pill.width / 2,
			y: y + pill.offsetY + pill.height / 2,
		};
	};

	/** Screen-space rect the visible island will snap to for the given zone. */
	const ghostRect = (state: DragState, zone: number): Rect => {
		const anchor = zoneAnchorPosition(
			state.area,
			zone,
			state.pill.width,
			state.pill.height,
			getEdgeOffset()
		);
		return {
			x: anchor.x,
			y: anchor.y,
			width: state.pill.width,
			height: state.pill.height,
		};
	};

	/**
	 * The zone the island would snap to *if close enough*, else `null` (free). Uses
	 * the distance from the island center to each zone's landing anchor, so the
	 * island only snaps when dragged near a dock spot — anywhere else stays put.
	 */
	const resolveSnapZone = (state: DragState): number | null => {
		const result = nearestSnapZone(
			state.area,
			pillCenter(state.pill),
			state.pill,
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
			const { width: contentWidth, height: contentHeight } = payload;
			if (contentWidth <= 0 || contentHeight <= 0) {
				return;
			}
			const content = { width: contentWidth, height: contentHeight };
			const [x, y] = win.getPosition();
			const [width, height] = win.getSize();
			const current: Rect = { x, y, width, height };

			// Resolve the dock (where the resting island sits): the captured anchor
			// while shifted, else the current window. The footprint is anchored to the
			// dock's resting "pill", not to the possibly-shifted current window, so a
			// shrink always returns exactly to the dock.
			const dock = dockAnchor ?? current;
			const pill = pillScreenRect(dock);
			const center: Point = {
				x: pill.x + pill.width / 2,
				y: pill.y + pill.height / 2,
			};
			const area = screen.getDisplayNearestPoint(center).workArea;
			const natural = naturalFootprintRect(pill, content);
			const rect = placeFootprint(pill, content, area, getEdgeOffset());
			const shifted = rect.x !== natural.x || rect.y !== natural.y;

			/**
			 * Move/resize the window so its content footprint lands on `target`. When
			 * `animate` is set the translucent window *glides* to its new position
			 * (used for footprint-driven moves like expanding the tall panel at a
			 * screen edge, or restoring the dock on collapse), so the island slides
			 * into place instead of teleporting.
			 */
			const applyContentRect = (target: Rect, animate = false): void => {
				if (acrylic) {
					// The window *is* the content: take the rect directly.
					cancelGlide();
					win.setBounds(target);
					return;
				}
				// Fixed-size translucent window: place it so its top-centered content
				// (centered, `pt-2` below the top) lands on `target`.
				const targetX = Math.round(target.x - (width - contentWidth) / 2);
				const targetY = Math.round(target.y - TRANSLUCENT_CONTENT_TOP_INSET);
				if (animate) {
					glideTo(targetX, targetY);
				} else {
					cancelGlide();
					win.setPosition(targetX, targetY);
				}
			};

			if (shifted) {
				// The footprint would overflow at this dock: capture the dock (once) and
				// shift the window so the whole island stays on-screen. Glide there so a
				// big footprint (the tall panel near an edge) slides up into view rather
				// than snapping.
				if (dockAnchor === null) {
					dockAnchor = current;
				}
				applyContentRect(rect, true);
				return;
			}

			// The footprint fits at the dock. If we had shifted for a larger one,
			// restore the dock now (no drift); otherwise this is an ordinary footprint
			// change — the material window tracks its content, the translucent window
			// is fixed and needs no move. Glide the restore so collapsing the panel
			// slides back to the dock instead of teleporting.
			if (dockAnchor !== null) {
				clearDockAnchor();
				applyContentRect(natural, true);
				return;
			}
			if (acrylic) {
				win.setBounds(natural);
			}
		}
	);

	ipcMain.on(WIN_CHANNELS.dragStart, (_event, payload: DragStartPayload) => {
		if (win.isDestroyed()) {
			return;
		}
		// Dragging repositions the island; any captured resting anchor is now stale,
		// so a later collapse should settle where the user dropped it, not jump back.
		// A drag also wins over any in-flight footprint glide.
		cancelGlide();
		clearDockAnchor();
		const pill: PillRect = {
			offsetX: payload.x,
			offsetY: payload.y,
			width: payload.width,
			height: payload.height,
		};
		const display = screen.getDisplayNearestPoint(pillCenter(pill));
		const area = display.workArea;
		drag = {
			area,
			pill,
			ghosts: [],
			displayId: display.id,
			snapZone: null,
		};
		drag.ghosts = allGhosts(drag);
		drag.snapZone = resolveSnapZone(drag);
		showZoneOverlay(display, drag.ghosts, activeIndex(drag));
		// The overlay is topmost; keep the dragged island above it.
		win.moveTop();
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
		const center = pillCenter(drag.pill);
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
			win.moveTop();
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
		let target: Point;
		if (drag && drag.snapZone !== null) {
			// Near a zone: snap the visible pill to that zone's anchor.
			target = zoneWindowPosition(
				drag.area,
				drag.snapZone,
				drag.pill,
				getEdgeOffset()
			);
		} else {
			// Free drag (or a plain click): leave the island where it was dropped,
			// only nudging it back if it would otherwise strand offscreen.
			const [x, y] = win.getPosition();
			const [width, height] = win.getSize();
			target = ensureOnScreen(x, y, width, acrylic, height);
		}
		win.setPosition(target.x, target.y);
		writeStoredPosition(target);
		hideZoneOverlay();
		drag = null;
	});

	// Re-home on display layout changes so the island never strands offscreen
	// when a monitor is unplugged or the resolution changes.
	const rehome = (): void => {
		if (win.isDestroyed()) {
			return;
		}
		// A display layout change invalidates the captured resting anchor (it may
		// reference a monitor that is gone or has moved), so forget it; also stop any
		// in-flight glide before re-homing.
		cancelGlide();
		clearDockAnchor();
		const [x, y] = win.getPosition();
		const [width, height] = win.getSize();
		const safe = ensureOnScreen(x, y, width, acrylic, height);
		win.setPosition(safe.x, safe.y);
	};
	screen.on("display-metrics-changed", rehome);
	screen.on("display-removed", rehome);

	win.on("closed", () => {
		cancelGlide();
		ipcMain.removeAllListeners(WIN_CHANNELS.setMouseCapture);
		ipcMain.removeAllListeners(WIN_CHANNELS.setContentSize);
		ipcMain.removeAllListeners(WIN_CHANNELS.dragStart);
		ipcMain.removeAllListeners(WIN_CHANNELS.moveBy);
		ipcMain.removeAllListeners(WIN_CHANNELS.dragEnd);
		screen.removeListener("display-metrics-changed", rehome);
		screen.removeListener("display-removed", rehome);
		destroyZoneOverlay();
	});
}
