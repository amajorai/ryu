import { MINIMAP_HEIGHT, MINIMAP_WIDTH } from "./canvas-minimap.tsx";
import {
	CARD_HEIGHT,
	CARD_WIDTH,
	type CanvasArrange,
	type CanvasCamera,
	type CanvasClearance,
	type CanvasEdge,
	type CanvasLayout,
	type CanvasPoint,
	type CanvasRect,
	type CanvasViewport,
	cardPosition,
	cardRect,
	findFreeSpot,
	fitFrames,
} from "./canvas-model.ts";

/** Below this width the open thread covers the canvas instead of docking. */
export const DOCK_MIN_WIDTH = 768;
/** Pointer travel (px) before a press becomes a drag rather than a click. */
export const DRAG_THRESHOLD = 3;
/** A dropped sticky waits this long for the host to create its thread. */
export const DROP_TIMEOUT_MS = 15_000;
export const SAFE_TOP = 64;
export const SAFE_BOTTOM = 76;
/** The minimap can show from this viewport width up. */
export const MINIMAP_MIN_WIDTH = 640;
/** Below this width it starts hidden, so it does not sit on the stickies. */
export const MINIMAP_DEFAULT_WIDTH = 1100;
/** A window narrower than that fits the opening board down to this zoom. */
export const NARROW_FLOOR = 0.5;
/**
 * Off-screen pills sit in the dock's row, never over a sticky: "left" before
 * the tools, the rest after them. A phone-width dock has no room beside it,
 * so there only "below" joins the dock and the others float at their edge.
 */
export const DOCK_EDGES_BEFORE: readonly CanvasEdge[] = ["left"];
export const DOCK_EDGES_AFTER: readonly CanvasEdge[] = [
	"top",
	"bottom",
	"right",
];
export const NO_EDGES: readonly CanvasEdge[] = [];
export const PHONE_DOCK_EDGES: readonly CanvasEdge[] = ["bottom"];
export const PHONE_SIDE_EDGES: readonly CanvasEdge[] = ["left", "right", "top"];
/** Below this zoom the compact stickies drop their footer for a longer title. */
export const TINY_ZOOM = 0.5;
/** How long a camera move (fit, reveal, zoom step) glides. */
export const CAMERA_GLIDE_MS = 340;
/**
 * Opening zoom floor. A desktop-wide window opens at 100%, the way FigJam
 * and tldraw open a board: the stickies' 11px meta stays 11px on screen, and
 * a board wider than the window runs off its edge to be panned to, instead of
 * every sticky shrinking to fit. A narrow window fits the board (stickies
 * show their compact face there), down to half size; a phone fits the
 * board's width and scrolls down the column of frames. Switching the
 * arrangement and resetting the layout open the new board the same way.
 */
export function openingFloor(width: number, boardWidth: number): number {
	if (width < MINIMAP_MIN_WIDTH) {
		const widthFit = (width - SAFE_INSETS.left * 2 - 32) / boardWidth;
		return Math.min(0.75, Math.max(0.3, widthFit));
	}
	return width < MINIMAP_DEFAULT_WIDTH ? NARROW_FLOOR : 1;
}

export function sameCamera(a: CanvasCamera, b: CanvasCamera): boolean {
	return (
		Math.abs(a.x - b.x) < 0.5 &&
		Math.abs(a.y - b.y) < 0.5 &&
		Math.abs(a.zoom - b.zoom) < 0.001
	);
}

/** The minimap's corner, which a fit keeps clear of every frame and sticky. */
export function minimapClearance(
	shown: boolean,
	viewport: CanvasViewport,
	pieces: readonly CanvasRect[]
): CanvasClearance | undefined {
	if (!shown) {
		return undefined;
	}
	return {
		blockedRight: MINIMAP_WIDTH + 24,
		obstacles: [
			{
				height: MINIMAP_HEIGHT,
				width: MINIMAP_WIDTH,
				x: viewport.width - 16 - MINIMAP_WIDTH,
				y: viewport.height - 16 - MINIMAP_HEIGHT,
			},
		],
		pieces,
	};
}

export function stickyRects(
	layout: CanvasLayout,
	overrides: Readonly<Record<string, CanvasPoint>>
): CanvasRect[] {
	return layout.cards.map((card) => cardRect(cardPosition(card, overrides)));
}

/** Everything a fit keeps clear of the minimap: the frames and every sticky. */
export function boardPieces(
	layout: CanvasLayout,
	overrides: Readonly<Record<string, CanvasPoint>>
): CanvasRect[] {
	return [
		...fitFrames(layout, overrides).rects.values(),
		...stickyRects(layout, overrides),
	];
}

/**
 * Screen space the header, dock and minimap cover, which "Zoom to fit" keeps
 * clear so no sticky starts out hidden under the chrome.
 */
export const SAFE_INSETS = {
	bottom: SAFE_BOTTOM,
	left: 16,
	right: 16,
	top: SAFE_TOP,
} as const;

/** How far (screen px) the drop ghost may slide off the double-click to clear a sticky. */
export const DROP_SEARCH_RADIUS = 96;

/**
 * Where the drop ghost goes, the way tldraw places a new shape: centred on the
 * double-click. Frames are drop targets, not obstacles; only another sticky
 * (or the minimap) nudges it, and only a short way. On a crowded spot it stays
 * at the click: overlap is fine on a canvas, a jump across the board is not.
 */
export function placeDropGhost(
	desired: CanvasPoint,
	obstacles: readonly CanvasRect[],
	zoom: number
): CanvasPoint {
	const near = findFreeSpot(
		desired,
		{ height: CARD_HEIGHT, width: CARD_WIDTH },
		obstacles,
		{
			gap: 8 / zoom,
			radius: DROP_SEARCH_RADIUS / zoom,
			step: Math.max(4, 8 / zoom),
		}
	);
	const spot = near ?? desired;
	return { x: Math.round(spot.x), y: Math.round(spot.y) };
}

export type Gesture =
	| {
			camera: CanvasCamera;
			fromCard: boolean;
			kind: "pan";
			moved: boolean;
			start: CanvasPoint;
	  }
	| {
			/** Where the sticky was grabbed, from its top-left (world units). */
			grab: CanvasPoint;
			id: string;
			kind: "card";
			moved: boolean;
			point: CanvasPoint;
			start: CanvasPoint;
	  }
	| {
			camera: CanvasCamera;
			distance: number;
			kind: "pinch";
			middle: CanvasPoint;
	  };

export interface ComposerState {
	agentId: string | undefined;
	/** Top-left of the sticky the new thread will become, in world units. */
	world: CanvasPoint;
}

export interface PendingDrop {
	arrange: CanvasArrange;
	known: Set<string>;
	world: CanvasPoint;
}

export function distanceBetween(a: CanvasPoint, b: CanvasPoint): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

export function midpoint(a: CanvasPoint, b: CanvasPoint): CanvasPoint {
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
