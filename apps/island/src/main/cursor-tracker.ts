// Global cursor tracker for the island's eye-gaze effect.
//
// The renderer's logo "eyes" follow the mouse via a window `mousemove` listener,
// but a click-through window only receives forwarded moves while the pointer is
// physically over it (and the island window is intentionally small so it stays
// draggable/snappable/persisted). To let the eyes track the cursor anywhere on
// any monitor, the main process polls the OS cursor position and pushes it to the
// renderer as window-relative coords; the renderer replays it as a synthetic
// `mousemove` so the shared logo component works unchanged.
//
// This is deliberately the *light* path: no full-screen transparent overlay (the
// expensive case for the compositor and the one most likely to interfere with
// other apps' z-order). Cost while idle is one cursor read per tick; we only emit
// an IPC message when the point actually changes, and the poll runs only while
// the window is shown.
//
// On Linux the renderer also hit-tests these samples to take the pointer, since
// a click-through window receives no mouse moves there. On X11, Electron's own
// reading stops changing while the Island is click-through, so the X server is
// asked directly (see `x11-pointer.ts`); macOS, Windows and a Wayland-rendered
// Electron keep Electron's.

import { type BrowserWindow, type Display, type Point, screen } from "electron";
import { IPC } from "../shared/ipc.ts";
import { queryX11Pointer, x11PointToDip } from "./x11-pointer.ts";

// ~60 Hz: smooth gaze without flooding IPC. Each read is one cheap call (a
// local X round trip on Linux, which reuses a cached display list) and unchanged
// points are skipped, so the idle cost is negligible.
const POLL_INTERVAL_MS = 16;

/**
 * Electron's display list for the X11 pixel-to-DIP mapping, enumerated once and
 * refreshed only when Electron reports that the displays changed.
 */
let displayCache: Display[] | null = null;
let watchingDisplays = false;

function displays(): Display[] {
	if (!watchingDisplays) {
		watchingDisplays = true;
		const invalidate = (): void => {
			displayCache = null;
		};
		screen.on("display-added", invalidate);
		screen.on("display-removed", invalidate);
		screen.on("display-metrics-changed", invalidate);
	}
	displayCache ??= screen.getAllDisplays();
	return displayCache;
}

/** The global cursor in screen DIP: the X server's pointer on Linux X11. */
function cursorScreenPoint(): Point {
	const physical = queryX11Pointer();
	return physical
		? x11PointToDip(physical, displays())
		: screen.getCursorScreenPoint();
}

/**
 * Begin polling the global cursor for the given window, pushing window-relative
 * coordinates to the renderer over {@link IPC.window.cursorMove}. The poll runs
 * only while the window is visible (started on `show`, stopped on `hide`/`close`)
 * and skips ticks where the cursor has not moved. Idempotent per window.
 */
export function attachCursorTracking(win: BrowserWindow): void {
	let timer: ReturnType<typeof setInterval> | null = null;
	let lastX = Number.NaN;
	let lastY = Number.NaN;

	const tick = (): void => {
		if (win.isDestroyed() || !win.isVisible()) {
			return;
		}
		const point = cursorScreenPoint();
		const bounds = win.getBounds();
		// Window-relative coords == DOM clientX/clientY (CSS px == DIP here).
		const x = point.x - bounds.x;
		const y = point.y - bounds.y;
		if (x === lastX && y === lastY) {
			return;
		}
		lastX = x;
		lastY = y;
		win.webContents.send(IPC.window.cursorMove, { x, y });
	};

	const start = (): void => {
		if (timer !== null) {
			return;
		}
		timer = setInterval(tick, POLL_INTERVAL_MS);
	};

	const stop = (): void => {
		if (timer !== null) {
			clearInterval(timer);
			timer = null;
		}
	};

	win.on("show", start);
	win.on("hide", stop);
	win.once("closed", stop);

	// The window shows via `ready-to-show` before this runs in some paths, so
	// start immediately if it is already visible.
	if (win.isVisible()) {
		start();
	}
}
