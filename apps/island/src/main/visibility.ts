// Window visibility controller shared by the tray, the global hotkey, and the
// renderer. Keeping show/hide in one place means every surface stays in sync and
// every flip notifies the renderer (`window:visibilityChanged`) so the island can
// reflect its own state if needed.

import type { BrowserWindow } from "electron";
import { IPC } from "../shared/ipc.ts";

export interface VisibilityWindow
	extends Pick<
		BrowserWindow,
		| "isDestroyed"
		| "isVisible"
		| "show"
		| "showInactive"
		| "moveTop"
		| "focus"
		| "hide"
		| "setIgnoreMouseEvents"
	> {
	webContents: Pick<BrowserWindow["webContents"], "send">;
}
let target: VisibilityWindow | null = null;
let activateApp: () => void = () => undefined;
const listeners = new Set<(visible: boolean) => void>();

/**
 * Wire the app activation used by {@link presentWindow}'s macOS focus path
 * (`app.focus({ steal: true })` in production). Injected so this module keeps
 * no Electron runtime import and stays unit-testable.
 */
export function setAppActivator(activate: () => void): void {
	activateApp = activate;
}

/** Point the controller at the live island window. */
export function setVisibilityTarget(win: VisibilityWindow | null): void {
	target = win;
}

function notify(visible: boolean): void {
	for (const listener of listeners) {
		listener(visible);
	}
	if (target && !target.isDestroyed()) {
		target.webContents.send(IPC.window.visibilityChanged, visible);
	}
}

/**
 * Order the island in (and optionally give it keyboard focus) without the
 * macOS white plate. On macOS 26, `BrowserWindow.show()`/`focus()` go through
 * `makeKeyAndOrderFront`, which leaves a transparent window with an opaque
 * white fill across its whole frame. A shape that fills the window (the logo
 * circle alone) hides it; the split logo + pill exposes it in the gap.
 * Ordering in without making it key, then activating the app, still makes
 * the island the key window but never paints that fill. Other platforms keep
 * the plain show/focus path.
 */
export function presentWindow(win: VisibilityWindow, focus: boolean): void {
	if (process.platform !== "darwin") {
		win.show();
		if (focus) {
			win.moveTop();
			win.focus();
		}
		return;
	}
	win.showInactive();
	if (focus) {
		activateApp();
	}
}

/**
 * Raise the island above other always-on-top windows (the drag snap-zone
 * overlay). `moveTop()` also paints the macOS white plate described in
 * {@link presentWindow}, and on macOS it is unnecessary: the island's
 * `screen-saver` level already sits above the overlay's `pop-up-menu` level.
 * Windows maps every always-on-top level to the same topmost band, so it still
 * needs the explicit raise.
 */
export function raiseWindow(win: Pick<BrowserWindow, "moveTop">): void {
	if (process.platform !== "darwin") {
		win.moveTop();
	}
}

/** Whether the island window is currently visible. */
export function isVisible(): boolean {
	return target !== null && !target.isDestroyed() && target.isVisible();
}

/** Show the island window and focus it. */
export function showWindow(): void {
	if (!target || target.isDestroyed()) {
		return;
	}
	presentWindow(target, true);
	notify(true);
}

/**
 * Show the island, make it interactive, and grab keyboard focus — the path the
 * global-hotkey command summon needs. Unlike {@link showWindow}, this disables
 * click-through (`setIgnoreMouseEvents(false)`) so the command palette accepts
 * typing even though the pointer is not over the (transparent, oversized) island
 * window, and presents it with focus (see {@link presentWindow}) so it wins
 * keyboard focus over the foreground app. Click-through is restored by the
 * renderer when the command
 * surface collapses. Called from a user gesture (the hotkey), which lets Electron
 * grant focus past Windows' focus-stealing prevention.
 */
export function focusForCommand(): void {
	if (!target || target.isDestroyed()) {
		return;
	}
	target.setIgnoreMouseEvents(false);
	presentWindow(target, true);
	notify(true);
}

/** Hide the island window. */
export function hideWindow(): void {
	if (!target || target.isDestroyed()) {
		return;
	}
	target.hide();
	notify(false);
}

/** Toggle the island window's visibility. */
export function toggleWindow(): void {
	if (isVisible()) {
		hideWindow();
		return;
	}
	showWindow();
}

/** Subscribe to visibility changes (e.g. for the tray menu). Returns unsubscribe. */
export function onVisibilityChanged(
	listener: (visible: boolean) => void
): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
