// Ghost-cursor overlay: a visible, on-screen cursor that tracks what a Ghost agent
// is doing, so background computer-use never has to hijack the user's real pointer.
//
// The Ghost sidecar (apps/ghost) narrates each input action to the island's loopback
// control server (POST /ghost-cursor); that server forwards the event here. This
// module owns a single frameless, transparent, click-through, always-on-top window
// (cloned from the snap-zone overlay's `ensureOverlay`) that covers the active
// display and draws a small monochrome cursor with a tinted intent dot which eases
// to each target,
// ripples on a click, fades after a short idle, and — with a distinct hue per agent
// pid — visually separates concurrent agents.
//
// Lifecycle: lazily created on the first event and destroyed after 30s of silence,
// so it costs nothing (no window, no compositor overlay) whenever no agent is active.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app, BrowserWindow, type Display, screen } from "electron";
import type {
	GhostCursorEvent,
	GhostCursorIdentity,
} from "./control-protocol.ts";
import { ghostCursorHueFor } from "./control-protocol.ts";
import OVERLAY_HTML from "./ghost-cursor-overlay.html?raw";

// Self-contained overlay document. Exposes one global the main process calls:
//   window.__ghost(phase, x, y, hue, intent, identity) -- x/y are overlay-window-local px;
//   hue is 0-360, intent is a short action label, and identity is host-supplied
//   agent/session display metadata.
// The sprite CSS-transitions its transform, so setting the target position eases the
// cursor there for free. A `down` phase spawns a click ripple; every event resets a
// short idle fade. The identity chip moves with the pointer and the agent keeps a
// stable color across tool-process restarts when Ryu supplies its identity.

let overlay: BrowserWindow | null = null;
let ready = false;
/** Events that arrived before the page finished loading; flushed on ready. */
const pending: Array<{
	identity?: GhostCursorIdentity;
	intent: string;
	phase: string;
	x: number;
	y: number;
	hue: number;
}> = [];
/** The display id the overlay is currently sized to, so bounds only change on move. */
let currentDisplayId: number | null = null;
/** Destroy-on-idle timer; reset on every event. */
let idleTimer: ReturnType<typeof setTimeout> | null = null;

const IDLE_DESTROY_MS = 30_000;

/** Write the overlay HTML to disk and return its absolute path. */
function overlayHtmlPath(): string {
	const file = join(app.getPath("userData"), "island", "ghost-cursor.html");
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, OVERLAY_HTML, "utf8");
	return file;
}

/** Create (or reuse) the overlay window sized to `display`, loading its HTML once. */
function ensureOverlay(display: Display): BrowserWindow {
	if (overlay && !overlay.isDestroyed()) {
		return overlay;
	}
	const win = new BrowserWindow({
		show: false,
		frame: false,
		transparent: true,
		backgroundColor: "#00000000",
		resizable: false,
		movable: false,
		minimizable: false,
		maximizable: false,
		skipTaskbar: true,
		hasShadow: false,
		focusable: false,
		fullscreenable: false,
		acceptFirstMouse: false,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	win.setBounds(display.bounds);
	currentDisplayId = display.id;
	// Click-through (forward so nothing underneath is ever blocked), topmost at the
	// same level as the island, on every Space and over fullscreen apps, and excluded
	// from screen capture so the agent's cursor never leaks into a shared screen.
	win.setIgnoreMouseEvents(true, { forward: true });
	win.setAlwaysOnTop(true, "screen-saver");
	if (process.platform === "darwin") {
		win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
	}
	win.setContentProtection(true);
	win.webContents.once("did-finish-load", () => {
		ready = true;
		for (const ev of pending.splice(0)) {
			forward(win, ev.phase, ev.x, ev.y, ev.hue, ev.intent, ev.identity);
		}
		if (!win.isDestroyed()) {
			win.showInactive();
		}
	});
	win.loadFile(overlayHtmlPath()).catch(() => {
		// Best-effort: a failed overlay must never break agent actions.
	});
	win.on("closed", () => {
		overlay = null;
		ready = false;
		currentDisplayId = null;
		pending.length = 0;
	});
	overlay = win;
	return win;
}

/** Push one `window.__ghost(...)` call into the doc (or queue it until ready). */
function forward(
	win: BrowserWindow,
	phase: string,
	x: number,
	y: number,
	hue: number,
	intent: string,
	identity?: GhostCursorIdentity
): void {
	if (win.isDestroyed()) {
		return;
	}
	win.webContents
		.executeJavaScript(
			`window.__ghost(${JSON.stringify(phase)},${x},${y},${hue},${JSON.stringify(intent)},${JSON.stringify(identity ?? null)})`
		)
		.catch(() => {
			// Ignore: the window may be tearing down between events.
		});
}

/** Reset the destroy-on-idle timer; after 30s of silence the overlay is torn down. */
function resetIdleDestroy(): void {
	if (idleTimer) {
		clearTimeout(idleTimer);
	}
	idleTimer = setTimeout(() => {
		destroyGhostCursor();
	}, IDLE_DESTROY_MS);
}

/**
 * Handle one Ghost action event: lazily build the overlay on the display the event
 * targets, then ease the tinted cursor there (ripple on `down`). Best-effort — any
 * failure is swallowed so a narrated action never disturbs the agent.
 */
export function pushGhostCursorEvent(event: GhostCursorEvent): void {
	try {
		const point = { x: Math.round(event.x) || 0, y: Math.round(event.y) || 0 };
		const display = screen.getDisplayNearestPoint(point);
		const win = ensureOverlay(display);
		// Follow the cursor across monitors, but only re-bound on an actual change
		// (resizing every event would flicker the overlay).
		if (currentDisplayId !== display.id && !win.isDestroyed()) {
			win.setBounds(display.bounds);
			currentDisplayId = display.id;
		}
		const localX = point.x - display.bounds.x;
		const localY = point.y - display.bounds.y;
		const hue = ghostCursorHueFor(event.identity, event.agent);
		if (ready) {
			forward(
				win,
				event.phase,
				localX,
				localY,
				hue,
				event.intent,
				event.identity
			);
		} else {
			pending.push({
				identity: event.identity,
				intent: event.intent,
				phase: event.phase,
				x: localX,
				y: localY,
				hue,
			});
		}
		resetIdleDestroy();
	} catch {
		// Never let overlay trouble surface to the control server / the agent.
	}
}

/** Destroy the overlay window and clear timers (idle teardown / app quit). */
export function destroyGhostCursor(): void {
	if (idleTimer) {
		clearTimeout(idleTimer);
		idleTimer = null;
	}
	if (overlay && !overlay.isDestroyed()) {
		overlay.destroy();
	}
	overlay = null;
	ready = false;
	currentDisplayId = null;
	pending.length = 0;
}
