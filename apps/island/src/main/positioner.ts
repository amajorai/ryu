// The island's on-screen positioner: one per island window.
//
// It owns the island's anchor (see `anchor.ts` / `shared/placement.ts`) and is
// the only thing that moves the window. Every input -- a footprint change from
// the renderer, a drag drop, an edge-offset change, a monitor change, auto-jump --
// updates either the footprint size or the anchor, then re-lays the window out
// from those two values. Nothing is inferred back from the window's current
// position, which is what made expand/collapse drift near corners.

import { type BrowserWindow, type Display, screen } from "electron";
import { WIN_CHANNELS } from "../shared/ipc.ts";
import {
	type IslandPlacement,
	samePlacement,
	TRANSLUCENT_WINDOW_INSET,
} from "../shared/placement.ts";
import {
	anchorForDrop,
	dockedAnchor,
	fitAnchor,
	groupRectInWindow,
	type IslandAnchor,
	placeAtAnchor,
	RESTING_FOOTPRINT,
	rectAt,
	rectCenter,
	type Size,
	windowOriginFor,
} from "./anchor.ts";
import { getEdgeOffset } from "./edge-offset.ts";
import { getNotchGeometry } from "./notch.ts";
import { writeStoredAnchor } from "./position-store.ts";
import type { Point, Rect } from "./zones.ts";

/**
 * Duration (ms) of the window glide used when a footprint change has to move the
 * translucent window (the footprint is shifted to stay on a display). Tuned to
 * roughly track the content morph spring (`ISLAND_SPRING`, ~0.5s).
 */
const WINDOW_GLIDE_MS = 360;
/** Frame interval (ms) for the glide tween (~60fps). */
const GLIDE_FRAME_MS = 16;
/**
 * How long (ms) to wait for the renderer to lay out a new placement before the
 * translucent window moves anyway (a hung or reloading renderer must not strand
 * the island at its pre-drop position).
 */
const PLACEMENT_COMMIT_TIMEOUT_MS = 150;

/** Ease-out cubic: fast start, gentle settle -- close to the spring's feel. */
function easeOutCubic(t: number): number {
	return 1 - (1 - t) ** 3;
}

/** Positions one island window from its anchor + current footprint size. */
export class IslandPositioner {
	private anchor: IslandAnchor;
	private size: Size;
	/** Placement the renderer currently lays its group out with. */
	private shownPlacement: IslandPlacement;
	private glideTimer: ReturnType<typeof setInterval> | null = null;
	private pendingPlacement: {
		placement: IslandPlacement;
		timer: ReturnType<typeof setTimeout>;
	} | null = null;
	private readonly win: BrowserWindow;
	private readonly material: boolean;

	constructor(
		win: BrowserWindow,
		material: boolean,
		anchor: IslandAnchor,
		size: Size
	) {
		this.win = win;
		this.material = material;
		this.anchor = anchor;
		this.size = size;
		this.shownPlacement = anchor.placement;
	}

	/** Whether this window is positioned by the notch, not by the anchor. */
	private get inactive(): boolean {
		return this.win.isDestroyed() || getNotchGeometry() !== null;
	}

	/** The display the anchored island belongs to. */
	display(): Display {
		return screen.getDisplayNearestPoint(
			rectCenter(rectAt(this.anchor, this.size))
		);
	}

	/** Where the current footprint should render: pinned, then shifted on-screen. */
	targetRect(): Rect {
		return placeAtAnchor(
			this.anchor,
			this.size,
			this.display().workArea,
			getEdgeOffset()
		);
	}

	/** Where the footprint is on screen right now (follows the window mid-drag). */
	liveRect(): Rect {
		if (this.material) {
			return this.win.getBounds();
		}
		const [x, y] = this.win.getPosition();
		const [width, height] = this.win.getSize();
		return groupRectInWindow(
			{ x, y },
			{ width, height },
			this.size,
			this.shownPlacement,
			TRANSLUCENT_WINDOW_INSET
		);
	}

	/** The footprint size last reported by the renderer. */
	footprintSize(): Size {
		return this.size;
	}

	/**
	 * Whether the current footprint had to shift off its anchor to stay on its
	 * display (e.g. a wider pill pulled in from a screen edge). The window then
	 * does not sit where the resting geometry says, so auto-jump leaves it be.
	 */
	isShiftedOffAnchor(): boolean {
		if (this.inactive) {
			return false;
		}
		const pinned = rectAt(this.anchor, this.size);
		const target = this.targetRect();
		return pinned.x !== target.x || pinned.y !== target.y;
	}

	/**
	 * Lay the window out for the current anchor + size. The material window *is*
	 * the footprint, so it takes the rect directly. The translucent window keeps
	 * its size; its group is aligned to the anchor corner by the renderer, so it
	 * only moves when the footprint had to shift on-screen -- and then glides.
	 */
	private layout(animate: boolean): Rect {
		const rect = this.targetRect();
		if (this.material) {
			this.cancelGlide();
			this.win.setBounds(rect);
			return rect;
		}
		const [width, height] = this.win.getSize();
		const origin = windowOriginFor(
			rect,
			this.shownPlacement,
			{ width, height },
			TRANSLUCENT_WINDOW_INSET
		);
		if (animate) {
			this.glideTo(origin);
		} else {
			this.cancelGlide();
			this.win.setPosition(origin.x, origin.y);
		}
		return rect;
	}

