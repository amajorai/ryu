import { arcadeYouSpot } from "./arcade-acts.tsx";
import type { Machine } from "./arcade-model.ts";
import type { YouSpotLayout } from "./game3d-act-stage.tsx";
import type { Vec3 } from "./game3d-palette.ts";
import type { VillagerPose } from "./game3d-villager.tsx";

export const SLAB = 0.16;
export const WALL_HEIGHT = 2.75;
export const WALL_THICK = 0.2;
/** Cabinets stand this far apart along a row, and rows this far apart. */
const PITCH = 1.95;
const ROW_GAP = 3.2;
/**
 * With the act layer every player carries plates (its name, its station
 * board, alarms, marks), so cabinets stand further apart and rows leave a
 * wider aisle.
 */
const ACT_PITCH = 2.6;
const ACT_ROW_GAP = 4.6;
/** Where a player stands: beside their cabinet's right, a step forward. */
const PLAYER_SIDE = 0.95;
const PLAYER_OUT = 0.42;
/** Cabinets per row: wide stages, and portrait ones (rows stack taller). */
const WIDE_COLUMNS = 6;
const PORTRAIT_COLUMNS = 2;
/**
 * With the act layer a phone's hall gets a third column: two columns of
 * ten players stack into one tall line whose plates sit on each other.
 */
const PORTRAIT_ACT_COLUMNS = 3;
/** Every cabinet turns to face the camera (the kit's 45 degree yaw). */
const FACE_VIEW = Math.PI / 4;
/** Carpet kept around the rows, the counter and the claw. */
const HALL_MARGIN = 1.1;
/** Lawn around the hall for the garden. */
export const ARCADE_RIM = 2.6;

/** A cabinet on the floor: its centre and which way its screen faces. */
export interface PlacedCabinet {
	machine: Machine;
	x: number;
	/** The screen's facing: a quarter turn from +z toward +x is 45 degrees. */
	yaw: number;
	z: number;
}

export interface HallLayout {
	cabinets: PlacedCabinet[];
	/** The prize counter (centre, along x) and the claw machine. */
	claw: [number, number];
	counter: [number, number];
	halfDepth: number;
	halfWidth: number;
	/** The act layer's you-spot points (queue, tray), when laid out for acts. */
	you: {
		layout: YouSpotLayout;
		points: Record<string, Vec3>;
		portrait: boolean;
	} | null;
}

/** How many cabinets share a row. */
export function hallColumns(
	count: number,
	portrait: boolean,
	acts = false
): number {
	let cap = WIDE_COLUMNS;
	if (portrait) {
		cap = acts ? PORTRAIT_ACT_COLUMNS : PORTRAIT_COLUMNS;
	}
	if (count <= cap) {
		return Math.max(1, count);
	}
	return Math.ceil(count / Math.ceil(count / cap));
}

/** A point `across` the view (screen right) and `out` toward the camera. */
function onFloor(across: number, out: number): [number, number] {
	const c = Math.SQRT1_2;
	return [across * c + out * c, -across * c + out * c];
}

/**
 * Cabinets in rows across the hall, every screen turned to face the camera
 * (no cabinet is ever seen edge-on), rows one behind the other with an
 * aisle wide enough that a front marquee never hides a back screen. A
 * player stands beside their cabinet, not in front of its screen. The
 * prize counter and the claw machine stand in front of the rows. Portrait
 * stages get fewer cabinets per row and more rows.
 */
