import type { InterfaceParamsByRenderer } from "@ryuhq/protocol/interfaces";
import { type buildFloor, floorFit } from "./arcade-model.ts";
import type { ArcadeMode } from "./arcade-palette.ts";
import { wallHeight } from "./arcade-wall.tsx";
import { gameSheetCover } from "./game-shell.tsx";

/** The floor's padding beside the aisle: room for the walk buttons. */
export const FLOOR_PADDING = 56;
/** The carpet between the marquee and the toppers, with the filter chips. */
export const FLOOR_TOP = 24;
export const FILTERS_HEIGHT = 40 + 20;
/** Room the HUD's bottom row (meters, paytable) keeps under the machines. */
export const HUD_BOTTOM = 92;

/** Fit the hall's players and cabinets: marquees above, cabinets below. */
export const ARCADE_PLATE_FIT = { above: 1.5, below: 1.9, max: 2.6, side: 1.7 };
/**
 * With the act layer: room over the heads for the station boards, and
 * beside the outer players for their bubbles.
 */
export const ARCADE_ACT_PLATE_FIT = {
	above: 1,
	below: 0.9,
	max: 2.6,
	side: 1.2,
};

/** The hall's lights: the color theme's (dark is night), or the setting's. */
export function arcadeLights(
	lights: Required<InterfaceParamsByRenderer["arcade"]>["lights"],
	themeMode: ArcadeMode
): ArcadeMode {
	if (lights === "day") {
		return "light";
	}
	return lights === "night" ? "dark" : themeMode;
}

/**
 * The floor's geometry: the sheet's cover, the width the HUD and the aisle
 * share, and how the machines fit what is left.
 */
export function arcadeFloorGeometry({
	filterId,
	floor,
	floorSize,
	sheetOpen,
}: {
	filterId: string | null;
	floor: ReturnType<typeof buildFloor>;
	floorSize: { height: number; width: number };
	sheetOpen: boolean;
}) {
	const cover = sheetOpen ? gameSheetCover(floorSize.width) : 0;
	const sheetCover = cover < floorSize.width ? cover : 0;
	const hudWidth = floorSize.width > 0 ? floorSize.width - sheetCover : 1440;
	const compact = hudWidth < 640;
	const wall = wallHeight(hudWidth);
	const filters = floor.wall.length > 0 || filterId !== null;
	const fit = floorFit(
		floor.machines.length,
		hudWidth - FLOOR_PADDING * 2,
		floorSize.height > 0
			? floorSize.height -
					wall -
					FLOOR_TOP -
					(filters ? FILTERS_HEIGHT : 0) -
					(compact ? 72 : HUD_BOTTOM)
			: Number.POSITIVE_INFINITY
	);
	return { compact, filters, fit, hudWidth, sheetCover };
}
