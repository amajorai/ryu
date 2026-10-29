import {
	AVENUE_COLUMNS,
	AVENUE_ROWS,
	BLOCK,
	COLUMNS,
	carPose,
	carProgress,
	drawnRoute,
	hashString,
	landPieces,
	laneRoute,
	laneShift,
	mapTrips,
	overviewPoints,
	PICKUP,
	type Point,
	type Rect,
	RIVER_HALF_WIDTH,
	type RideCar,
	type RideCity,
	type RideTrip,
	ROWS,
	riverCenter,
	routeLanes,
} from "./rides-model.ts";

/**
 * Rides in 3D: the part of the city the trips use, laid out in the game
 * kit's world units (x right, z toward the viewer, y up; north on the map
 * is away from the viewer). Pure and React-free, so it is tested directly.
 *
 * The diorama keeps only the streets something happens on: every street a
 * car, a pin or a route touches, the streets either side of the river, and
 * a street of margin all round. Streets with nothing on them between two
 * kept ones fold away, so the blocks between kept streets are one diorama
 * block each and a far-flung trip never shrinks the city to a map. The
 * fold keeps the grid's order, so routes stay on streets and still cross
 * the river on its bridges.
 */

export type Vec3 = [number, number, number];

/** One diorama block, street to street, is this many world units. */
export const UNITS_PER_BLOCK = 1.9;
/** Half the width of a street and of an avenue, in world units. */
export const STREET_HALF = 0.4;
export const AVENUE_HALF = 0.46;
/** A route lane's width, in world units (routes sharing a street split). */
const LANE_UNIT = 0.2;
/** A parked car pulls up this far short of its pin. */
const PARK_BACK = 0.75;

export interface WorldRect {
	maxX: number;
	maxZ: number;
	minX: number;
	minZ: number;
}

/**
 * The kept streets: grid columns and rows (in blocks) in order, and the
 * world offset that centres the diorama on the origin.
 */
export interface RidesFrame {
	cols: number[];
	offset: { x: number; z: number };
	/** The park's first column and row (as indices into the kept streets). */
	park: { col: number; row: number } | null;
	rows: number[];
}

/** The rows either side of the river, always kept so it reads as a river. */
const RIVER_ROWS = [7, 8, 9, 10];

/** Grid position (in blocks) to diorama position (in blocks), folding gaps. */
function fold(knots: readonly number[], value: number): number {
	const first = knots[0] ?? 0;
	const last = knots.at(-1) ?? first;
	if (value <= first) {
		return value - first;
	}
	if (value >= last) {
		return knots.length - 1 + (value - last);
	}
	for (let index = 1; index < knots.length; index++) {
		const low = knots[index - 1] ?? 0;
		const high = knots[index] ?? low;
		if (value <= high) {
			return index - 1 + (value - low) / Math.max(1e-6, high - low);
		}
	}
	return knots.length - 1;
}

/** The inverse of `fold`. */
function unfold(knots: readonly number[], value: number): number {
	const first = knots[0] ?? 0;
	const count = knots.length - 1;
	if (value <= 0) {
		return first + value;
	}
	if (value >= count) {
		return (knots.at(-1) ?? first) + (value - count);
	}
	const index = Math.floor(value);
	const low = knots[index] ?? first;
	const high = knots[index + 1] ?? low;
	return low + (value - index) * (high - low);
}

/** A map point (pixels) in world units on the ground. */
export function toWorld(frame: RidesFrame, point: Point, y = 0): Vec3 {
	return [
		fold(frame.cols, point.x / BLOCK) * UNITS_PER_BLOCK - frame.offset.x,
		y,
		fold(frame.rows, point.y / BLOCK) * UNITS_PER_BLOCK - frame.offset.z,
	];
}

/** World units back to map pixels. */
export function toMap(frame: RidesFrame, x: number, z: number): Point {
	return {
		x: unfold(frame.cols, (x + frame.offset.x) / UNITS_PER_BLOCK) * BLOCK,
		y: unfold(frame.rows, (z + frame.offset.z) / UNITS_PER_BLOCK) * BLOCK,
	};
}

