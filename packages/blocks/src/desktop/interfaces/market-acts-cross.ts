import type { YouSpotLayout } from "./game3d-act-stage.tsx";
import type { LifePaths } from "./game3d-life.ts";
import { type KeeperStation, stationOffset } from "./market-acts-stations.ts";
import type { MarketSquare, Vec3 } from "./market-model.ts";

/** The fountain (the market cross) in the square's middle. */
export function marketCross(block: MarketSquare): Vec3 {
	const { square } = block;
	return [
		(square.minX + square.maxX) / 2 + 0.7,
		0,
		(square.minZ + square.maxZ) / 2 + 0.7,
	];
}

/** The ring of waypoints round the fountain (its basin is 1.05 across). */
export const RING = 1.9;
/** How many waypoints the ring has: a chord stays 1.76 from the middle. */
const RING_POINTS = 8;
/** The queue runs across the screen: along +x and -z (the camera's right). */
const ACROSS: Vec3 = [Math.SQRT1_2, 0, -Math.SQRT1_2];
/** Toward the camera, into the square's open front corner. */
const TOWARD: Vec3 = [Math.SQRT1_2, 0, Math.SQRT1_2];

function from(origin: Vec3, across: number, toward: number): Vec3 {
	return [
		origin[0] + ACROSS[0] * across + TOWARD[0] * toward,
		0,
		origin[2] + ACROSS[2] * across + TOWARD[2] * toward,
	];
}

/**
 * The queue at the cross, front first, as (across, toward) from the
 * fountain: "you-1" stands before your stall in front of the fountain and
 * each later place a step up the screen and to the left, round the
 * fountain's left side, every one outside the ring. A queued keeper's
 * bubble hangs up and to the right of its plate, and the place behind
 * stands up and to the left, so it never covers the next plate.
 */
const QUEUE_PLACES: readonly [number, number][] = [
	// The front stands well toward the camera: its bubble clears the back
	// row's station boards by more than the 8 px plate gap.
	[2.6, 8.4],
	[-0.8, 3.9],
	[-3.8, 1.2],
	[-6.8, -1.5],
];
/**
 * On a phone (yaw 65, steeper) "toward" climbs less of the screen and
 * "across" more of it sideways, so each place steps further back: about a
 * plate height and a gap up the screen, its text plate (queue plates keep
 * their words) clear of the one before.
 */
const QUEUE_PLACES_NARROW: readonly [number, number][] = [
	[2.2, 7.6],
	[-0.8, 3.7],
	[-3.8, -0.2],
	[-6.8, -4.1],
];

/**
 * The you-spot by the market cross: "you" (an ask with no queue place left),
 * the queue "you-1".."you-4" (`QUEUE_PLACES`), and "you-tray" before your
 * stall down and to the right of the queue's front; a ring of waypoints
 * round the fountain joins them to a lane out of every shop, so nobody
 * walks through the water.
 */
export function youPoints(
	block: MarketSquare,
	narrow = false
): Record<string, Vec3> {
	const cross = marketCross(block);
	const points: Record<string, Vec3> = {};
	for (let index = 0; index < RING_POINTS; index++) {
		const angle = (index / RING_POINTS) * Math.PI * 2;
		points[`cross-${index}`] = [
			cross[0] + Math.cos(angle) * RING,
			0,
			cross[2] + Math.sin(angle) * RING,
		];
	}
	const places = narrow ? QUEUE_PLACES_NARROW : QUEUE_PLACES;
	for (const [index, [across, toward]] of places.entries()) {
		points[`you-${index + 1}`] = from(cross, across, toward);
	}
	// Level with the queue's front and well to its right: under the bubble
	// that hangs up and to the right of "you-1", and more than the 8 px
	// you-spot gap from its plate, so the stage never parts the tray's plate
	// down over your stall.
	points["you-tray"] = from(cross, 7, 8.4);
	// Where an ask waits with no queue place left: down and to the right of
	// the queue's front, so no queued keeper's bubble hangs over it, and its
	// own bubble passes over the tray.
	points.you = from(cross, 4.6, 10.3);
	return points;
}

