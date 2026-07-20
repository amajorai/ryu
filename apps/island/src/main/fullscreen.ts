// Hide-on-fullscreen controller (Windows-only). Detects when another app is
// running fullscreen — a fullscreen video, a game, a presentation — and hides the
// island overlay so it never floats over immersive content, restoring it the
// moment the fullscreen app exits.
//
// Detection uses the Win32 shell signal `SHQueryUserNotificationState`, the same
// "user is busy / don't disturb" state Windows itself uses to suppress toast
// notifications during fullscreen apps. It is read through `koffi` (a prebuilt
// native FFI, an optionalDependency loaded lazily + win32-guarded exactly like
// `mica-electron` in `window.ts`): if koffi is unavailable (non-Windows, or not
// installed/loadable) the detector degrades to a no-op and the island simply
// never auto-hides, rather than crashing.
//
// macOS/Linux: there is no equivalent single shell signal, and the island already
// opts into staying visible over fullscreen Spaces on macOS (`window.ts`), so
// this controller is a no-op off Windows. The preference is still stored so the
// behaviour can be extended later without a settings migration.

import { createRequire } from "node:module";
import type { BrowserWindow } from "electron";

const require = createRequire(import.meta.url);

/** How often to sample the fullscreen state, in milliseconds. */
const POLL_INTERVAL_MS = 1200;

// QUERY_USER_NOTIFICATION_STATE values (shellapi.h). The states that mean "a
// fullscreen app owns the screen": a fullscreen app or presentation settings are
// active (BUSY), an exclusive-mode Direct3D app is running (D3D_FULL_SCREEN), the
// machine is in presentation mode (PRESENTATION_MODE), or a fullscreen Windows
// Store / UWP app is running (APP). This is the same "user is busy / immersed"
// signal Windows itself uses to decide whether to suppress toast notifications.
// APP is included so the toggle covers "anything fullscreen" (the user's intent),
// not just classic desktop apps.
//
// Note: a locked workstation / inactive session reports NOT_PRESENT (1) and a
// normal idle desktop reports ACCEPTS_NOTIFICATIONS (5); neither counts as
// fullscreen, so the island stays visible there.
const QUNS_BUSY = 2;
const QUNS_RUNNING_D3D_FULL_SCREEN = 3;
const QUNS_PRESENTATION_MODE = 4;
const QUNS_APP = 7;

/**
 * Whether a raw `QUERY_USER_NOTIFICATION_STATE` value means a foreign fullscreen
 * app currently owns the screen. Pure + exported for unit testing.
 */
export function isFullscreenState(state: number): boolean {
	return (
		state === QUNS_BUSY ||
		state === QUNS_RUNNING_D3D_FULL_SCREEN ||
		state === QUNS_PRESENTATION_MODE ||
		state === QUNS_APP
	);
}

/** The minimal slice of the `koffi` FFI surface this module uses. */
interface KoffiLib {
	func: (
		convention: string,
		name: string,
		result: string,
		args: unknown[]
	) => (...callArgs: unknown[]) => number;
}
interface Koffi {
	load(path: string): KoffiLib;
	out(type: unknown): unknown;
	pointer(type: string): unknown;
}

/** The bound `SHQueryUserNotificationState` function once resolved, or null. */
type QueryStateFn = (out: number[]) => number;
let queryState: QueryStateFn | null = null;
// Distinguishes "not yet attempted" from "attempted and failed" so we only try to
// bind the native function once (a failed load stays failed for the session).
let bindAttempted = false;

/**
 * Lazily bind `shell32!SHQueryUserNotificationState` via koffi. Returns null off
 * Windows or if koffi / the symbol cannot be loaded (the feature then no-ops).
 */
function getQueryState(): QueryStateFn | null {
	if (bindAttempted) {
		return queryState;
	}
	bindAttempted = true;
	if (process.platform !== "win32") {
		return null;
	}
	try {
		const koffi = require("koffi") as Koffi;
		const shell32 = koffi.load("shell32.dll");
		// HRESULT SHQueryUserNotificationState(QUERY_USER_NOTIFICATION_STATE *pquns)
		const fn = shell32.func(
			"__stdcall",
			"SHQueryUserNotificationState",
			"int",
			[koffi.out(koffi.pointer("int"))]
		);
		queryState = (out: number[]) => fn(out) as number;
	} catch {
		queryState = null;
	}
	return queryState;
}

/**
 * Whether a foreign app is currently running fullscreen. Returns false off
 * Windows, when koffi is unavailable, or if the shell query fails — so a missing
 * detector never hides the island.
 */
export function isForeignFullscreenActive(): boolean {
	const fn = getQueryState();
	if (!fn) {
		return false;
	}
	const out: number[] = [0];
	const hr = fn(out);
	// hr is an HRESULT; S_OK is 0. A non-zero result means the query failed, so
	// treat the state as "not fullscreen" rather than acting on a garbage value.
	if (hr !== 0) {
		return false;
	}
	return isFullscreenState(out[0]);
}

let getWindow: () => BrowserWindow | null = () => null;
let enabled = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
// True only while the island is hidden *because of* this controller, so we
// restore it on fullscreen exit (or when the feature is turned off) without
// clobbering a hide the user made themselves (tray / hotkey).
let hiddenByFullscreen = false;

/**
 * Point the controller at the live island window. Called once at startup; the
 * getter is read each tick so window recreation (appearance switch) is handled.
 */
export function initFullscreenHide(getWin: () => BrowserWindow | null): void {
	getWindow = getWin;
}

/** Restore a window this controller hid, clearing the flag. No-op otherwise. */
function restoreIfHidden(): void {
	if (!hiddenByFullscreen) {
		return;
	}
	hiddenByFullscreen = false;
	const win = getWindow();
	if (win && !win.isDestroyed() && !win.isVisible()) {
		win.show();
	}
}

function tick(): void {
	const win = getWindow();
	if (!win || win.isDestroyed()) {
		return;
	}
	if (isForeignFullscreenActive()) {
		// Don't fight an explicit summon: while the island is focused (the user
		// opened the command palette over the fullscreen app) leave it visible.
		if (win.isVisible() && !win.isFocused()) {
			win.hide();
			hiddenByFullscreen = true;
		}
		return;
	}
	restoreIfHidden();
}

/**
 * Enable or disable hide-on-fullscreen. Enabling starts the poll loop (and checks
 * immediately); disabling stops it and restores the island if this controller had
 * hidden it. Safe to call repeatedly with the same value.
 */
export function setHideOnFullscreen(on: boolean): void {
	enabled = on;
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
	if (!enabled) {
		restoreIfHidden();
		return;
	}
	tick();
	pollTimer = setInterval(tick, POLL_INTERVAL_MS);
}