/** Every street (column, row) a map point or route corner lies on. */
function usedLines(rides: RideCity): { cols: Set<number>; rows: Set<number> } {
	const cols = new Set<number>();
	const rows = new Set<number>();
	const add = (point: Point) => {
		cols.add(Math.round(point.x / BLOCK));
		rows.add(Math.round(point.y / BLOCK));
	};
	for (const point of overviewPoints(rides)) {
		add(point);
	}
	for (const trip of mapTrips(rides)) {
		for (const point of trip.route) {
			add(point);
		}
	}
	return { cols, rows };
}

/** Kept streets: the used ones, a margin each side, at least `min` of them. */
function keep(
	used: ReadonlySet<number>,
	extra: readonly number[],
	limit: number,
	min: number
): number[] {
	const lines = new Set([...used, ...extra]);
	const sorted = [...lines].sort((a, b) => a - b);
	let low = Math.max(0, (sorted[0] ?? 0) - 1);
	let high = Math.min(limit, (sorted.at(-1) ?? 0) + 1);
	lines.add(low);
	lines.add(high);
	while (lines.size < min && (low > 0 || high < limit)) {
		if (high < limit) {
			high += 1;
			lines.add(high);
		}
		if (lines.size < min && low > 0) {
			low -= 1;
			lines.add(low);
		}
	}
	return [...lines]
		.filter((line) => line >= 0 && line <= limit)
		.sort((a, b) => a - b);
}

/** The diorama keeps at least this many streets each way. */
const MIN_LINES = 6;

/** The kept streets for `rides`, centred, with a spot for the park. */
export function ridesFrame(rides: RideCity): RidesFrame {
	const used = usedLines(rides);
	const cols = keep(used.cols, [], COLUMNS, MIN_LINES);
	const rows = keep(used.rows, RIVER_ROWS, ROWS, MIN_LINES);
	const offset = {
		x: ((cols.length - 1) * UNITS_PER_BLOCK) / 2,
		z: ((rows.length - 1) * UNITS_PER_BLOCK) / 2,
	};
	const frame: RidesFrame = { cols, offset, park: null, rows };
	return { ...frame, park: parkSpot(frame, rides) };
}

/** Whether the river runs through the diorama block at (col, row) indices. */
function wetBlock(frame: RidesFrame, col: number, row: number): boolean {
	for (let step = 0; step <= 4; step++) {
		const x = unfold(frame.cols, col + step / 4) * BLOCK;
		const centre = fold(frame.rows, riverCenter(x) / BLOCK);
		const half = RIVER_HALF_WIDTH / BLOCK + 0.2;
		if (centre + half > row && centre - half < row + 1) {
			return true;
		}
	}
	return false;
}

interface Segment {
	from: Point;
	to: Point;
}

/** Whether a route segment runs along a street through a spot's middle. */
function splitsSpot(
	frame: RidesFrame,
	{ from, to }: Segment,
	col: number,
	row: number
): boolean {
	const fx = from.x / BLOCK;
	const tx = to.x / BLOCK;
	const fy = from.y / BLOCK;
	const ty = to.y / BLOCK;
	const midX = frame.cols[col + 1] ?? 0;
	const midY = frame.rows[row + 1] ?? 0;
	if (fx === tx && fx === midX) {
		return (
			Math.max(fy, ty) > (frame.rows[row] ?? 0) &&
			Math.min(fy, ty) < (frame.rows[row + 2] ?? 0)
		);
	}
	if (fy === ty && fy === midY) {
		return (
			Math.max(fx, tx) > (frame.cols[col] ?? 0) &&
			Math.min(fx, tx) < (frame.cols[col + 2] ?? 0)
		);
	}
	return false;
}

/**
 * The first two-by-two spot (from the back left) that no route runs
 * through and the river misses: the park.
 */
