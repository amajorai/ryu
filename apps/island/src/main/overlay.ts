// Snap-zone overlay shown while the user drags the island.
//
// A frameless, transparent, click-through, always-on-top window is sized to the
// active display's work area. It draws three layers:
//   1. a dim backdrop veil over the whole work area, so the faint zones stay
//      legible against busy/bright desktops;
//   2. all nine snap zones (the 3x3 grid cells) as faint rounded outlines, so the
//      user can see every place the island can dock;
//   3. one bright "ghost" of the island at the exact spot it will snap to — shown
//      only when the drag is close enough to a zone to grab (otherwise the drop is
//      free and no ghost is shown).
//
// The HTML is written to disk once and loaded with `loadFile` (more reliable than
// a data URL for transparent windows), then driven from the main process via
// `executeJavaScript` -- no preload or renderer build entry.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app, BrowserWindow, type Display } from "electron";
import type { Rect } from "./zones.ts";

// Self-contained overlay document. Exposes three globals the main process calls
// (rects already expressed in overlay-window-local pixels):
//   window.__render(ghosts, active) -- full black veil + an outline of the island
//                                      at every one of the nine snap spots, shaped
//                                      to the dragged island (circle/pill/rect via
//                                      each rect's height); `active` is highlighted.
//   window.__active(index)          -- cheap per-move update of which outline glows
//   window.__clear()                -- fade everything out at drop
const OVERLAY_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body {
    margin: 0; padding: 0; width: 100%; height: 100%;
    overflow: hidden; background: transparent;
    font-family: system-ui, -apple-system, sans-serif;
    user-select: none; cursor: default;
  }
  /* Full-screen black, semi-transparent veil. */
  #backdrop {
    position: absolute; inset: 0;
    background: rgba(0, 0, 0, 0.4);
    opacity: 0; transition: opacity .14s ease;
  }
  /* A faint outline of the island at one snap spot. */
  .ghost {
    position: absolute; box-sizing: border-box;
    border: 1.5px dashed rgba(255, 255, 255, 0.35);
    background: rgba(255, 255, 255, 0.04);
    transition: border-color .12s ease, background .12s ease, box-shadow .12s ease;
  }
  /* The snap target the island will land in: bright + glowing. */
  .ghost.active {
    border: 2px solid rgba(255, 255, 255, 0.95);
    border-style: solid;
    background: rgba(130, 175, 255, 0.18);
    box-shadow: 0 0 0 1px rgba(8, 10, 16, 0.30),
                0 10px 44px rgba(60, 110, 220, 0.5);
  }
</style>
</head>
<body>
  <div id="backdrop"></div>
  <div id="ghosts"></div>
  <script>
    function render(ghosts, active) {
      var host = document.getElementById('ghosts');
      host.innerHTML = '';
      for (var i = 0; i < ghosts.length; i++) {
        var g = ghosts[i];
        var el = document.createElement('div');
        el.className = 'ghost' + (i === active ? ' active' : '');
        el.style.left = g.x + 'px';
        el.style.top = g.y + 'px';
        el.style.width = g.width + 'px';
        el.style.height = g.height + 'px';
        // Match the dragged island's shape: a 40x40 logo -> circle, a pill/panel
        // -> rounded pill/rect (cap so big panels are not over-rounded).
        el.style.borderRadius = Math.min(g.height / 2, 28) + 'px';
        host.appendChild(el);
      }
      document.getElementById('backdrop').style.opacity = '1';
    }
    function setActive(active) {
      var nodes = document.getElementById('ghosts').children;
      for (var i = 0; i < nodes.length; i++) {
        nodes[i].className = 'ghost' + (i === active ? ' active' : '');
      }
    }
    function clear() {
      document.getElementById('backdrop').style.opacity = '0';
      document.getElementById('ghosts').innerHTML = '';
    }
    window.__render = render;
    window.__active = setActive;
    window.__clear = clear;
  </script>