	/**
	 * A new footprint size from the renderer. Returns the rect it was laid out at
	 * (so the caller can clip the native material to it), or `null` when the
	 * window is not anchor-positioned.
	 */
	setFootprint(size: Size): Rect | null {
		if (this.inactive || size.width <= 0 || size.height <= 0) {
			return null;
		}
		this.size = size;
		return this.layout(true);
	}

	/**
	 * Re-pin the island to `anchor` and persist it. When the placement changes the
	 * renderer must re-align its group first; the translucent window waits for it
	 * (see {@link commitPlacement}) so the island never flashes at the old
	 * alignment in the new spot.
	 */
	setAnchor(anchor: IslandAnchor): void {
		if (this.inactive) {
			return;
		}
		this.anchor = anchor;
		writeStoredAnchor(anchor);
		this.clearPendingPlacement();
		if (samePlacement(anchor.placement, this.shownPlacement)) {
			this.layout(false);
			return;
		}
		this.win.webContents.send(WIN_CHANNELS.placement, anchor.placement);
		if (this.material) {
			// The material window wraps the footprint exactly, so the group's
			// alignment only matters mid-morph: move now.
			this.shownPlacement = anchor.placement;
			this.layout(false);
			return;
		}
		const placement = anchor.placement;
		this.pendingPlacement = {
			placement,
			timer: setTimeout(
				() => this.commitPlacement(placement),
				PLACEMENT_COMMIT_TIMEOUT_MS
			),
		};
	}

	/** The renderer laid out `placement`: move the window to match it. */
	commitPlacement(placement: IslandPlacement): void {
		const pending = this.pendingPlacement;
		if (!(pending && samePlacement(pending.placement, placement))) {
			return;
		}
		this.clearPendingPlacement();
		if (this.inactive) {
			return;
		}
		this.shownPlacement = placement;
		this.layout(false);
	}

	/** A drag is starting: stop any glide and settle a pending placement. */
	beginDrag(): void {
		this.cancelGlide();
		const pending = this.pendingPlacement;
		if (pending) {
			this.commitPlacement(pending.placement);
		}
	}

	/**
	 * The user dropped the island. `snapZone` is the zone it snaps to, or `null`
	 * for a free drop; `area` is the work area it was dropped on.
	 */
	drop(area: Rect, snapZone: number | null): void {
		if (this.inactive) {
			return;
		}
		this.setAnchor(
			anchorForDrop(area, this.liveRect(), snapZone, getEdgeOffset())
		);
	}

	/**
	 * Re-dock to the zone the island is docked in on `display` (its own display
	 * by default): applies a new edge offset, or carries the dock across monitors
	 * for auto-jump.
	 */
	redock(display: Display = this.display()): void {
		if (this.inactive) {
			return;
		}
		this.setAnchor(
			dockedAnchor(
				display.workArea,
				this.anchor.placement,
				RESTING_FOOTPRINT,
				getEdgeOffset()
			)
		);
	}

	/** Displays changed: keep the anchor if it is still on a display, else re-dock. */
	rehome(): void {
		if (this.inactive) {
			return;
		}
		const areas = screen.getAllDisplays().map((display) => display.workArea);
		const fitted = fitAnchor(this.anchor, areas, getEdgeOffset());
		if (fitted === this.anchor) {
			this.cancelGlide();
			this.layout(false);
			return;
		}
		this.setAnchor(fitted);
	}

	/** Stop timers; called when the window closes. */
	dispose(): void {
		this.cancelGlide();
		this.clearPendingPlacement();
	}

	private clearPendingPlacement(): void {
		if (this.pendingPlacement) {
			clearTimeout(this.pendingPlacement.timer);
			this.pendingPlacement = null;
		}
	}

	private cancelGlide(): void {
		if (this.glideTimer !== null) {
			clearInterval(this.glideTimer);
			this.glideTimer = null;
		}
	}

	/** Animate the window's top-left to `target`, easing out with the morph. */
	private glideTo(target: Point): void {
		this.cancelGlide();
		const [startX, startY] = this.win.getPosition();
		if (startX === target.x && startY === target.y) {
			return;
		}
		const startedAt = Date.now();
		this.glideTimer = setInterval(() => {
			if (this.win.isDestroyed()) {
				this.cancelGlide();
				return;
			}
			const progress = Math.min(1, (Date.now() - startedAt) / WINDOW_GLIDE_MS);
			const eased = easeOutCubic(progress);
			this.win.setPosition(
				Math.round(startX + (target.x - startX) * eased),
				Math.round(startY + (target.y - startY) * eased)
			);
			if (progress >= 1) {
				this.cancelGlide();
			}
		}, GLIDE_FRAME_MS);
	}
}

const positioners = new WeakMap<BrowserWindow, IslandPositioner>();

/** Attach a positioner to an island window (replacing any previous one). */
export function attachPositioner(
	win: BrowserWindow,
	material: boolean,
	anchor: IslandAnchor,
	size: Size
): IslandPositioner {
	const positioner = new IslandPositioner(win, material, anchor, size);
	positioners.set(win, positioner);
	win.once("closed", () => positioner.dispose());
	return positioner;
}

/** The positioner attached to `win`, if any. */
export function positionerFor(
	win: BrowserWindow
): IslandPositioner | undefined {
	return positioners.get(win);
}
