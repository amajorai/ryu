import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app, type BrowserWindow, type Display, screen } from "electron";
import { getEdgeOffset } from "./edge-offset.ts";
import {
	crossDisplayPosition,
	fitVisibleIsland,
	type PillRect,
	type Point,
	type VisibleIsland,
	zoneIndexForPoint,
	zoneWindowPosition,
} from "./zones.ts";

// Resting visible-island geometry, mirrored from the renderer
// (`renderer/components/island-config.ts` + `Island.tsx`): the resting island is
// the logo circle (40) + split gap (8) + idle detail pill (96) = 144 wide, 40
// tall, centered horizontally in the window and pinned `pt-2` (8px) below its
// top. Restore runs while the island is at rest, so this is the box to keep on
// screen. A small horizontal pad keeps it from sitting flush against a seam.
const RESTING_VISIBLE_WIDTH = 144;
const RESTING_VISIBLE_HEIGHT = 40;
const RESTING_TOP_INSET = 8;
const EDGE_PAD = 8;

/** Persisted window position on disk, in screen coordinates. */
interface StoredPosition {
	x: number;
	y: number;
}

/** Absolute path to the JSON file holding the persisted island position. */
function positionFilePath(): string {
	return join(app.getPath("userData"), "island", "window.json");
}

/** Read the persisted position, or `null` if none/invalid. */
export function readStoredPosition(): StoredPosition | null {
	try {
		const raw = readFileSync(positionFilePath(), "utf8");
		const parsed = JSON.parse(raw) as Partial<StoredPosition>;
		if (typeof parsed.x === "number" && typeof parsed.y === "number") {
			return { x: parsed.x, y: parsed.y };
		}
	} catch {
		// No file yet, or it is corrupt: fall back to the default position.
	}
	return null;
}

/** Write the position to disk, creating the parent directory if needed. */
export function writeStoredPosition(position: StoredPosition): void {
	try {
		const file = positionFilePath();
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify(position), "utf8");
	} catch {
		// Persistence is best-effort; never crash the app over it.
	}
}

/**
 * Keep the *visible* island wholly on a single display while allowing the
 * oversized, click-through window to overflow the screen edges. We test the
 * island's full box (not just a point), so an edge/corner snap where only the
 * transparent window overflows survives, but a position that strands the island
 * off-screen -- or across a multi-monitor seam -- is re-homed to the top-center
 * of the nearest display. See {@link fitVisibleIsland}.
 *
 * `acrylic` windows *are* the island (content-tracked), so the visible box is
 * the whole window; translucent windows use the fixed resting island geometry.
 */
export function ensureOnScreen(
	x: number,
	y: number,
	width: number,
	acrylic = false,
	height = 0
): StoredPosition {
	const island: VisibleIsland = acrylic
		? {
				windowWidth: width,
				width: width + EDGE_PAD * 2,
				height: height || RESTING_VISIBLE_HEIGHT,
				topInset: 0,
			}
		: {
				windowWidth: width,
				width: RESTING_VISIBLE_WIDTH + EDGE_PAD * 2,
				height: RESTING_VISIBLE_HEIGHT,
				topInset: RESTING_TOP_INSET,
			};
	const areas = screen.getAllDisplays().map((display) => display.workArea);
	return fitVisibleIsland({ x, y }, island, getEdgeOffset(), areas);
}

/**
 * The visible-island shape's geometry inside its window, used to snap the *pill*
 * (not the oversized window) to a zone. Translucent windows draw a fixed resting
 * island centered + `RESTING_TOP_INSET` below the top; acrylic windows *are* the
 * island, so the shape fills the whole window.
 */
export function restingPill(
	width: number,
	height: number,
	acrylic: boolean
): PillRect {
	if (acrylic) {
		return { offsetX: 0, offsetY: 0, width, height };
	}
	return {
		offsetX: (width - RESTING_VISIBLE_WIDTH) / 2,
		offsetY: RESTING_TOP_INSET,
		width: RESTING_VISIBLE_WIDTH,
		height: RESTING_VISIBLE_HEIGHT,
	};
}

