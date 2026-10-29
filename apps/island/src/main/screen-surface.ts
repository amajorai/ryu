// On-screen generative UI: the window that draws the agent's live screen on the
// desktop instead of inside the Island panel.
//
// One frameless, transparent, always-on-top window, created lazily on the first
// screen and sized beside the Island on the Island's display. It is click-through
// except over the card itself (the renderer captures the mouse on pointerenter),
// so the empty area around a morphing card never blocks the apps underneath.
// It is shown without taking focus; clicking into a form field focuses it.
//
// The Island chat owns WHICH screen is live and sends it here; this module only
// places the window, forwards state to it, and relays the user's submit/close
// back to the Island. The window follows the Island: it hides while the Island
// is hidden (tray/hotkey, hide-on-fullscreen), returns with it, and re-places
// itself when the Island moves or resizes. A hidden window is destroyed after a
// while so an idle Island costs no extra renderer process.

import { join } from "node:path";
import { BrowserWindow, ipcMain, screen } from "electron";
import { z } from "zod";
import {
	HIDDEN_SCREEN_SURFACE,
	type ScreenSurfaceRenderState,
	type ScreenSurfaceState,
	SURFACE_CHANNELS,
	screenSurfaceBounds,
	surfaceAnchor,
} from "../shared/screen-surface.ts";

/** The Island renderer's `show` payload, validated before it reaches a window. */
const screenSurfaceStateSchema = z.object({
	surface: z
		.object({
			format: z.enum(["json-render", "a2ui"]).optional(),
			id: z.string().max(256),
			spec: z.unknown(),
			title: z.string().max(512).optional(),
		})
		.nullable(),
	updating: z.boolean(),
}) satisfies z.ZodType<ScreenSurfaceState>;

/** Lets the exit animation finish before the window is hidden. */
const HIDE_DELAY_MS = 320;
/** A hidden window is torn down after this long without a new screen. */
const IDLE_DESTROY_MS = 120_000;
/** Re-place the screen once an Island drag or resize settles. */
const FOLLOW_SETTLE_MS = 120;

/**
 * The screen window's renderer options. It draws agent-authored UI, so it keeps
 * every Chromium/Electron boundary: a sandboxed renderer with context isolation
 * and no Node. Its preload (`preload/surface.ts`) bundles into one
 * self-contained file whose only runtime import is `electron`, which is all a
 * sandboxed preload can `require` (`preload/sandbox.test.ts` guards this).
 */
const SCREEN_SURFACE_WEB_PREFERENCES = {
	contextIsolation: true,
	nodeIntegration: false,
	sandbox: true,
	webSecurity: true,
} as const satisfies Electron.WebPreferences;

let surfaceWindow: BrowserWindow | null = null;
let ready = false;
let latest: ScreenSurfaceState = HIDDEN_SCREEN_SURFACE;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let destroyTimer: ReturnType<typeof setTimeout> | null = null;
let followTimer: ReturnType<typeof setTimeout> | null = null;
let contentProtected = false;
let registered = false;

function clearFollowTimer(): void {
	if (followTimer) {
		clearTimeout(followTimer);
		followTimer = null;
	}
}

function clearTimers(): void {
	if (hideTimer) {
		clearTimeout(hideTimer);
		hideTimer = null;
	}
	if (destroyTimer) {
		clearTimeout(destroyTimer);
		destroyTimer = null;
	}
	clearFollowTimer();
}

function live(win: BrowserWindow | null): win is BrowserWindow {
	return win !== null && !win.isDestroyed();
}

/** The screen only appears while the Island it belongs to is on screen. */
function islandShown(island: BrowserWindow | null): boolean {
	return live(island) && island.isVisible();
}

