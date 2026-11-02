import {
	FOV,
	type Planet,
	type PlanetSystem,
	SUN_RADIUS,
} from "./planets-model.ts";
import { overviewElevation, overviewFrame } from "./planets-model-frame.ts";
import { EMPTY_HUD, HUD_GAP, type HudLayout } from "./planets-model-hud.ts";
import { overviewReach } from "./planets-model-orbit.ts";

/** The next or previous planet id in orbit order, wrapping around. */
export function cyclePlanet(
	planets: readonly Pick<Planet, "id">[],
	currentId: string | null,
	step: 1 | -1
): string | null {
	if (planets.length === 0) {
		return null;
	}
	const index = planets.findIndex((planet) => planet.id === currentId);
	if (index === -1) {
		return (step === 1 ? planets[0] : planets.at(-1))?.id ?? null;
	}
	const next = (index + step + planets.length) % planets.length;
	return planets[next]?.id ?? null;
}

/** Orbits a loading sketch draws before there is a system to show. */
const SKETCH_ORBITS = [11, 18, 25, 32] as const;

export interface OverviewSketch {
	/** Where the star sits in the scene, px from its top-left corner. */
	centre: { x: number; y: number };
	/** Each orbit as an SVG path in scene px, projected as the camera sees it. */
	orbits: string[];
	/** The star's radius, px. */
	sunRadius: number;
}

const SKETCH_SAMPLES = 96;

/**
 * Where the overview will put the star and its orbits, in px, so a loading
 * placeholder can sit exactly where the scene will draw: the same framing,
 * projected through the same perspective camera.
 */
export function overviewSketch(
	system: Pick<PlanetSystem, "planets" | "systemRadius">,
	viewport: { height: number; width: number },
	layout: HudLayout = EMPTY_HUD,
	/** How much farther out than the overview the camera stands (the intro). */
	distanceScale = 1
): OverviewSketch {
	const width = Math.max(1, viewport.width);
	const height = Math.max(1, viewport.height);
	const empty = system.planets.length === 0;
	const reach = empty
		? (SKETCH_ORBITS.at(-1) ?? 32) + 2
		: overviewReach(system);
	const elevation = overviewElevation(width, height);
	const frame = overviewFrame(reach, { height, width }, FOV, elevation, layout);
	const half = Math.tan((FOV * Math.PI) / 360);
	const cosE = Math.cos(elevation);
	const sinE = Math.sin(elevation);
	const distance = frame.distance * distanceScale;
	const camY = sinE * distance;
	const camZ = cosE * distance;
	// The camera looks at the star from (0, camY, camZ); orbits are circles
	// about the star, so the overview's azimuth does not change their shape.
	const project = (x: number, z: number) => {
		const dz = z - camZ;
		const depth = Math.max(0.1, camY * sinE - dz * cosE);
		const up = -camY * cosE - dz * sinE;
		return {
			x: width / 2 + frame.shiftX + (x / (depth * half)) * (height / 2),
			y: height / 2 + frame.shiftY - (up / (depth * half)) * (height / 2),
		};
	};
	const radii = empty
		? [...SKETCH_ORBITS]
		: system.planets.map((planet) => planet.orbitRadius);
	const orbits = radii.map((radius) => {
		const points: string[] = [];
		for (let index = 0; index < SKETCH_SAMPLES; index += 1) {
			const angle = (index / SKETCH_SAMPLES) * Math.PI * 2;
			const point = project(Math.cos(angle) * radius, Math.sin(angle) * radius);
			points.push(`${point.x.toFixed(1)} ${point.y.toFixed(1)}`);
		}
		return `M${points.join("L")}Z`;
	});
	const centre = project(0, 0);
	const unit = height / 2 / (distance * half);
	return {
		centre,
		orbits,
		sunRadius: SUN_RADIUS * unit,
	};
}