function parkSpot(frame: RidesFrame, rides: RideCity): RidesFrame["park"] {
	const segments: Segment[] = mapTrips(rides).flatMap((trip) =>
		trip.route.slice(1).map((to, index) => ({
			from: trip.route[index] ?? to,
			to,
		}))
	);
	const points = overviewPoints(rides);
	for (let row = 0; row + 2 < frame.rows.length; row++) {
		for (let col = 0; col + 2 < frame.cols.length; col++) {
			const wet = [0, 1].some((dr) =>
				[0, 1].some((dc) => wetBlock(frame, col + dc, row + dr))
			);
			if (wet) {
				continue;
			}
			const inside = (point: Point) => {
				const x = fold(frame.cols, point.x / BLOCK);
				const y = fold(frame.rows, point.y / BLOCK);
				return (
					x > col + 0.01 && x < col + 1.99 && y > row + 0.01 && y < row + 1.99
				);
			};
			const through = segments.some((segment) =>
				splitsSpot(frame, segment, col, row)
			);
			if (!(through || points.some(inside))) {
				return { col, row };
			}
		}
	}
	return null;
}

function inPark(frame: RidesFrame, col: number, row: number): boolean {
	const spot = frame.park;
	return (
		spot !== null &&
		col >= spot.col &&
		col < spot.col + 2 &&
		row >= spot.row &&
		row < spot.row + 2
	);
}

/** The city's paved extent in world units, its edge roads included. */
export function cityRect(frame: RidesFrame): WorldRect {
	return {
		maxX: frame.offset.x + AVENUE_HALF,
		maxZ: frame.offset.z + AVENUE_HALF,
		minX: -frame.offset.x - AVENUE_HALF,
		minZ: -frame.offset.z - AVENUE_HALF,
	};
}

function isAvenueColumn(col: number): boolean {
	return (AVENUE_COLUMNS as readonly number[]).includes(col);
}

function isAvenueRow(row: number): boolean {
	return (AVENUE_ROWS as readonly number[]).includes(row);
}

function roadHalf(avenue: boolean): number {
	return avenue ? AVENUE_HALF : STREET_HALF;
}

/** The river's centre (world z) at world x. */
export function riverAt(frame: RidesFrame, x: number): number {
	const map = toMap(frame, x, 0);
	return toWorld(frame, { x: map.x, y: riverCenter(map.x) })[2];
}

/** The river's half width in world units (its rows never fold). */
export const RIVER_HALF = (RIVER_HALF_WIDTH / BLOCK) * UNITS_PER_BLOCK;

/** Whether a world point is in the river (between its banks). */
export function inRiver(frame: RidesFrame, x: number, z: number): boolean {
	return Math.abs(z - riverAt(frame, x)) < RIVER_HALF;
}

export type LotKind = "house" | "tower";

/** One building on a block, in world units. */
export interface CityLot {
	/** Ground centre (on the block's kerb). */
	at: Vec3;
	depth: number;
	height: number;
	kind: LotKind;
	seed: number;
	width: number;
}

export interface CityBlock3d {
	dense: boolean;
	id: string;
	rect: WorldRect;
}

export interface CityScenery {
	lamps: Vec3[];
	trees: { at: Vec3; seed: number }[];
}

export interface RidesCityPlan {
	blocks: CityBlock3d[];
	bridges: { length: number; width: number; x: number; z: number }[];
	/** Dashes down the middle of the avenues. */
	dashes: { along: "x" | "z"; at: Vec3 }[];
	frame: RidesFrame;
	lots: CityLot[];
	park: WorldRect | null;
	rect: WorldRect;
	scenery: CityScenery;
}

/** The kerb's height: blocks are raised slabs a step above the road. */
export const KERB = 0.06;