function ensureWindow(): BrowserWindow {
	if (live(surfaceWindow)) {
		return surfaceWindow;
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
		fullscreenable: false,
		skipTaskbar: true,
		hasShadow: false,
		webPreferences: {
			...SCREEN_SURFACE_WEB_PREFERENCES,
			preload: join(import.meta.dirname, "../preload/surface.cjs"),
		},
	});
	win.setIgnoreMouseEvents(true, { forward: true });
	win.setAlwaysOnTop(true, "screen-saver");
	if (process.platform === "darwin") {
		win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
	}
	win.setContentProtection(contentProtected);
	// The screen renders agent-authored content: never let it navigate or open
	// windows; links inside a screen are inert here.
	win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	win.webContents.on("will-navigate", (event) => event.preventDefault());
	win.on("closed", () => {
		surfaceWindow = null;
		ready = false;
	});
	const devUrl = process.env.ELECTRON_RENDERER_URL;
	const load = devUrl
		? win.loadURL(
				new URL("surface.html", `${devUrl.replace(/\/?$/, "/")}`).href
			)
		: win.loadFile(join(import.meta.dirname, "../renderer/surface.html"));
	load.catch(() => {
		// Best effort: a screen that fails to load must never break the chat.
	});
	surfaceWindow = win;
	return win;
}

function renderState(
	win: BrowserWindow,
	island: BrowserWindow | null,
	state: ScreenSurfaceState
): ScreenSurfaceRenderState {
	const islandBounds = live(island) ? island.getBounds() : win.getBounds();
	const display = screen.getDisplayMatching(islandBounds);
	return { ...state, anchor: surfaceAnchor(display.workArea, islandBounds) };
}

function place(win: BrowserWindow, island: BrowserWindow | null): void {
	const islandBounds = live(island)
		? island.getBounds()
		: screen.getPrimaryDisplay().workArea;
	const display = screen.getDisplayMatching(islandBounds);
	const next = screenSurfaceBounds(display.workArea, islandBounds);
	const current = win.getBounds();
	if (
		current.x === next.x &&
		current.y === next.y &&
		current.width === next.width &&
		current.height === next.height
	) {
		return;
	}
	win.setBounds(next);
}

function push(island: BrowserWindow | null): void {
	const win = surfaceWindow;
	if (!(live(win) && ready)) {
		return;
	}
	win.webContents.send(
		SURFACE_CHANNELS.state,
		renderState(win, island, latest)
	);
}

function show(island: BrowserWindow | null, state: ScreenSurfaceState): void {
	latest = state;
	clearTimers();
	if (!state.surface) {
		const win = surfaceWindow;
		if (!live(win)) {
			return;
		}
		push(island);
		hideTimer = setTimeout(() => {
			hideTimer = null;
			if (live(win)) {
				win.setIgnoreMouseEvents(true, { forward: true });
				win.hide();
			}
			destroyTimer = setTimeout(() => {
				destroyTimer = null;
				if (live(win) && !latest.surface) {
					win.destroy();
				}
			}, IDLE_DESTROY_MS);
		}, HIDE_DELAY_MS);
		return;
	}
	const win = ensureWindow();
	// Re-place on every screen so the window and the anchor `push` computes
	// always agree with where the Island is now (a no-op when unchanged).
	place(win, island);
	push(island);
	if (ready && !win.isVisible() && islandShown(island)) {
		win.showInactive();
	}
}

/** The Island hid: take the screen down with it, keeping it to bring back. */
function hideWithIsland(): void {
	clearFollowTimer();
	const win = surfaceWindow;
	if (!(live(win) && win.isVisible())) {
		return;
	}
	win.setIgnoreMouseEvents(true, { forward: true });
	win.hide();
}

/** The Island is back: bring back the screen it still owns, beside it. */
function showWithIsland(island: BrowserWindow): void {
	const win = surfaceWindow;
	if (!(live(win) && ready && latest.surface) || win.isVisible()) {
		return;
	}
	place(win, island);
	push(island);
	win.showInactive();
}