/**
 * Re-dock the resting island to the edge offset currently in {@link getEdgeOffset}.
 *
 * The snap inset only takes effect during a drag, so a live offset change would
 * otherwise not move an at-rest island until the user dragged it again. This
 * infers which of the nine zones the island is resting in (from its visible pill
 * center) and re-applies that zone's anchor with the new offset, so changing the
 * setting visibly re-positions the island immediately. Centered zones are
 * offset-independent, so an island parked in the middle simply stays put.
 */
export function applyEdgeOffset(win: BrowserWindow, acrylic = false): void {
	if (win.isDestroyed()) {
		return;
	}
	const [x, y] = win.getPosition();
	const [width, height] = win.getSize();
	const pill = restingPill(width, height, acrylic);
	const center: Point = {
		x: x + pill.offsetX + pill.width / 2,
		y: y + pill.offsetY + pill.height / 2,
	};
	const area = screen.getDisplayNearestPoint(center).workArea;
	const zone = zoneIndexForPoint(area, center);
	const target = zoneWindowPosition(area, zone, pill, getEdgeOffset());
	win.setPosition(target.x, target.y);
	writeStoredPosition(target);
}

/**
 * The display the island is currently resting on (from its visible pill center),
 * the display the user is active on (under the cursor), and the visible pill
 * geometry — the shared inputs for {@link isIslandOnActiveDisplay} and
 * {@link moveToActiveDisplay}. Returns `null` when the window is gone.
 */
function activeDisplaySnapshot(
	win: BrowserWindow,
	acrylic: boolean
): { active: Display; center: Point; current: Display; pill: PillRect } | null {
	if (win.isDestroyed()) {
		return null;
	}
	const active = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
	const [x, y] = win.getPosition();
	const [width, height] = win.getSize();
	const pill = restingPill(width, height, acrylic);
	const center: Point = {
		x: x + pill.offsetX + pill.width / 2,
		y: y + pill.offsetY + pill.height / 2,
	};
	const current = screen.getDisplayNearestPoint(center);
	return { active, center, current, pill };
}

/**
 * Whether the island already sits on the display the user is active on (the one
 * under the cursor). The auto-jump loop polls this to debounce: it only counts
 * toward a jump while the cursor is genuinely on another monitor. A single-monitor
 * setup always returns `true`, so the feature is a no-op there.
 */
export function isIslandOnActiveDisplay(
	win: BrowserWindow,
	acrylic = false
): boolean {
	const snap = activeDisplaySnapshot(win, acrylic);
	return snap === null || snap.current.id === snap.active.id;
}

/**
 * Move the resting island onto the display the user is currently active on (the
 * one under the cursor), preserving the zone it is docked in. Backs the "auto-jump
 * to active monitor" preference: when the cursor settles on a different monitor,
 * the island follows it there and re-anchors to the same corner/edge/center.
 *
 * No-op (returns `false`) when the island is already on the active display, so a
 * single-monitor setup never moves and the poll loop never churns position writes.
 * Returns `true` when it actually moved.
 */
export function moveToActiveDisplay(
	win: BrowserWindow,
	acrylic = false
): boolean {
	const snap = activeDisplaySnapshot(win, acrylic);
	if (snap === null || snap.current.id === snap.active.id) {
		return false;
	}
	const target = crossDisplayPosition(
		snap.current.workArea,
		snap.active.workArea,
		snap.center,
		snap.pill,
		getEdgeOffset()
	);
	win.setPosition(target.x, target.y);
	writeStoredPosition(target);
	return true;
}

/**
 * Apply the persisted position to the window, if one exists. Uses the looser
 * {@link ensureOnScreen} so edge/corner snaps (where the window overflows the
 * screen) survive a restart. Called once on startup after the window is created.
 */
export function restorePosition(win: BrowserWindow, acrylic = false): void {
	const stored = readStoredPosition();
	if (!stored) {
		return;
	}
	const [width, height] = win.getSize();
	const { x, y } = ensureOnScreen(stored.x, stored.y, width, acrylic, height);
	win.setPosition(x, y);
}