</body>
</html>`;

/** Payload driving the overlay: the work area, an island outline at each of the
 * nine snap spots, and which one is the active snap target (`-1` = none/free). */
interface OverlayData {
	activeIndex: number;
	area: Rect;
	ghosts: Rect[];
}

let overlay: BrowserWindow | null = null;
let ready = false;
/** Render payload requested before the page finished loading; applied on ready. */
let pending: OverlayData | null = null;
/** Whether the overlay should currently be visible (guards quick-release races). */
let visible = false;
/**
 * Whether the overlay must be excluded from screen capture, mirroring the island
 * window's screen-privacy setting. Kept here so it survives the overlay being
 * lazily (re)created and is applied to every fresh overlay window.
 */
let contentProtected = false;

/** Write the overlay HTML to disk and return its absolute path. */
function overlayHtmlPath(): string {
	const file = join(app.getPath("userData"), "island", "zones-overlay.html");
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, OVERLAY_HTML, "utf8");
	return file;
}

/** Convert a screen-space rect to overlay-window-local pixels. */
function toLocal(rect: Rect, area: Rect): Rect {
	return {
		x: Math.round(rect.x - area.x),
		y: Math.round(rect.y - area.y),
		width: Math.round(rect.width),
		height: Math.round(rect.height),
	};
}

/** Create (or reuse) the overlay window, kicking off its HTML load once. */
function ensureOverlay(): BrowserWindow {
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
		},
	});
	// Click-through (forward so nothing underneath is ever blocked) and topmost,
	// just below the island, which is re-raised after the overlay is shown.
	win.setIgnoreMouseEvents(true, { forward: true });
	win.setAlwaysOnTop(true, "pop-up-menu");
	// Match the island's screen-privacy: when on, keep the drag overlay out of
	// screen captures/recordings too so it never flashes into a shared screen.
	win.setContentProtection(contentProtected);
	win.webContents.once("did-finish-load", () => {
		ready = true;
		if (pending) {
			renderNow(win, pending);
			pending = null;
		}
		if (visible && !win.isDestroyed()) {
			win.showInactive();
		}
	});
	win.loadFile(overlayHtmlPath()).catch(() => {
		// Best-effort: a failed overlay must never break dragging.
	});
	win.on("closed", () => {
		overlay = null;
		ready = false;
		visible = false;
		pending = null;
	});
	overlay = win;
	return win;
}

/** Push a full render payload (all snap outlines + active index) into the doc. */
function renderNow(win: BrowserWindow, data: OverlayData): void {
	if (win.isDestroyed()) {
		return;
	}
	const ghosts = data.ghosts.map((ghost) => toLocal(ghost, data.area));
	win.webContents
		.executeJavaScript(
			`window.__render(${JSON.stringify(ghosts)},${data.activeIndex})`
		)
		.catch(() => {
			// Ignore: the window may have been torn down mid-drag.
		});
}

/** Eagerly build + load the overlay at startup so it is ready before a drag. */
export function initZoneOverlay(): void {
	ensureOverlay();
}

/**
 * Mirror the island's screen-privacy setting onto the snap overlay: exclude it
 * from (or restore it to) screen capture. Applied to the live overlay if present
 * and remembered for any overlay created later.
 */
export function setOverlayContentProtection(enabled: boolean): void {
	contentProtected = enabled;
	if (overlay && !overlay.isDestroyed()) {
		overlay.setContentProtection(enabled);
	}
}

/**
 * Show the snap overlay across `display`'s work area: a full black veil plus an
 * island outline at every one of the nine snap spots (`ghosts`), with `activeIndex`
 * highlighted (`-1` = none, i.e. the drag is currently free). Shown without
 * stealing focus from the dragged island.
 */
export function showZoneOverlay(
	display: Display,
	ghosts: Rect[],
	activeIndex: number
): void {
	const win = ensureOverlay();
	const area = display.workArea;
	win.setBounds({
		x: area.x,
		y: area.y,
		width: area.width,
		height: area.height,
	});
	visible = true;
	if (ready) {
		renderNow(win, { area, ghosts, activeIndex });
		win.showInactive();
	} else {
		// Page still loading: stash the payload; did-finish-load applies it.
		pending = { area, ghosts, activeIndex };
	}
}

/**
 * Update only which outline is highlighted (cheap per-move call): `activeIndex`
 * is the snap target, or `-1` when the drag is free. The nine outlines stay as
 * last drawn by {@link showZoneOverlay}.
 */
export function setActiveZone(activeIndex: number): void {
	if (!overlay || overlay.isDestroyed()) {
		return;
	}
	if (!ready) {
		if (pending) {
			pending.activeIndex = activeIndex;
		}
		return;
	}
	overlay.webContents
		.executeJavaScript(`window.__active(${activeIndex})`)
		.catch(() => {
			// Ignore transient errors during teardown.
		});
}

/** Hide the overlay at the end of a drag. The window is kept for reuse. */
export function hideZoneOverlay(): void {
	visible = false;
	pending = null;
	if (!overlay || overlay.isDestroyed()) {
		return;
	}
	// Clear the drawn layers first (belt-and-suspenders: even if a later show
	// races or the window fails to hide, nothing stays painted), then hide
	// unconditionally — don't gate on isVisible(), which can be stale right after
	// an inactive show.
	if (ready) {
		overlay.webContents
			.executeJavaScript("window.__clear()")
			.catch(() => undefined);
	}
	overlay.hide();
}

/** Destroy the overlay window (called when the island window closes). */
export function destroyZoneOverlay(): void {
	if (overlay && !overlay.isDestroyed()) {
		overlay.destroy();
	}
	overlay = null;
	ready = false;
	visible = false;
	pending = null;
}
