import type { InterfaceAgentAct } from "@ryuhq/protocol/interfaces";
import type { YouSpotLayout } from "./game3d-act-stage.tsx";
import {
	type ActSpots,
	actorTarget,
	slotOf,
	YOU_SLOTS,
	type YouSlot,
	type YouSpotSlot,
} from "./game3d-acts.ts";
import type { LifePaths } from "./game3d-life.ts";
import type { Vec3 } from "./game3d-palette.ts";
import { inRiver, type RidesCityPlan } from "./rides-scene.ts";

/** A ground offset `across` the view (screen right) and `out` toward the camera. */
export function offset(at: Vec3, across: number, out: number, lift = 0): Vec3 {
	const c = Math.SQRT1_2;
	return [at[0] + (across + out) * c, at[1] + lift, at[2] + (out - across) * c];
}

export const ORIGIN: Vec3 = [0, 0, 0];

/** Whether a ground point is open road: inside the city, off the blocks and the river. */
export function onRoad(plan: RidesCityPlan, x: number, z: number): boolean {
	const { rect } = plan;
	if (x < rect.minX || x > rect.maxX || z < rect.minZ || z > rect.maxZ) {
		return false;
	}
	if (inRiver(plan.frame, x, z)) {
		return false;
	}
	const margin = 0.15;
	return !plan.blocks.some(
		({ rect: block }) =>
			x > block.minX - margin &&
			x < block.maxX + margin &&
			z > block.minZ - margin &&
			z < block.maxZ + margin
	);
}

/** How far a kerb place keeps from any car's own spot. */
const CAR_CLEAR = 1.6;

/**
 * Places along the pickup's own street, a `step` apart, on road and clear
 * of the cars' own spots: the street runs across the screen on a diagonal
 * (the city's grid is turned 45 degrees), so no two queue plates share a
 * screen row. Of the four ways along the streets from the pickup, the
 * one with room for four, furthest from the cars, wins.
 */
function kerbLine(
	pickup: Vec3,
	plan: RidesCityPlan,
	avoid: readonly Vec3[],
	step: number
): Vec3[] {
	const clear = (x: number, z: number) =>
		onRoad(plan, x, z) &&
		avoid.every((car) => Math.hypot(car[0] - x, car[2] - z) >= CAR_CLEAR);
	const room = (line: readonly Vec3[]) =>
		Math.min(
			...line.flatMap((point) =>
				avoid.map((car) => Math.hypot(car[0] - point[0], car[2] - point[2]))
			),
			Number.POSITIVE_INFINITY
		);
	let best: Vec3[] = [];
	for (const [dx, dz] of [
		[1, 0],
		[0, 1],
		[-1, 0],
		[0, -1],
	] as const) {
		const line: Vec3[] = [];
		for (let k = 1; k <= 14 && line.length < 4; k++) {
			const x = pickup[0] + dx * step * k;
			const z = pickup[2] + dz * step * k;
			if (!onRoad(plan, x, z)) {
				break;
			}
			if (clear(x, z)) {
				line.push([x, pickup[1], z]);
			}
		}
		// The fullest line, then the one furthest from the cars (their
		// plates, alarms and bubbles stand round them).
		if (
			line.length > best.length ||
			(line.length === best.length && room(line) > room(best))
		) {
			best = line;
		}
	}
	return best;
}

/** How far the parcel tray stands from you, away from the queue. */
const TRAY_REACH = 2.6;

/** Nudges round a fallback place, nearest first. */
const NUDGES: readonly (readonly [number, number])[] = [
	[0, 0],
	[0.8, 0],
	[-0.8, 0],
	[0, 0.8],
	[0, -0.8],
	[1.6, 0],
	[-1.6, 0],
	[0, 1.6],
	[0, -1.6],
];

/** The nearest nudge of `at` on open road, clear of the cars; else `at`. */
function nearestClear(
	at: Vec3,
	plan: RidesCityPlan,
	avoid: readonly Vec3[]
): Vec3 {
	for (const [dx, dz] of NUDGES) {
		const x = at[0] + dx;
		const z = at[2] + dz;
		if (
			onRoad(plan, x, z) &&
			avoid.every((car) => Math.hypot(car[0] - x, car[2] - z) >= CAR_CLEAR)
		) {
			return [x, at[1], z];
		}
	}
	return at;
}

/**
 * The pickup kerb round you: four queue slots along the pickup's street
 * (on road, clear of the river, the blocks and the cars; a phone's a
 * longer step apart), so each slot is a step along the screen diagonal
 * from the last and no plate shares a screen row; the parcel tray on your
 * other side; the "+N more" tally past the last slot. Without a city plan
 * (tests) the slots stand in a fixed staggered row.
 */
export function ridesYouSpot(
	pickup: Vec3,
	narrow: boolean,
	plan?: RidesCityPlan,
	avoid: readonly Vec3[] = []
): { layout: YouSpotLayout; points: Record<string, Vec3> } {
	const line = plan ? kerbLine(pickup, plan, avoid, narrow ? 3.4 : 2.6) : [];
	const fallback = (index: number): Vec3 => {
		const base = narrow
			? offset(pickup, -3.4 + index * 2.3, 2 + index * 2.4)
			: offset(pickup, (index - 1.5) * 2.6, 1.6 + (index % 2) * 0.8);
		// A short line runs out of street: the rest stand near their
		// staggered place, but on road and clear of the cars when they can.
		return plan ? nearestClear(base, plan, avoid) : base;
	};
	const slot = (index: number): Vec3 => line[index] ?? fallback(index);
	const slots = Object.fromEntries(
		YOU_SLOTS.map((point, index) => [point, slot(index)])
	) as Record<YouSlot, Vec3>;
	// The parcel tray: on your other side, away from the queue.
	const first = slot(0);
	const reach =
		Math.hypot(first[0] - pickup[0], first[2] - pickup[2]) || Number.EPSILON;
	// Far enough that a delivering car's plate and bubble clear yours.
	const away: Vec3 = [
		pickup[0] - ((first[0] - pickup[0]) / reach) * TRAY_REACH,
		pickup[1],
		pickup[2] - ((first[2] - pickup[2]) / reach) * TRAY_REACH,
	];
	const tray =
		plan && onRoad(plan, away[0], away[2]) ? away : offset(pickup, -2.6, -1.6);
	return {
		layout: {
			offStage: offset(pickup, -2.6, -1.2, 0.6),
			slots,
			tally: offset(slot(3), 1.4, 0, 0.6),
			// The taxi meter stands at the car's right front.
			timer: offset(ORIGIN, 0.75, 0.2),
			tray,
			trayStep: offset(ORIGIN, 0.7, 0),
		},
		points: { ...slots, you: pickup, "you-tray": tray },
	};
}

/** Where each car goes for its act: its own spot, or the kerb. */
export function ridesCarTarget(
	act: InterfaceAgentAct,
	home: Vec3,
	you: Record<string, Vec3>,
	slots: readonly YouSpotSlot[],
	still: boolean
): Vec3 {
	const points: Record<string, Vec3> = { ...you, [`car:${act.agentId}`]: home };
	const paths: LifePaths = { links: [], points };
	const spots: ActSpots = {
		paths,
		slot: slotOf(slots, act.agentId),
		station: `car:${act.agentId}`,
	};
	const target = actorTarget(act, spots, still).position;
	return [target[0], home[1], target[2]];
}