/** Buildings along a block: little towers downtown, houses elsewhere. */
function fillBlock(
	block: CityBlock3d,
	lots: CityLot[],
	trees: CityScenery["trees"]
) {
	const { rect } = block;
	const width = rect.maxX - rect.minX;
	const depth = rect.maxZ - rect.minZ;
	const seed = hashString(block.id);
	const alongX = width >= depth;
	const length = alongX ? width : depth;
	const across = alongX ? depth : width;
	const size = block.dense ? 0.56 : 0.6;
	const count = Math.max(1, Math.floor((length - 0.12) / (size + 0.12)));
	const pitch = (length - 0.12) / count;
	const rows = across > size * 2 + 0.3 ? 2 : 1;
	const cx = (rect.minX + rect.maxX) / 2;
	const cz = (rect.minZ + rect.maxZ) / 2;
	for (let row = 0; row < rows; row++) {
		for (let index = 0; index < count; index++) {
			const lotSeed = seed + index * 31 + row * 97;
			const along = -length / 2 + 0.06 + pitch * (index + 0.5);
			const side = rows === 1 ? 0 : (row - 0.5) * (across / 2);
			const at: Vec3 = alongX
				? [cx + along, KERB, cz + side]
				: [cx + side, KERB, cz + along];
			// Every few lots a garden tree instead of a building.
			if (lotSeed % (block.dense ? 3 : 2) === 0) {
				trees.push({ at, seed: lotSeed });
				continue;
			}
			const deep =
				rows === 1 ? Math.min(across - 0.18, size + 0.06) : across / 2 - 0.14;
			const wide = Math.min(pitch - 0.12, size + 0.08);
			lots.push({
				at,
				depth: alongX ? deep : wide,
				height: block.dense
					? 0.45 + (lotSeed % 3) * 0.1
					: 0.3 + (lotSeed % 3) * 0.04,
				kind: block.dense ? "tower" : "house",
				seed: lotSeed,
				width: alongX ? wide : deep,
			});
		}
	}
}

/** Downtown (towers) is this many grid blocks round the pickup. */
const DENSE_RADIUS = 3;

function rectOf(frame: RidesFrame, rect: Rect): WorldRect {
	const [minX, , minZ] = toWorld(frame, { x: rect.x, y: rect.y });
	const [maxX, , maxZ] = toWorld(frame, {
		x: rect.x + rect.w,
		y: rect.y + rect.h,
	});
	return { maxX, maxZ, minX, minZ };
}

/** The blocks between kept streets, trimmed by the river, with their lots. */
function cityBlocks(frame: RidesFrame, scenery: CityScenery) {
	const blocks: CityBlock3d[] = [];
	const lots: CityLot[] = [];
	const lineX = (col: number) => col * UNITS_PER_BLOCK - frame.offset.x;
	const lineZ = (row: number) => row * UNITS_PER_BLOCK - frame.offset.z;
	for (let col = 0; col + 1 < frame.cols.length; col++) {
		for (let row = 0; row + 1 < frame.rows.length; row++) {
			if (inPark(frame, col, row)) {
				continue;
			}
			const gridCol = frame.cols[col] ?? 0;
			const gridRow = frame.rows[row] ?? 0;
			const nextCol = frame.cols[col + 1] ?? gridCol;
			const nextRow = frame.rows[row + 1] ?? gridRow;
			const world: WorldRect = {
				maxX: lineX(col + 1) - roadHalf(isAvenueColumn(nextCol)) - 0.05,
				maxZ: lineZ(row + 1) - roadHalf(isAvenueRow(nextRow)) - 0.05,
				minX: lineX(col) + roadHalf(isAvenueColumn(gridCol)) + 0.05,
				minZ: lineZ(row) + roadHalf(isAvenueRow(gridRow)) + 0.05,
			};
			// Trim by the river in map space, where the river is defined.
			const low = toMap(frame, world.minX, world.minZ);
			const high = toMap(frame, world.maxX, world.maxZ);
			const pieces = landPieces({
				h: high.y - low.y,
				w: high.x - low.x,
				x: low.x,
				y: low.y,
			});
			const downtown =
				Math.abs((gridCol + nextCol) / 2 - PICKUP.x / BLOCK) +
					Math.abs((gridRow + nextRow) / 2 - PICKUP.y / BLOCK) <
				DENSE_RADIUS;
			const seed = hashString(`block-${gridCol}-${gridRow}`);
			const dense = downtown ? seed % 3 !== 0 : seed % 6 === 0;
			for (const [index, piece] of pieces.entries()) {
				const block: CityBlock3d = {
					dense,
					id: `${gridCol}-${gridRow}-${index}`,
					rect: rectOf(frame, piece),
				};
				blocks.push(block);
				fillBlock(block, lots, scenery.trees);
			}
		}
	}
	return { blocks, lots };
}

