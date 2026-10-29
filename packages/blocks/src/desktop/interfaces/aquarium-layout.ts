import { type Creature, unit } from "./aquarium-model.ts";
import type { Vec3 } from "./game3d-palette.ts";

/**
 * Where everything sits in the Aquarium's tank (pure, testable): the tank's
 * heights, each creature's own spot and the small loop it swims around it,
 * and the kit badge its name plate wears.
 */

/** The top of the cabinet the tank stands on (the tank's base). */
export const PLINTH = 0.35;
/**
 * The room's floor, below the tank's base: the cabinet stands on it. Just
 * above the kit's night star layer (y -0.9), so the floor hides it.
 */
export const ROOM_FLOOR = -0.8;
/** How far the room's back walls stand behind the tank. */
export const WALL_GAP = 2.6;
export const SAND = 0.5;
export const TANK_FLOOR = PLINTH + SAND;
export const TANK_SURFACE = TANK_FLOOR + 2.7;
export const RIM = 0.25;
export const TANK_TOP = TANK_SURFACE + RIM;
/** Width of the cell each creature swims around, and the rows' depth. */
const CELL = 2.1;
const ROW_Z = 1.2;
const HALF_DEPTH = 2.5;
/** Plate height above a creature's centre. */
export const PLATE_LIFT = 0.82;
/** Creatures are drawn this much larger than their model units. */
export const CREATURE_SCALE = 1.45;
/** Turns a model that faces +x toward the iso camera. */
export const TO_CAMERA = -Math.PI / 4;

/** Where a creature swims: a small loop around its home spot. */
export interface Swim {
	direction: 1 | -1;
	home: Vec3;
	phase: number;
	radiusX: number;
	radiusZ: number;
	/** Radians per second around the loop. */
	speed: number;
}

export interface TankLayout {
	halfDepth: number;
	halfWidth: number;
	swims: ReadonlyMap<string, Swim>;
}

/**
 * Each creature gets its own spot: two staggered rows across the tank (so
 * plates never stack), working creatures high in the water, idle ones low
 * over the reef, drifting jellyfish in between.
 */
export function layoutTank(
	creatures: readonly Creature[],
	/** Extra width on the right (the act layer's queue lane at the glass). */
	lane = 0,
	/** How much farther apart homes stand (the act layer's props between them). */
	spread = 1
): TankLayout {
	const cell = CELL * spread;
	const heightOf = (creature: Creature) => {
		const base =
			creature.kind === "jellyfish" ? 1.35 : creature.working ? 1.6 : 0.9;
		return base + (unit(creature.seed, 7) - 0.5) * 0.3;
	};
	// Seen from the iso angle, a high creature in the front row lines up
	// with a low one behind it; so the higher swimmers take the back row.
	const byHeight = [...creatures].sort(
		(a, b) => heightOf(b) - heightOf(a) || a.id.localeCompare(b.id)
	);
	const backCount = Math.ceil(byHeight.length / 2);
	const rows = [byHeight.slice(0, backCount), byHeight.slice(backCount)];
	const columns = Math.max(2, backCount);
	const halfWidth =
		Math.max(3.2, (columns * cell + cell * 0.5) / 2 + 0.45) + lane / 2;
	const swims = new Map<string, Swim>();
	for (const [row, members] of rows.entries()) {
		const shift = row === 0 ? -cell / 4 : cell / 4;
		for (const [column, creature] of members.entries()) {
			// With a lane the homes keep left of it.
			const x = (column - (members.length - 1) / 2) * cell + shift - lane / 2;
			const z = row === 0 ? -ROW_Z : ROW_Z;
			swims.set(creature.id, {
				direction: unit(creature.seed, 9) < 0.5 ? 1 : -1,
				home: [x, TANK_FLOOR + heightOf(creature), z],
				phase: unit(creature.seed, 5) * Math.PI * 2,
				radiusX: creature.working ? 0.4 : 0.3,
				radiusZ: creature.working ? 0.32 : 0.24,
				speed: creature.working ? 0.55 : 0.22,
			});
		}
	}
	return { halfDepth: HALF_DEPTH, halfWidth, swims };
}

/** Where a creature is at `time`, written into `out` (no allocation). */
export function swimAt(
	swim: Swim,
	time: number,
	out: { heading: number; x: number; y: number; z: number }
): void {
	const angle = swim.phase + time * swim.speed * swim.direction;
	out.x = swim.home[0] + Math.cos(angle) * swim.radiusX;
	out.z = swim.home[2] + Math.sin(angle) * swim.radiusZ;
	out.y = swim.home[1] + Math.sin(time * 0.9 + swim.phase) * 0.1;
	const dx = -Math.sin(angle) * swim.radiusX * swim.direction;
	const dz = Math.cos(angle) * swim.radiusZ * swim.direction;
	out.heading = Math.atan2(-dz, dx);
}

/** The status badge on a plate, matching the kit's villager badges. */
export function plateBadge(
	creature: Creature
): { className: string; mark: string } | null {
	if (creature.pearl) {
		return { className: "bg-(--gk-bad) text-white", mark: "×" };
	}
	if (creature.counts["your-turn"] > 0) {
		return {
			className: "bg-(--gk-gold) text-(--gk-edge) motion-safe:animate-pulse",
			mark: "!",
		};
	}
	if (creature.working) {
		return { className: "bg-(--gk-info) text-white", mark: "•••" };
	}
	return null;
}
