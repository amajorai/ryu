import type { PathModel, PathStop, PathUnit } from "./path-model.ts";

/**
 * The Path as a diorama on the 3D game kit (game3d-stage.tsx): a narrow
 * dirt trail of stepping stones winding up a terraced hill, one stone per
 * conversation, climbing in switchbacks from the front of the island to a
 * summit flag at the back. Each switchback row is a terrace a step higher
 * than the one before, with stairs where the trail climbs. A wooden
 * signpost stands at the start of each unit. Positions are world units (x
 * right, z toward the viewer, y up); this file is pure so it is testable.
 */

/** Space between stones along a row, and between rows. */
export const STONE_STEP = 2.2;
export const ROW_STEP = 3;
/** How far a signpost stands off the trail. */
const SIGN_OFFSET = 1.05;
/** At most this many stones to a row before the trail turns. */
const MAX_COLUMNS = 6;
const MIN_COLUMNS = 3;
/** How far the trail's samples are apart, for painting and avoiding it. */
const SAMPLE_STEP = 0.18;
/** How much higher each terrace stands than the one in front of it. */
export const TERRACE = 0.55;
/** Room kept round the trail for the island's rim. */
const BOUNDS_PAD_X = 1.6;
const BOUNDS_PAD_Z = 1.8;

export interface WorldStone {
	at: [number, number];
	/** Index along the trail, 0 at the start (the front of the island). */
	index: number;
	stop: PathStop;
	unit: PathUnit;
	/** The height of the terrace it sits on. */
	y: number;
}

export interface WorldSign {
	at: [number, number];
	unit: PathUnit;
	y: number;
}

/** A terrace: everything behind `front` stands at least `height` high. */
export interface Terrace {
	front: number;
	height: number;
	row: number;
}

/** A flight of steps where the trail climbs onto the next terrace. */
export interface TrailStair {
	at: [number, number];
	/** The terrace heights it climbs between. */
	from: number;
	to: number;
	/** Which way the trail runs there (radians about y). */
	yaw: number;
}

export interface PathWorld {
	bounds: { maxX: number; maxZ: number; minX: number; minZ: number };
	/** The summit flag after the last stone. */
	finish: [number, number];
	finishY: number;
	/** Where the mascot stands: on the stone the path points at. */
	mascot: { at: [number, number]; stone: WorldStone } | null;
	signs: WorldSign[];
	stairs: TrailStair[];
	stones: WorldStone[];
	terraces: Terrace[];
	/** Points along the trail's centre line, start to finish. */
	trail: [number, number][];
	/** The ground height under each trail point. */
	trailHeights: number[];
	/** The x range the terraces span. */
	width: { maxX: number; minX: number };
}

/** A small, stable offset in [-0.5, 0.5) for a stone, so rows look trodden. */
function wobble(index: number, salt: number): number {
	const value = Math.sin(index * 12.9898 + salt * 78.233) * 43_758.5453;
	return value - Math.floor(value) - 0.5;
}

/** Stones to a row: wider for longer paths, so the island stays squarish. */
export function trailColumns(count: number): number {
	return Math.min(
		MAX_COLUMNS,
		Math.max(MIN_COLUMNS, Math.ceil(Math.sqrt(count * 1.4)))
	);
}

/**
 * The n-th point of a switchback: rows run left to right, then right to
 * left, each row further back (toward -z), centred on the origin.
 */
function switchback(
	index: number,
	columns: number,
	rows: number
): [number, number] {
	const row = Math.floor(index / columns);
	const along = index % columns;
	const column = row % 2 === 0 ? along : columns - 1 - along;
	const x = (column - (columns - 1) / 2) * STONE_STEP;
	const z = ((rows - 1) / 2 - row) * ROW_STEP;
	return [x + wobble(index, 1) * 0.5, z + wobble(index, 2) * 0.45];
}

/** Catmull-Rom through `points`, `steps` samples per span. */
function spline(points: readonly [number, number][]): [number, number][] {
	if (points.length < 2) {
		return [...points];
	}
	const out: [number, number][] = [];
	for (let index = 0; index < points.length - 1; index++) {
		const p0 = points[Math.max(0, index - 1)] ?? points[index];
		const p1 = points[index];
		const p2 = points[index + 1];
		const p3 = points[Math.min(points.length - 1, index + 2)] ?? p2;
		if (!(p0 && p1 && p2 && p3)) {
			continue;
		}
		const span = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
		const steps = Math.max(2, Math.ceil(span / SAMPLE_STEP));
		for (let step = 0; step < steps; step++) {
			const t = step / steps;
			const t2 = t * t;
			const t3 = t2 * t;
			const at = (a: number, b: number, c: number, d: number) =>
				0.5 *
				(2 * b +
					(-a + c) * t +
					(2 * a - 5 * b + 4 * c - d) * t2 +
					(-a + 3 * b - 3 * c + d) * t3);
			out.push([
				at(p0[0], p1[0], p2[0], p3[0]),
				at(p0[1], p1[1], p2[1], p3[1]),
			]);
		}
	}
	const last = points.at(-1);
	if (last) {
		out.push(last);
	}
	return out;
}