/** How far a column planet sits to the side of the star's line (world units). */
export const COLUMN_SIDE = 2.8;
/** Column bodies swell less than the overview's, so stacked worlds never touch. */
export const COLUMN_BODY_SCALE = 1.75;

/**
 * The system laid out for a portrait screen: each planet stops orbiting and
 * holds still on its own orbit straight down the screen from the star,
 * alternating a little left and right, so the worlds stack in a column with
 * the star at the top. `toward` is the camera's azimuth (its side of the
 * star), so "down the screen" is toward it.
 */
export function columnSystem(
	system: PlanetSystem,
	toward: number
): PlanetSystem {
	const down = Math.PI / 2 - toward;
	return {
		...system,
		column: true,
		planets: system.planets.map((planet, index) => {
			const side = index % 2 === 0 ? -1 : 1;
			const swing = Math.asin(
				Math.min(0.9, COLUMN_SIDE / Math.max(planet.orbitRadius, 0.1))
			);
			return { ...planet, orbitSpeed: 0, phase: down + side * swing };
		}),
	};
}

/**
 * The system with every planet holding its place on its orbit (the act
 * layer: the station's plates and each world's signs stay readable).
 */
export function holdOrbits(system: PlanetSystem): PlanetSystem {
	return {
		...system,
		planets: system.planets.map((planet) => ({ ...planet, orbitSpeed: 0 })),
	};
}

/** A camera framing: where it looks, how far back, and the view offset (px). */
export interface ColumnFrame {
	distance: number;
	shift: [number, number];
	/** The look-at point on the orbital plane, toward the camera from the star. */
	toward: number;
}

/**
 * Frames a column system top-down: the star near the top of the free room
 * between `top` and `bottom` (px) and the outermost world near its bottom,
 * as wide as the screen allows. `toward` (world units) is how far the look-at
 * point sits from the star toward the camera.
 */
export function columnFrame(
	system: Pick<PlanetSystem, "planets">,
	viewport: { height: number; width: number },
	fov: number,
	elevation: number,
	room: { bottom: number; top: number },
	bodyScale = COLUMN_BODY_SCALE
): ColumnFrame {
	let far = SUN_RADIUS * 3;
	let wide = SUN_RADIUS * 2;
	for (const planet of system.planets) {
		const body = planet.radius * bodyScale;
		far = Math.max(far, planet.orbitRadius + body);
		wide = Math.max(wide, COLUMN_SIDE + body + planet.extent * 0.6);
	}
	const near = SUN_RADIUS * 2.2;
	// Depth on the plane reads foreshortened; bodies stand up out of it.
	const tall = (far + near) * Math.sin(elevation) + 4.5;
	const across = wide * 2 + 3;
	const freeHeight = Math.max(80, viewport.height - room.top - room.bottom);
	const half = Math.tan((fov * Math.PI) / 360);
	const aspect = viewport.width / Math.max(1, viewport.height);
	// Distance so `tall` fills the free height and `across` the width.
	const byHeight = (tall / 2 / half) * (viewport.height / freeHeight);
	const byWidth = across / 2 / (half * aspect);
	return {
		distance: Math.max(byHeight, byWidth),
		shift: [0, (room.top - room.bottom) / 2],
		toward: (far - near) / 2,
	};
}

/**
 * The free room (px from the top and the bottom) a column frame keeps clear
 * of the HUD: below whatever sits in the upper half, above whatever sits in
 * the lower half (a bottom sheet, the legend).
 */
export function columnRoom(
	layout: HudLayout,
	height: number
): { bottom: number; top: number } {
	let top = HUD_GAP;
	let bottom = HUD_GAP;
	for (const box of [layout.card, layout.controls, layout.legend]) {
		if (!box) {
			continue;
		}
		if ((box.top + box.bottom) / 2 < height / 2) {
			top = Math.max(top, box.bottom + HUD_GAP);
		} else {
			bottom = Math.max(bottom, height - box.top + HUD_GAP);
		}
	}
	return { bottom, top };
}
