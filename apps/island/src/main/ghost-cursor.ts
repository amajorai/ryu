// Ghost-cursor overlay: a visible, on-screen cursor that tracks what a Ghost agent
// is doing, so background computer-use never has to hijack the user's real pointer.
//
// The Ghost sidecar (apps/ghost) narrates each input action to the island's loopback
// control server (POST /ghost-cursor); that server forwards the event here. This
// module owns a single frameless, transparent, click-through, always-on-top window
// (cloned from the snap-zone overlay's `ensureOverlay`) that covers the active
// display and draws a distinct tinted "ryu" cursor which eases to each target,
// ripples on a click, fades after a short idle, and — with a distinct hue per agent
// pid — visually separates concurrent agents.
//
// Lifecycle: lazily created on the first event and destroyed after 30s of silence,
// so it costs nothing (no window, no compositor overlay) whenever no agent is active.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app, BrowserWindow, type Display, screen } from "electron";

/** One narrated Ghost input action (mirrors apps/ghost `GhostEvent` + the agent id
 * carried in the `x-ghost-agent` header). */
export interface GhostCursorEvent {
	seq: number;
	phase: "move" | "down" | "up" | "type" | "scroll" | "done";
	x: number;
	y: number;
	tool: string;
	ts: number;
	/** The emitting agent's pid (from `x-ghost-agent`); drives the per-agent hue. */
	agent: string;
}

// Self-contained overlay document. Exposes one global the main process calls:
//   window.__ghost(phase, x, y, hue) -- x/y are overlay-window-local px; hue is 0-360.
// The sprite CSS-transitions its transform, so setting the target position eases the
// cursor there for free. A `down` phase spawns a click ripple; every event resets a
// 3s idle fade. The "ryu" label + the hue make each agent's cursor recognisable.
const OVERLAY_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body {
    margin: 0; padding: 0; width: 100%; height: 100%;
    overflow: hidden; background: transparent;
    font-family: system-ui, -apple-system, sans-serif;
    user-select: none; cursor: default; pointer-events: none;
  }
  #cursor {
    position: absolute; top: 0; left: 0;
    transform: translate(-100px, -100px);
    transition: transform .18s cubic-bezier(.22,.61,.36,1), opacity .4s ease;
    opacity: 0; will-change: transform, opacity;
  }
  /* Arrow pointer, tinted by the per-agent hue. */
  #arrow {
    width: 0; height: 0;
    border-left: 9px solid transparent;
    border-right: 9px solid transparent;
    border-top: 15px solid hsl(var(--hue, 210), 90%, 60%);
    transform: rotate(-35deg);
    filter: drop-shadow(0 1px 2px rgba(0,0,0,.45));
  }
  /* The "ryu" tag riding next to the cursor. */
  #label {
    position: absolute; left: 12px; top: 12px;
    padding: 1px 6px; border-radius: 6px;
    font-size: 11px; font-weight: 600; line-height: 1.4;
    color: #fff; white-space: nowrap;
    background: hsl(var(--hue, 210), 85%, 52%);
    box-shadow: 0 2px 8px rgba(0,0,0,.35);
  }
  .ripple {
    position: absolute; border-radius: 50%;
    border: 2px solid hsl(var(--hue, 210), 90%, 62%);
    transform: translate(-50%, -50%) scale(.2); opacity: .9;
    animation: rip .5s ease-out forwards; pointer-events: none;
  }
  @keyframes rip {
    to { transform: translate(-50%, -50%) scale(1); opacity: 0; }
  }
</style>
</head>
<body>
  <div id="cursor">
    <div id="arrow"></div>
    <div id="label">ryu</div>
  </div>
  <script>
    var cursor = document.getElementById('cursor');
    var fadeTimer = null;
    function ripple(x, y, hue) {
      var r = document.createElement('div');
      r.className = 'ripple';
      r.style.left = x + 'px';
      r.style.top = y + 'px';
      r.style.width = '34px';
      r.style.height = '34px';
      r.style.setProperty('--hue', hue);
      document.body.appendChild(r);
      setTimeout(function () { r.remove(); }, 520);
    }
    function ghost(phase, x, y, hue) {
      cursor.style.setProperty('--hue', hue);
      // Reposition only for phases that carry a real target; type/done keep the
      // last position so the cursor doesn't jump to (0,0) for a keystroke.
      if (phase === 'move' || phase === 'down' || phase === 'up' || phase === 'scroll') {
        cursor.style.transform = 'translate(' + x + 'px, ' + y + 'px)';
      }
      cursor.style.opacity = '1';
      if (phase === 'down') { ripple(x, y, hue); }
      if (fadeTimer) { clearTimeout(fadeTimer); }
      fadeTimer = setTimeout(function () { cursor.style.opacity = '0'; }, 3000);
    }
    window.__ghost = ghost;
  </script>
</body>
</html>`;

let overlay: BrowserWindow | null = null;
let ready = false;
/** Events that arrived before the page finished loading; flushed on ready. */
const pending: Array<{ phase: string; x: number; y: number; hue: number }> = [];
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

/** Stable 0-359 hue from an agent id so each agent gets a recognisable colour. */
function hueForAgent(agent: string): number {
	let hash = 0;
	for (let i = 0; i < agent.length; i++) {
		hash = (hash * 31 + agent.charCodeAt(i)) | 0;
	}
	return Math.abs(hash) % 360;
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
			forward(win, ev.phase, ev.x, ev.y, ev.hue);
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
	hue: number
): void {
	if (win.isDestroyed()) {
		return;
	}
	win.webContents
		.executeJavaScript(
			`window.__ghost(${JSON.stringify(phase)},${x},${y},${hue})`
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
		const hue = hueForAgent(event.agent || "0");
		if (ready) {
			forward(win, event.phase, localX, localY, hue);
		} else {
			pending.push({ phase: event.phase, x: localX, y: localY, hue });
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
