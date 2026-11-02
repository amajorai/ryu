import {
	type Moon,
	OVERVIEW_BODY_SCALE,
	type Planet,
	type PlanetSystem,
	SUN_CLEARANCE,
} from "./planets-model.ts";

/**
 * The radius the overview has to hold: the outermost planet's orbit plus its
 * body, drawn at `bodyScale`. Moons and rings may brush the frame's margin
 * (the name plates' padding leaves room for them) rather than shrinking the
 * whole system for a moment when one swings outwards.
 */
export function overviewReach(
	system: Pick<PlanetSystem, "planets" | "systemRadius">,
	bodyScale = OVERVIEW_BODY_SCALE
): number {
	let reach = SUN_CLEARANCE + 2;
	for (const planet of system.planets) {
		reach = Math.max(reach, planet.orbitRadius + planet.radius * bodyScale);
	}
	return system.planets.length > 0 ? reach : system.systemRadius;
}

/** Angle around the star at `elapsed` seconds of orbit time. */
export function orbitAngle(
	planet: Pick<Planet, "orbitSpeed" | "phase">,
	elapsed: number
): number {
	return planet.phase + planet.orbitSpeed * elapsed;
}

/** Position on the orbital plane (y up) for an orbit radius and angle. */
export function orbitPoint(
	radius: number,
	angle: number
): [number, number, number] {
	return [Math.cos(angle) * radius, 0, Math.sin(angle) * radius];
}

/** Moon angular speed on its shell (inner moons are quicker). */
export function moonSpeed(moon: Pick<Moon, "shell">): number {
	return moon.shell === 0 ? 0.24 : 0.17;
}

/** Shell inclinations, so moons trace tilted rings rather than one plane. */
export const MOON_TILTS = [0.32, -0.22] as const;

/** A moon's offset from its body at `elapsed` seconds. */
export function moonOffset(
	moon: Pick<Moon, "orbit" | "phase" | "shell">,
	elapsed: number
): [number, number, number] {
	const angle = moon.phase + moonSpeed(moon) * elapsed;
	const tilt = MOON_TILTS[moon.shell === 0 ? 0 : 1];
	const x = Math.cos(angle) * moon.orbit;
	const flat = Math.sin(angle) * moon.orbit;
	return [x, flat * Math.sin(tilt), flat * Math.cos(tilt)];
}