/**
 * The city the diorama shows: a block between every pair of kept streets
 * (trimmed by the river), buildings on them, the park, bridges where
 * avenues cross the water, lane dashes, garden trees and lamps.
 */
export function buildCityPlan(frame: RidesFrame): RidesCityPlan {
	const scenery: CityScenery = { lamps: [], trees: [] };
	const { blocks, lots } = cityBlocks(frame, scenery);
	const lineX = (col: number) => col * UNITS_PER_BLOCK - frame.offset.x;
	const lineZ = (row: number) => row * UNITS_PER_BLOCK - frame.offset.z;
	const park = frame.park
		? {
				maxX: lineX(frame.park.col + 2) - STREET_HALF - 0.05,
				maxZ: lineZ(frame.park.row + 2) - STREET_HALF - 0.05,
				minX: lineX(frame.park.col) + STREET_HALF + 0.05,
				minZ: lineZ(frame.park.row) + STREET_HALF + 0.05,
			}
		: null;
	const rect = cityRect(frame);
	const bridges: RidesCityPlan["bridges"] = [];
	const dashes: RidesCityPlan["dashes"] = [];
	for (const [index, col] of frame.cols.entries()) {
		if (!isAvenueColumn(col)) {
			continue;
		}
		const x = lineX(index);
		const centre = riverAt(frame, x);
		if (centre > rect.minZ && centre < rect.maxZ) {
			bridges.push({
				length: RIVER_HALF * 2 + 0.36,
				width: AVENUE_HALF * 2 + 0.12,
				x,
				z: centre,
			});
		}
		for (let z = rect.minZ + 0.3; z < rect.maxZ - 0.2; z += 0.5) {
			if (Math.abs(z - centre) > RIVER_HALF + 0.2) {
				dashes.push({ along: "z", at: [x, 0.012, z] });
			}
		}
	}
	for (const [index, row] of frame.rows.entries()) {
		if (!isAvenueRow(row)) {
			continue;
		}
		const z = lineZ(index);
		for (let x = rect.minX + 0.3; x < rect.maxX - 0.2; x += 0.5) {
			dashes.push({ along: "x", at: [x, 0.012, z] });
		}
	}
	// A lamp on the near corner of every other crossing, off the water.
	for (let col = 0; col < frame.cols.length; col++) {
		for (let row = 0; row < frame.rows.length; row++) {
			const lx = lineX(col) + AVENUE_HALF + 0.1;
			const lz = lineZ(row) + AVENUE_HALF + 0.1;
			const inParkLand =
				park !== null &&
				lx > park.minX &&
				lx < park.maxX &&
				lz > park.minZ &&
				lz < park.maxZ;
			if (
				(col + row) % 2 === 0 &&
				lx < rect.maxX - 0.2 &&
				lz < rect.maxZ - 0.2 &&
				Math.abs(lz - riverAt(frame, lx)) > RIVER_HALF + 0.3 &&
				!inParkLand
			) {
				scenery.lamps.push([lx, KERB, lz]);
			}
		}
	}
	return { blocks, bridges, dashes, frame, lots, park, rect, scenery };
}

/** A car on the diorama: where it is, which way it heads. */
export interface CarSpot {
	/** Ground position (world units). */
	at: Vec3;
	car: RideCar;
	trip: RideTrip | undefined;
	/** Yaw: the car's nose (+z in its own frame) along its heading. */
	yaw: number;
}

/** The yaw that points a car's nose along a map heading (degrees, 0 east). */
export function headingYaw(heading: number): number {
	const radians = (heading * Math.PI) / 180;
	return Math.atan2(Math.cos(radians), Math.sin(radians));
}