/** Lays the path's stones, signs and trail out on the island. */
export function layoutPathWorld(model: PathModel): PathWorld {
	// The trail's slots in order: each unit's signpost takes a slot of its
	// own before its stones, so a sign and a stone are always a step apart;
	// the goal flag takes the last.
	type Slot =
		| { kind: "sign"; unit: PathUnit }
		| { kind: "stone"; stop: PathStop; unit: PathUnit };
	const sequence: Slot[] = [];
	for (const unit of model.units) {
		sequence.push({ kind: "sign", unit });
		for (const stop of unit.stops) {
			sequence.push({ kind: "stone", stop, unit });
		}
	}
	const slots = sequence.length + 1;
	const columns = trailColumns(slots);
	const rows = Math.max(1, Math.ceil(slots / columns));
	const stones: WorldStone[] = [];
	const signs: WorldSign[] = [];
	const points: [number, number][] = [];
	for (const [index, slot] of sequence.entries()) {
		const at = switchback(index, columns, rows);
		points.push(at);
		const y = Math.floor(index / columns) * TERRACE;
		if (slot.kind === "stone") {
			stones.push({
				at,
				index: stones.length,
				stop: slot.stop,
				unit: slot.unit,
				y,
			});
		} else {
			// The post stands just off the trail, toward the viewer.
			signs.push({ at: [at[0], at[1] + SIGN_OFFSET], unit: slot.unit, y });
		}
	}
	const finish = switchback(sequence.length, columns, rows);
	const trail = spline([...points, finish]);
	// The terraces: row r's ground runs from its front edge to the back.
	const frontZ = ((rows - 1) / 2) * ROW_STEP;
	const level = (z: number) =>
		Math.min(rows - 1, Math.max(0, Math.round((frontZ - z) / ROW_STEP)));
	const terraces: Terrace[] = [];
	for (let row = 1; row < rows; row++) {
		terraces.push({
			front: frontZ - row * ROW_STEP + ROW_STEP / 2,
			height: row * TERRACE,
			row,
		});
	}
	const trailHeights = trail.map(([, z]) => level(z) * TERRACE);
	const stairs: TrailStair[] = [];
	for (let index = 1; index < trail.length; index++) {
		const from = trailHeights[index - 1] ?? 0;
		const to = trailHeights[index] ?? 0;
		const a = trail[index - 1];
		const b = trail[index];
		if (from !== to && a && b) {
			stairs.push({
				at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
				from: Math.min(from, to),
				to: Math.max(from, to),
				yaw: Math.atan2(b[0] - a[0], b[1] - a[1]),
			});
		}
	}

	const current =
		stones.find((stone) => stone.stop.thread.id === model.currentThreadId) ??
		null;
	// The mascot stands on the stone itself.
	const mascot = current ? { at: current.at, stone: current } : null;

	const xs = [
		...trail.map(([x]) => x),
		...signs.map((sign) => sign.at[0]),
		finish[0],
	];
	const zs = [
		...trail.map(([, z]) => z),
		...signs.map((sign) => sign.at[1]),
		finish[1],
	];
	const bounds = {
		maxX: Math.max(...xs) + BOUNDS_PAD_X,
		maxZ: Math.max(...zs) + BOUNDS_PAD_Z,
		minX: Math.min(...xs) - BOUNDS_PAD_X,
		minZ: Math.min(...zs) - BOUNDS_PAD_Z,
	};
	const trailXs = trail.map(([x]) => x);
	return {
		bounds,
		finish,
		finishY: level(finish[1]) * TERRACE,
		mascot,
		signs,
		stairs,
		stones,
		terraces,
		trail,
		trailHeights,
		width: {
			maxX: Math.max(...trailXs) + 1.3,
			minX: Math.min(...trailXs) - 1.3,
		},
	};
}

/** How far (x, z) is from the trail's centre line. */
export function trailDistance(
	trail: readonly [number, number][],
	x: number,
	z: number
): number {
	let best = Number.POSITIVE_INFINITY;
	for (const [px, pz] of trail) {
		const distance = (px - x) ** 2 + (pz - z) ** 2;
		if (distance < best) {
			best = distance;
		}
	}
	return Math.sqrt(best);
}
