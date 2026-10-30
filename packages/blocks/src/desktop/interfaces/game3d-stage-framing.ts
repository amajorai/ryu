import {
	GAME3D_DAY,
	GAME3D_NIGHT,
	type Scene3dTheme,
	type Vec3,
} from "./game3d-palette.ts";

/** The fixed isometric angle: yaw 45 degrees, pitch about 32 degrees. */
export const YAW = Math.PI / 4;
const PITCH = 0.56;
/** Portrait stages tilt steeper so the diorama's depth reads taller. */
export const PORTRAIT_PITCH = 0.78;
/** Portrait fits let the frame bleed at most this much (the island rim). */
const PORTRAIT_FILL = 1.06;

/** The box the camera keeps in frame, in world units. */
export interface IsoBounds {
	maxX: number;
	maxZ: number;
	minX: number;
	minZ: number;
	/** Height of the tallest content (roofs, trees, plates). */
	top?: number;
}

/** Pixels kept clear for the HUD on each side of the stage. */
export interface IsoInsets {
	bottom: number;
	left: number;
	right: number;
	top: number;
}

export const NO_INSETS: IsoInsets = { bottom: 0, left: 0, right: 0, top: 0 };

/** The scene theme for day or night. */
export function sceneTheme(night: boolean): Scene3dTheme {
	return night ? GAME3D_NIGHT : GAME3D_DAY;
}

/** The camera's angle: yaw around the vertical, pitch down from level. */
export interface IsoAngle {
	pitch: number;
	yaw: number;
}

export const ISO_ANGLE: IsoAngle = { pitch: PITCH, yaw: YAW };

/** Toward the camera, screen right and screen up, for an angle. */
interface IsoBasis {
	right: Vec3;
	toward: Vec3;
	up: Vec3;
}

export function isoBasis({ pitch, yaw }: IsoAngle): IsoBasis {
	const toward: Vec3 = [
		Math.cos(pitch) * Math.sin(yaw),
		Math.sin(pitch),
		Math.cos(pitch) * Math.cos(yaw),
	];
	const right: Vec3 = [Math.cos(yaw), 0, -Math.sin(yaw)];
	const up: Vec3 = [
		toward[1] * right[2] - toward[2] * right[1],
		toward[2] * right[0] - toward[0] * right[2],
		toward[0] * right[1] - toward[1] * right[0],
	];
	return { right, toward, up };
}

/** How a stage frames itself when it is taller than wide (a phone). */
export interface IsoPortrait {
	/** A tighter box to fit there (the content, not the whole island). */
	bounds?: IsoBounds;
	/** Fill there (default 1.06: only the island's rim bleeds). */
	fill?: number;
	/**
	 * Zoom on to the plates once they are placed (default true unless
	 * `bounds` is given): the agents and controls fill the phone and only
	 * the island's empty rim is cropped (drag pans to it).
	 */
	fitPlates?: boolean;
	/** Camera pitch there (default `PORTRAIT_PITCH`). */
	pitch?: number;
	/** Camera yaw there (default 45 degrees; larger turns +x up-screen). */
	yaw?: number;
}

/**
 * Zoom on to the plates on every stage shape, not only portrait ones: the
 * world units kept around them (`above`, `below` for the bodies under
 * name plates, `side`) and the furthest it zooms (`max`, default 1.8).
 */
export interface IsoPlateFit {
	above?: number;
	below?: number;
	max?: number;
	side?: number;
}

/** Whether the room between the insets is taller than wide. */
export function isPortraitStage(
	width: number,
	height: number,
	insets: IsoInsets = NO_INSETS
): boolean {
	return (
		width - insets.left - insets.right < height - insets.top - insets.bottom
	);
}

/** The bounds, angle and fill a stage of this shape frames with. */
export function isoFraming(
	bounds: IsoBounds,
	fill: number,
	portrait: IsoPortrait | undefined,
	isPortrait: boolean
): { angle: IsoAngle; bounds: IsoBounds; fill: number } {
	if (!isPortrait) {
		return { angle: ISO_ANGLE, bounds, fill };
	}
	return {
		angle: {
			pitch: portrait?.pitch ?? PORTRAIT_PITCH,
			yaw: portrait?.yaw ?? YAW,
		},
		bounds: portrait?.bounds ?? bounds,
		fill: portrait?.fill ?? Math.min(fill, PORTRAIT_FILL),
	};
}

/** The fitted framing: zoom and the content box on the screen plane. */
export interface IsoFit {
	/** Content extent across and up the screen plane, in world units. */
	across: number;
	/** The content's middle on the screen plane (right, up). */
	middle: [number, number];
	tall: number;
	zoom: number;
}

/**
 * Fits `bounds` (with its height) into the stage minus `insets`: the
 * orthographic zoom in pixels per world unit, and where the content sits.
 */
export function fitIso(
	bounds: IsoBounds,
	width: number,
	height: number,
	insets: IsoInsets,
	fill = 1,
	angle: IsoAngle = ISO_ANGLE
): IsoFit {
	const { right: axisRight, up: axisUp } = isoBasis(angle);
	let minRight = Number.POSITIVE_INFINITY;
	let maxRight = Number.NEGATIVE_INFINITY;
	let minUp = Number.POSITIVE_INFINITY;
	let maxUp = Number.NEGATIVE_INFINITY;
	for (const x of [bounds.minX, bounds.maxX]) {
		for (const z of [bounds.minZ, bounds.maxZ]) {
			for (const y of [0, bounds.top ?? 2]) {
				const right = x * axisRight[0] + z * axisRight[2];
				const up = x * axisUp[0] + y * axisUp[1] + z * axisUp[2];
				minRight = Math.min(minRight, right);
				maxRight = Math.max(maxRight, right);
				minUp = Math.min(minUp, up);
				maxUp = Math.max(maxUp, up);
			}
		}
	}
	const across = Math.max(0.1, maxRight - minRight);
	const tall = Math.max(0.1, maxUp - minUp);
	const availableWidth = Math.max(80, width - insets.left - insets.right);
	const availableHeight = Math.max(80, height - insets.top - insets.bottom);
	return {
		across,
		middle: [(minRight + maxRight) / 2, (minUp + maxUp) / 2],
		tall,
		zoom: Math.min(availableWidth / across, availableHeight / tall) * fill,
	};
}
