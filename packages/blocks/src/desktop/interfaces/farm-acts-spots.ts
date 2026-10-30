import type { InterfaceAgentAct } from "@ryuhq/protocol/interfaces";
import type { FarmDiorama, PlacedBed } from "./farm-model.ts";
import type { LifePaths } from "./game3d-life.ts";
import type { Vec3 } from "./game3d-palette.ts";

/**
 * The queue runs on the lawn past the front bed row toward the porch at
 * the front-right, stepping toward you: on screen each plate sits right of
 * and a plate height plus a gap below the one before (a plate's bubble
 * hangs up and right of it, clear of the next). A notice stands at its own
 * slot shifted right on screen, never back toward the farmer before it.
 */
const QUEUE_FRONT = 0.9;
const SLOT_GAP = 2.0;
/**
 * A notice's plate stands at a post's height, lower than a farmer's: the
 * notice stands right of its slot on screen (+x), away from the farmer
 * queued before it, so its plate never covers that farmer's face.
 */
export const NOTICE_SHIFT: Vec3 = [0.8, 0, 0];
const SLOT_STEP = 1.1;
/** Benches by the pond, one per limited farmer (more share the last). */
const BENCHES = 3;
const BENCH_GAP = 1.0;
/** Where a queued farmer's fence post stands, from its slot, and how tall. */
export const POST_OUT: Vec3 = [0.55, 0, 0.25];
export const POST_HEIGHT = 0.42;
/** The porch deck's top, where the tray's crates stand. */
export const DECK_TOP = 0.24;

/** The gate's places: queue slots, the porch (you-spot, tray, mailbox) and the benches. */
export function porchSpots(diorama: FarmDiorama): {
	benches: Vec3[];
	mailbox: Vec3;
	porch: Vec3;
	slots: Vec3[];
	sundial: Vec3;
	tray: Vec3;
	you: Vec3;
} {
	const { bounds, pond } = diorama;
	// From the front edge's middle (well inside a phone's frame) toward
	// the porch at its right.
	const z = bounds.maxZ + QUEUE_FRONT;
	const left = (bounds.minX + bounds.maxX) / 2 + 0.4;
	const slots: Vec3[] = [0, 1, 2, 3].map((index) => [
		left + index * SLOT_GAP,
		0,
		z + index * SLOT_STEP,
	]);
	const last = slots[3] ?? [left, 0, z];
	const porch: Vec3 = [last[0] + 1.6, 0, last[2] - 1.2];
	const benchX = pond.x - pond.radius - 0.7;
	const benches = Array.from(
		{ length: BENCHES },
		(_, index): Vec3 => [benchX, 0, pond.z - BENCH_GAP + index * BENCH_GAP]
	);
	return {
		benches,
		mailbox: [porch[0] - 0.95, 0, porch[2] + 0.45],
		porch,
		slots,
		sundial: [benchX - 0.15, 0, pond.z + BENCH_GAP * 1.9],
		tray: [porch[0] + 0.25, DECK_TOP, porch[2] + 0.3],
		you: [porch[0], 0, porch[2] + 0.75],
	};
}

/** Each agent's bed, by agent id. */
export function bedsByAgent(diorama: FarmDiorama): Map<string, PlacedBed> {
	const beds = new Map<string, PlacedBed>();
	for (const placed of diorama.beds) {
		if (placed.plot.agent) {
			beds.set(placed.plot.agent.id, placed);
		}
	}
	return beds;
}

/** Which bench (a waypoint id) each limited farmer sits on. */
export function benchOf(
	diorama: FarmDiorama,
	acts: ReadonlyMap<string, InterfaceAgentAct>
): Map<string, string> {
	const benches = new Map<string, string>();
	for (const placed of diorama.beds) {
		const act = placed.plot.agent ? acts.get(placed.plot.agent.id) : undefined;
		if (act?.act === "limited") {
			benches.set(act.agentId, `bench-${Math.min(benches.size, BENCHES - 1)}`);
		}
	}
	return benches;
}

/**
 * The farmers' waypoints: each farmer's spot, straight down (or up) its
 * strip to the earthen path nearest its row (or the front edge), along it
 * to a spine under the barn door, and down the spine to the gate (the
 * porch, the queue slots, the tray); the benches hang off the spine by the pond.
 */
export function farmPaths(diorama: FarmDiorama): LifePaths {
	const points: Record<string, Vec3> = {};
	const links: [string, string][] = [];
	const { barn, bounds } = diorama;
	const spineX = (barn.minX + barn.maxX) / 2;
	const porch = porchSpots(diorama);
	const lanes = [
		...diorama.paths.map((path) => (path.minZ + path.maxZ) / 2),
		bounds.maxZ + 0.2,
	].sort((a, b) => a - b);
	points.you = porch.you;
	points["you-tray"] = [porch.tray[0], 0, porch.tray[2] + 0.55];
	for (const [index, slot] of porch.slots.entries()) {
		points[`you-${index + 1}`] = slot;
	}
	links.push(
		["you", "you-tray"],
		["you", "you-4"],
		["you-4", "you-3"],
		["you-3", "you-2"],
		["you-2", "you-1"]
	);
	// The spine runs from the barn door down to the front edge, then the gate.
	points["spine-top"] = [spineX, 0, diorama.barn.maxZ + 0.4];
	let previous = "spine-top";
	for (const [index, z] of lanes.entries()) {
		const spine = `spine-${index}`;
		points[spine] = [spineX, 0, z];
		links.push([previous, spine]);
		previous = spine;
	}
	links.push([previous, "you"]);
	for (const [index, bench] of porch.benches.entries()) {
		points[`bench-${index}`] = [bench[0], 0, bench[2] + 0.45];
		links.push(["spine-top", `bench-${index}`]);
	}
	for (const placed of diorama.beds) {
		const agent = placed.plot.agent;
		if (!agent) {
			continue;
		}
		const [x, z] = placed.farmer;
		const below = lanes.findIndex((lane) => lane > z);
		const index = below === -1 ? lanes.length - 1 : below;
		const station = `farmer-${agent.id}`;
		const lane = `lane-${agent.id}`;
		points[station] = [x, 0, z];
		points[lane] = [x, 0, lanes[index] ?? z];
		links.push([station, lane], [lane, `spine-${index}`]);
	}
	return { links, points };
}
