import type { WorldLayout, WorldPoint } from "@ryuhq/protocol/interfaces";
import type { SceneFrame } from "./world-2d-layout.ts";
import { lastStreet } from "./world-2d-model.ts";
import { PX } from "./world-2d-pixel.ts";

export interface ViewportSize {
	height: number;
	width: number;
}

/** Used until the viewport is measured (and for server rendering). */
export const FALLBACK_VIEWPORT: ViewportSize = { height: 700, width: 1024 };

let canvas2dSupport: boolean | null = null;
/**
 * Whether this document can paint a 2D canvas. Without one (SSR, or a test
 * DOM such as happy-dom) the baked pixel scene could never be drawn, so the
 * renderer skips building it.
 */
export function canPaint2d(): boolean {
	if (canvas2dSupport === null) {
		canvas2dSupport =
			typeof document !== "undefined" &&
			document.createElement("canvas").getContext("2d") !== null;
	}
	return canvas2dSupport;
}
/** How the camera frames one axis: where the player sits, and edge peeks. */
interface CameraAxis {
	/** Where the player sits in the free view, 0 (start) to 1 (end). */
	anchor: number;
	/** Art pixels at the end of the view covered by the HUD. */
	endInset: number;
	/** Tiles past each world edge the camera may show. */
	peekEnd: number;
	peekStart: number;
}

const CAMERA_X: CameraAxis = {
	anchor: 0.5,
	endInset: 0,
	peekEnd: 1,
	peekStart: 1,
};
/**
 * The player sits mid-view in the north of the village and lower toward
 * the square (see `lookNorth`), so from the square the camera looks ahead
 * into town and the first row of roofs and chimneys is in shot. The bottom
 * keeps room for the hotbar so the square's furniture never hides under it.
 */
const CAMERA_Y: CameraAxis = {
	anchor: 0.5,
	endInset: 34,
	peekEnd: 1,
	peekStart: 1,
};

/**
 * Camera offset on one axis, in art pixels: follow the player, stop at the
 * world edges, and center a world smaller than the viewport.
 */
function cameraAxis(
	view: number,
	worldTiles: number,
	marginTiles: number,
	playerTile: number,
	axis: CameraAxis
): number {
	const origin = marginTiles * PX;
	const worldPx = worldTiles * PX;
	const free = view - axis.endInset;
	if (worldPx + (axis.peekStart + axis.peekEnd) * PX <= free) {
		return Math.round(free / 2 - (origin + worldPx / 2));
	}
	const follow = free * axis.anchor - (origin + (playerTile + 0.5) * PX);
	const min = free - (origin + worldPx + axis.peekEnd * PX);
	const max = -(origin - axis.peekStart * PX);
	return Math.round(Math.min(max, Math.max(min, follow)));
}

/**
 * Indoors the camera may rise to show the papered back wall, and shows a
 * strip of the front wall's wainscot below the floor.
 */
const CAMERA_Y_INDOOR: CameraAxis = {
	...CAMERA_Y,
	peekEnd: 0.6,
	peekStart: 2,
};

/**
 * At the village's south edge the player sits as low in the view as leaves
 * this many tiles below them clear of the hotbar (the square's fountain).
 */
const SOUTH_ROOM_TILES = 0.3;
const MAX_SOUTH_ANCHOR = 0.95;

/**
 * Outdoors the camera looks north the further south the player is: mid-view
 * among the cottages, sliding to low in the view as the player walks from
 * the last street down onto the square (keeping the fountain below clear of
 * the hotbar), so the cottages' roofs stay in shot from the square.
 */
function lookNorth(
	layout: WorldLayout,
	player: WorldPoint,
	viewHeight: number,
	base: CameraAxis
): CameraAxis {
	const free = viewHeight - base.endInset;
	const southAnchor = Math.min(
		MAX_SOUTH_ANCHOR,
		Math.max(base.anchor, (free - SOUTH_ROOM_TILES * PX) / free)
	);
	const north = Math.max(0, lastStreet(layout));
	const span = layout.height - 1 - north;
	const south = span > 0 ? (player.y - north) / span : 0;
	return {
		...base,
		anchor:
			base.anchor +
			(southAnchor - base.anchor) * Math.min(1, Math.max(0, south)),
	};
}

/**
 * While talking, the camera holds the villager mid-view and stops at the
 * village's south edge (the square's curb), so the conversation is framed
 * by the cottages around it rather than by empty paving under the hotbar.
 */
const TALKING_ANCHOR = 0.5;
/** Highest in the view the talking villager is lifted (share of it). */
const TALKING_ANCHOR_MIN = 0.36;
/** Art pixels kept between the next row's feet and the hotbar. */
const TALKING_FOOT_ROOM = 4;

/**
 * Where in the view the talking villager sits: mid-view, lifted (up to
 * {@link TALKING_ANCHOR_MIN}) so the villagers on the next street down
 * stand fully above the hotbar instead of under it.
 */
function talkingAnchor(
	layout: WorldLayout,
	player: WorldPoint,
	free: number
): number {
	let next: number | null = null;
	for (const entity of layout.entities) {
		if (entity.y > player.y && (next === null || entity.y < next)) {
			next = entity.y;
		}
	}
	if (next === null || free <= 0) {
		return TALKING_ANCHOR;
	}
	const below = (next - player.y + 0.5) * PX;
	const lifted = (free - TALKING_FOOT_ROOM - below) / free;
	return Math.min(TALKING_ANCHOR, Math.max(TALKING_ANCHOR_MIN, lifted));
}

/**
 * The village's last row holds the square's sign, fountain and notice
 * board. Rather than leave them sliced by the view's bottom edge (or under
 * the hotbar), once any of that row is in view the camera rises to show it
 * whole above the hotbar.
 */
function revealBottomRow(
	y: number,
	viewHeight: number,
	worldTiles: number,
	marginTiles: number,
	endInset: number
): number {
	const rowTop = y + (marginTiles + worldTiles - 1) * PX;
	const rowBottom = rowTop + PX;
	const free = viewHeight - endInset;
	if (rowTop < viewHeight && rowBottom > free) {
		return y - (rowBottom - free);
	}
	return y;
}

export function cameraOffset(
	layout: WorldLayout,
	frame: SceneFrame,
	view: ViewportSize,
	player: WorldPoint,
	options: {
		indoor: boolean;
		/** Rows down to the square's curb, or null outside a conversation. */
		talkingRows: number | null;
	}
): WorldPoint {
	const base = options.indoor ? CAMERA_Y_INDOOR : CAMERA_Y;
	const x = cameraAxis(
		view.width,
		layout.width,
		frame.margin.x,
		player.x,
		CAMERA_X
	);
	if (options.talkingRows !== null && !options.indoor) {
		return {
			x,
			y: cameraAxis(
				view.height,
				Math.min(layout.height, options.talkingRows),
				frame.margin.y,
				player.y,
				{
					...base,
					anchor: talkingAnchor(layout, player, view.height - base.endInset),
					peekEnd: 0.3,
				}
			),
		};
	}
	const y = cameraAxis(
		view.height,
		layout.height,
		frame.margin.y,
		player.y,
		lookNorth(layout, player, view.height, base)
	);
	return {
		x,
		y: revealBottomRow(
			y,
			view.height,
			layout.height,
			frame.margin.y,
			base.endInset
		),
	};
}