/** The ring's waypoint ids, in order round the fountain. */
function ringIds(): string[] {
	return Array.from({ length: RING_POINTS }, (_, index) => `cross-${index}`);
}

/** Your stall at the cross: a little counter behind the tray. */
export function yourStallAt(block: MarketSquare): Vec3 {
	return from(marketCross(block), 7, 8.85);
}

/** How high a queue notice's crate stack stands (world units). */
export const NOTICE_LIFT = 0.8;

function lifted([x, y, z]: Vec3): Vec3 {
	return [x, y + NOTICE_LIFT, z];
}

/** Where the kit's you-spot pieces sit at the cross. */
export function crossLayout(
	block: MarketSquare,
	narrow = false
): YouSpotLayout {
	const points = youPoints(block, narrow);
	const at = (id: string) => points[id] ?? [0, 0, 0];
	const cross = marketCross(block);
	const tray = at("you-tray");
	return {
		// Off-stage keepers wait far left, clear of the queue.
		offStage: from(cross, -4.6, 5.2),
		// A notice is pinned up on a crate stack, so its plate rides at a
		// queued keeper's head height.
		slots: {
			"you-1": lifted(at("you-1")),
			"you-2": lifted(at("you-2")),
			"you-3": lifted(at("you-3")),
			"you-4": lifted(at("you-4")),
		},
		// "+N more" stands on past the end of the queue, to its left.
		tally: [...from(cross, -9.8, -1.5)].map((value, index) =>
			index === 1 ? 0.6 : value
		) as Vec3,
		// The parcels are stacked on the ground just right of your stall, a
		// row along it: their plate hangs above them, beside the stall, so
		// the stall and its counter stay in view.
		tray: [
			tray[0] + TOWARD[0] * 0.45 + ACROSS[0] * 1.3,
			0,
			tray[2] + TOWARD[2] * 0.45 + ACROSS[2] * 1.3,
		],
		trayStep: [ACROSS[0] * 0.55, 0, ACROSS[2] * 0.55],
	};
}

/**
 * The walks: the ring round the fountain (each waypoint to the next), the
 * queue places, the tray and every shop's lane each joined to their nearest
 * ring waypoint, and the queue places to each other in line.
 */
export function marketActPaths(
	block: MarketSquare,
	stations: readonly KeeperStation[],
	narrow = false
): LifePaths {
	const points: Record<string, Vec3> = { ...youPoints(block, narrow) };
	const ring = ringIds();
	const links: [string, string][] = ring.map((id, index) => [
		id,
		ring[(index + 1) % ring.length] ?? id,
	]);
	const nearest = (point: Vec3): string => {
		let best = ring[0] ?? "cross-0";
		let distance = Number.POSITIVE_INFINITY;
		for (const id of ring) {
			const there = points[id];
			if (!there) {
				continue;
			}
			const apart = Math.hypot(there[0] - point[0], there[2] - point[2]);
			if (apart < distance) {
				distance = apart;
				best = id;
			}
		}
		return best;
	};
	const places = QUEUE_PLACES.map((_, index) => `you-${index + 1}`);
	for (const id of [...places, "you-tray", "you"]) {
		const point = points[id];
		if (point) {
			links.push([id, nearest(point)]);
		}
	}
	for (const [index, id] of places.entries()) {
		const behind = places[index + 1];
		if (behind) {
			links.push([id, behind]);
		}
	}
	for (const station of stations) {
		points[station.id] = station.at;
		const lane = `${station.id}:lane`;
		const out = stationOffset(station, 0, 1.25);
		points[lane] = out;
		links.push([station.id, lane], [lane, nearest(out)]);
	}
	return { links, points };
}
