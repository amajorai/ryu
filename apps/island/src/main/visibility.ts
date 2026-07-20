// Window visibility controller shared by the tray, the global hotkey, and the
// renderer. Keeping show/hide in one place means every surface stays in sync and
// every flip notifies the renderer (`window:visibilityChanged`) so the island can
// reflect its own state if needed.

import type { BrowserWindow } from "electron";
import { IPC } from "../shared/ipc.ts";

let target: BrowserWindow | null = null;
const listeners = new Set<(visible: boolean) => void>();

/** Point the controller at the live island window. */
export function setVisibilityTarget(win: BrowserWindow | null): void {
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

/** Whether the island window is currently visible. */
export function isVisible(): boolean {
	return target !== null && !target.isDestroyed() && target.isVisible();
}

/** Show the island window and focus it. */
export function showWindow(): void {
	if (!target || target.isDestroyed()) {
		return;
	}
	target.show();
	notify(true);
}

/**
 * Show the island, make it interactive, and grab keyboard focus — the path the
 * global-hotkey command summon needs. Unlike {@link showWindow}, this disables
 * click-through (`setIgnoreMouseEvents(false)`) so the command palette accepts
 * typing even though the pointer is not over the (transparent, oversized) island
 * window, and calls `focus()`/`moveTop()` so it wins keyboard focus over the
 * foreground app. Click-through is restored by the renderer when the command
 * surface collapses. Called from a user gesture (the hotkey), which lets Electron
 * grant focus past Windows' focus-stealing prevention.
 */
export function focusForCommand(): void {
	if (!target || target.isDestroyed()) {
		return;
	}
	target.show();
	target.setIgnoreMouseEvents(false);
	target.moveTop();
	target.focus();
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