export function layoutHall(
	machines: readonly Machine[],
	portrait = false,
	withYouSpot = false
): HallLayout {
	const count = machines.length;
	const columns = hallColumns(count, portrait, withYouSpot);
	const pitch = withYouSpot ? ACT_PITCH : PITCH;
	const rowGap = withYouSpot ? ACT_ROW_GAP : ROW_GAP;
	const rows = Math.max(1, Math.ceil(count / columns));
	const cabinets: PlacedCabinet[] = machines.map((machine, index) => {
		const row = Math.floor(index / columns);
		const inRow = Math.min(columns, count - row * columns);
		const column = index % columns;
		const across = (column - (inRow - 1) / 2) * pitch - PLAYER_SIDE / 2;
		const out = (row - (rows - 1) / 2) * rowGap;
		const [x, z] = onFloor(across, out);
		return { machine, x, yaw: FACE_VIEW, z };
	});
	const reach = ((Math.max(columns, 2) - 1) / 2) * pitch + PLAYER_SIDE;
	// Far enough forward that the counter never stands in front of a screen.
	const front = ((rows - 1) / 2) * rowGap + (portrait ? 2.6 : 4.4);
	// The counter and claw stand in front of the rows (the near side of
	// the hall), so the cabinets and the prizes fill the frame together.
	// With the act layer the queue runs right from the counter, so the
	// claw stands further right, past it.
	const counter = onFloor(portrait ? -0.9 : -reach * 0.45, front);
	let clawAcross = reach * 0.55;
	if (portrait) {
		clawAcross = Math.max(reach - 0.4, 1.6);
	} else if (withYouSpot) {
		clawAcross = -reach * 0.45 + 8.2;
	}
	const claw = onFloor(clawAcross, front - (withYouSpot ? 0.6 : 0.2));
	let halfWidth = 0;
	let halfDepth = 0;
	const box = {
		maxX: Number.NEGATIVE_INFINITY,
		maxZ: Number.NEGATIVE_INFINITY,
		minX: Number.POSITIVE_INFINITY,
		minZ: Number.POSITIVE_INFINITY,
	};
	const extend = (x: number, z: number, room: number) => {
		halfWidth = Math.max(halfWidth, Math.abs(x) + room);
		halfDepth = Math.max(halfDepth, Math.abs(z) + room);
		box.minX = Math.min(box.minX, x - room);
		box.maxX = Math.max(box.maxX, x + room);
		box.minZ = Math.min(box.minZ, z - room);
		box.maxZ = Math.max(box.maxZ, z + room);
	};
	for (const cabinet of cabinets) {
		extend(cabinet.x, cabinet.z, HALL_MARGIN + 0.5);
		const [px, pz] = onFloor(PLAYER_SIDE, PLAYER_OUT);
		extend(cabinet.x + px, cabinet.z + pz, HALL_MARGIN);
	}
	extend(counter[0], counter[1], HALL_MARGIN + 0.6);
	extend(claw[0], claw[1], HALL_MARGIN + 0.4);
	if (!withYouSpot) {
		// A square-ish hall reads as a room, not a corridor.
		const half = Math.max(halfWidth, halfDepth);
		return {
			cabinets,
			claw,
			counter,
			halfDepth: half,
			halfWidth: half,
			you: null,
		};
	}
	// The act layer queues in front of the prize counter; the hall reaches
	// past the queue's last slot and is then centred on what it holds, so
	// the queue adds no empty floor at the back.
	const reachOf = arcadeYouSpot(counter, SLAB, portrait);
	for (const [x, , z] of [
		...Object.values(reachOf.points),
		reachOf.layout.offStage,
		reachOf.layout.tally,
	]) {
		extend(x, z, 0.8);
	}
	const shiftX = (box.minX + box.maxX) / 2;
	const shiftZ = (box.minZ + box.maxZ) / 2;
	const moved = (at: [number, number]): [number, number] => [
		at[0] - shiftX,
		at[1] - shiftZ,
	];
	const centredCounter = moved(counter);
	return {
		cabinets: cabinets.map((cabinet) => ({
			...cabinet,
			x: cabinet.x - shiftX,
			z: cabinet.z - shiftZ,
		})),
		claw: moved(claw),
		counter: centredCounter,
		halfDepth: (box.maxZ - box.minZ) / 2,
		halfWidth: (box.maxX - box.minX) / 2,
		you: { ...arcadeYouSpot(centredCounter, SLAB, portrait), portrait },
	};
}

/** The mark a phone's above-the-marquee plate wears for a pose. */
export const POSE_MARK: Partial<
	Record<VillagerPose, { className: string; sign: string }>
> = {
	failed: { className: "bg-(--gk-bad) text-white", sign: "×" },
	"needs-you": { className: "bg-(--gk-gold) text-(--gk-edge)", sign: "!" },
	working: { className: "bg-(--gk-info) text-white", sign: "…" },
};

/**
 * A machine's player pose. "waiting" only when you spoke last and nothing
 * runs ("sent, not picked up"); a machine that merely has conversations
 * is idle.
 */
export function playerPose(machine: Machine): VillagerPose {
	if (machine.tilt) {
		return "failed";
	}
	if (machine.running) {
		return "working";
	}
	if (machine.jackpots.length > 0) {
		return "needs-you";
	}
	const sent = machine.threads.some(
		(thread) => thread.lastMessageRole === "user" && !thread.running
	);
	return sent ? "waiting" : "idle";
}

/** Where a cabinet's player stands: beside it, a step toward the camera. */
export function playerSpot(cabinet: PlacedCabinet): [number, number] {
	const [x, z] = onFloor(PLAYER_SIDE, PLAYER_OUT);
	return [cabinet.x + x, cabinet.z + z];
}
