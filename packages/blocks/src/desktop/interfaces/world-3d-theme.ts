import type {
	WorldLayout,
	WorldPoint,
	WorldTheme,
} from "@ryuhq/protocol/interfaces";
import {
	GAME3D_DAY,
	GAME3D_NIGHT,
	OFFICE_THEME,
	type Scene3dTheme,
	type Vec3,
} from "./game3d-palette.ts";

/**
 * World 3D's places: the meadow and night islands are the game kit's shared
 * day and night dioramas (see game3d-palette.ts); the office is its own.
 */
export const SCENE_THEMES: Record<WorldTheme, Scene3dTheme> = {
	meadow: GAME3D_DAY,
	night: GAME3D_NIGHT,
	office: OFFICE_THEME,
};

/** Tile x maps to world x and tile y to world z, centered on the origin. */
export function tileToWorld(
	layout: WorldLayout,
	point: WorldPoint,
	height = 0
): Vec3 {
	return [
		point.x - (layout.width - 1) / 2,
		height,
		point.y - (layout.height - 1) / 2,
	];
}

/** The tile under a world position (tileToWorld's inverse), kept on the grid. */
export function worldToTile(layout: WorldLayout, position: Vec3): WorldPoint {
	const clamp = (value: number, size: number) =>
		Math.min(Math.max(Math.round(value), 0), Math.max(0, size - 1));
	return {
		x: clamp(position[0] + (layout.width - 1) / 2, layout.width),
		y: clamp(position[2] + (layout.height - 1) / 2, layout.height),
	};
}