/** Lanes for every trip the diorama draws. */
export function tripLanes(rides: RideCity): Map<string, number[]> {
	return routeLanes(
		mapTrips(rides).filter((trip) => trip.stage !== "cancelled")
	);
}

/**
 * Every car on the diorama, in its route's lane, a parked car pulled up
 * just short of its pin, a car at home at the kerb.
 */
export function carSpots(frame: RidesFrame, rides: RideCity): CarSpot[] {
	const lanes = tripLanes(rides);
	return rides.cars.map((car) => {
		const pose = carPose(car, rides.trips);
		const trip = rides.trips.find((item) => item.id === car.tripId);
		const radians = (pose.heading * Math.PI) / 180;
		const ahead = { x: Math.cos(radians), z: Math.sin(radians) };
		let shift = { x: 0, z: 0 };
		if (trip && car.state === "arrived") {
			shift = { x: -ahead.x * PARK_BACK, z: -ahead.z * PARK_BACK };
		} else if (trip) {
			const lane = laneShift(trip, lanes.get(trip.id), carProgress(car, trip));
			shift = { x: lane.x * LANE_UNIT, z: lane.y * LANE_UNIT };
		} else {
			// At home: pulled over to the kerb on the right.
			shift = { x: -ahead.z * 0.2, z: ahead.x * 0.2 };
		}
		const at = toWorld(frame, pose);
		return {
			at: [at[0] + shift.x, 0.02, at[2] + shift.z],
			car,
			trip,
			yaw: headingYaw(pose.heading),
		};
	});
}

/** A trip's drawn route in world points, in its lane. */
export function routePath(
	frame: RidesFrame,
	trip: RideTrip,
	selected: boolean,
	lanes: ReadonlyMap<string, number[]>
): Vec3[] {
	const drawn = drawnRoute(trip, selected);
	if (drawn.length < 2) {
		return [];
	}
	const unit = (LANE_UNIT / UNITS_PER_BLOCK) * BLOCK;
	const shifted =
		drawn.length === trip.route.length
			? laneRoute(drawn, lanes.get(trip.id), unit)
			: drawn;
	return shifted.map((point) => toWorld(frame, point, 0.02));
}

/** A plate to place: its anchor on the ground plan and its text's length. */
export interface PlateSpot {
	at: Vec3;
	chars: number;
	id: string;
}

/** The fixed isometric camera's pitch (see game3d-stage.tsx). */
const PITCH = 0.56;
/** A plate's size on the screen plane, in world units (estimated). */
const PLATE_HEIGHT = 0.5;
const CHAR_WIDTH = 0.15;
const PLATE_PAD = 0.5;
/** A plate that would overlap one already placed climbs this much. */
const LIFT = 0.55;

/** Where a world point lands on the screen plane: across and up. */
function screenPlane([x, y, z]: Vec3): [number, number] {
	return [
		(x - z) * Math.SQRT1_2,
		y * Math.cos(PITCH) - (x + z) * Math.SQRT1_2 * Math.sin(PITCH),
	];
}

/**
 * Plate heights that keep plates from overlapping: in order, each plate
 * climbs above any already placed that it would cover. Returns each id's
 * height above the ground.
 */
export function stackPlates(plates: readonly PlateSpot[]): Map<string, number> {
	const placed: { across: number; half: number; up: number }[] = [];
	const heights = new Map<string, number>();
	for (const plate of plates) {
		const half = (plate.chars * CHAR_WIDTH + PLATE_PAD) / 2;
		let y = plate.at[1];
		for (let tries = 0; tries < 8; tries++) {
			const [across, up] = screenPlane([plate.at[0], y, plate.at[2]]);
			const clash = placed.some(
				(other) =>
					Math.abs(other.across - across) < other.half + half &&
					Math.abs(other.up - up) < PLATE_HEIGHT
			);
			if (!clash) {
				break;
			}
			y += LIFT;
		}
		const [across, up] = screenPlane([plate.at[0], y, plate.at[2]]);
		placed.push({ across, half, up });
		heights.set(plate.id, y);
	}
	return heights;
}
