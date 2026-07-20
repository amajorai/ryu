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
// other apps' z-order). Cost while idle is one cheap `getCursorScreenPoint` call
// per tick; we only emit an IPC message when the point actually changes, and the
// poll runs only while the window is shown.

import { type BrowserWindow, screen } from "electron";
import { IPC } from "../shared/ipc.ts";

// ~60 Hz: smooth gaze without flooding IPC. getCursorScreenPoint is a cheap
// syscall and unchanged points are skipped, so the idle cost is negligible.
const POLL_INTERVAL_MS = 16;

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
		const point = screen.getCursorScreenPoint();
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