/** The Island moved or resized: follow it once it settles. */
function followIsland(island: BrowserWindow): void {
	clearFollowTimer();
	followTimer = setTimeout(() => {
		followTimer = null;
		const win = surfaceWindow;
		if (!(live(win) && win.isVisible() && islandShown(island))) {
			return;
		}
		place(win, island);
		push(island);
	}, FOLLOW_SETTLE_MS);
}

/** True when `sender` is the live screen window (rejects every other renderer). */
function fromSurface(sender: Electron.WebContents): boolean {
	return live(surfaceWindow) && sender === surfaceWindow.webContents;
}

/**
 * Register the screen-window IPC once. `getIsland` returns the live Island window,
 * which both sends screens and receives the user's submit/close.
 */
export function registerScreenSurfaceIpc(
	getIsland: () => BrowserWindow | null
): void {
	if (registered) {
		return;
	}
	registered = true;

	ipcMain.on(SURFACE_CHANNELS.show, (event, payload: unknown) => {
		const island = getIsland();
		if (!(live(island) && event.sender === island.webContents)) {
			return;
		}
		const parsed = screenSurfaceStateSchema.safeParse(payload);
		show(island, parsed.success ? parsed.data : HIDDEN_SCREEN_SURFACE);
	});

	ipcMain.on(SURFACE_CHANNELS.ready, (event) => {
		const win = surfaceWindow;
		if (!(live(win) && fromSurface(event.sender))) {
			return;
		}
		ready = true;
		const island = getIsland();
		if (latest.surface) {
			// The Island may have moved while this page loaded (a move is not
			// followed while the window is still hidden): place it again first.
			place(win, island);
		}
		push(island);
		if (latest.surface && !win.isVisible() && islandShown(island)) {
			win.showInactive();
		}
	});

	ipcMain.on(SURFACE_CHANNELS.setMouseCapture, (event, capture: unknown) => {
		const win = surfaceWindow;
		if (!(live(win) && fromSurface(event.sender))) {
			return;
		}
		win.setIgnoreMouseEvents(capture !== true, { forward: true });
	});

	ipcMain.on(SURFACE_CHANNELS.submit, (event, value: unknown) => {
		const island = getIsland();
		if (fromSurface(event.sender) && live(island)) {
			island.webContents.send(SURFACE_CHANNELS.submit, value);
		}
	});

	ipcMain.on(SURFACE_CHANNELS.dismiss, (event) => {
		const island = getIsland();
		if (fromSurface(event.sender) && live(island)) {
			island.webContents.send(SURFACE_CHANNELS.dismiss);
		}
	});
}

/**
 * Keep the screen window with `island`: hide it while the Island is hidden (the
 * tray/hotkey hide and hide-on-fullscreen both go through `BrowserWindow.hide`),
 * bring it back when the Island shows again, and re-place it after the Island
 * is dragged, jumps displays, or resizes. Call once per Island window; the
 * listeners go away with that window.
 */
export function followIslandWindow(island: BrowserWindow): void {
	island.on("hide", hideWithIsland);
	island.on("show", () => showWithIsland(island));
	island.on("move", () => followIsland(island));
	island.on("resize", () => followIsland(island));
}

/** Forward a theme change to the screen window so it matches the Island. */
export function forwardThemeToScreenSurface(
	channel: string,
	value: unknown
): void {
	if (live(surfaceWindow)) {
		surfaceWindow.webContents.send(channel, value);
	}
}

/** Follow the Island's screen-privacy preference (exclusion from capture). */
export function setScreenSurfaceContentProtection(enabled: boolean): void {
	contentProtected = enabled;
	if (live(surfaceWindow)) {
		surfaceWindow.setContentProtection(enabled);
	}
}

/** Tear the screen window down (Island window closed, or app quitting). */
export function destroyScreenSurface(): void {
	clearTimers();
	latest = HIDDEN_SCREEN_SURFACE;
	if (live(surfaceWindow)) {
		surfaceWindow.destroy();
	}
	surfaceWindow = null;
	ready = false;
}
