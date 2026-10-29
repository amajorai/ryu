import {
	type InterfaceAgent,
	type InterfaceEvent,
	type InterfaceSnapshot,
	type InterfaceThread,
	localDayKey,
	medianRunMs,
	THREAD_STATUS_ORDER,
	type ThreadStatus,
	threadStatus,
} from "@ryuhq/protocol/interfaces";

/**
 * Rides view model: a small, deterministic city and the trips on it. Pure
 * functions only, so the map, the sheet, and the tests agree on every
 * position, route, and estimate.
 *
 * The city is a street grid in world units (one block = {@link BLOCK}); a
 * river cuts across it, a park fills a corner, and two diagonal avenues
 * break the grid. You stand at the pickup point; every conversation is a
 * trip from there to its own destination, driven by its first agent.
 */

export interface Point {
	x: number;
	y: number;
}

export interface Rect {
	h: number;
	w: number;
	x: number;
	y: number;
}

export const BLOCK = 160;
export const COLUMNS = 20;
export const ROWS = 14;
export const WORLD = { height: ROWS * BLOCK, width: COLUMNS * BLOCK };

/** Columns and rows that carry the wide avenues (and the river bridges). */
export const AVENUE_COLUMNS = [2, 6, 10, 14, 18] as const;
export const AVENUE_ROWS = [3, 6, 11] as const;
/** Rows the river runs through: no intersection there is a stop. */
const RIVER_ROWS = new Set([8, 9]);
/**
 * The park spans these grid cells, between avenues so no through road cuts
 * it; its inner streets are paths.
 */
export const PARK = { col: 3, cols: 3, row: 4, rows: 2 };
/** You, the rider: the pickup point every trip starts from. */
export const PICKUP_CELL = { col: 10, row: 6 };
export const PICKUP: Point = cellPoint(PICKUP_CELL.col, PICKUP_CELL.row);

const RIVER_BASE = 1356;
const RIVER_SWING = 84;
export const RIVER_HALF_WIDTH = 58;
/**
 * How far past the city the camera may look: a band of plain outskirts. The
 * map draws every road, the river, and the land {@link DRAWN_BEYOND} past
 * the city, further than this, so the world never visibly ends.
 */
export const OUTSKIRTS = BLOCK * 5;
export const DRAWN_BEYOND = BLOCK * 8;

export function cellPoint(col: number, row: number): Point {
	return { x: col * BLOCK, y: row * BLOCK };
}

/** Stable 32-bit hash, so a thread keeps its destination across sessions. */
export function hashString(value: string): number {
	let hash = 2_166_136_261;
	for (const char of value) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16_777_619);
	}
	return hash >>> 0;
}

export function riverCenter(x: number): number {
	return RIVER_BASE + RIVER_SWING * Math.sin(x / 430 + 0.6);
}

// ---------------------------------------------------------------------------
// The city
// ---------------------------------------------------------------------------

export interface CityBlock extends Rect {
	/** Denser downtown blocks read a shade darker. */
	dense: boolean;
	id: string;
}

export interface CityRoad {
	from: Point;
	id: string;
	name: string | null;
	to: Point;
}

export interface CityLabel extends Point {
	id: string;
	text: string;
}

export interface City {
	avenues: CityRoad[];
	blocks: CityBlock[];
	diagonals: CityRoad[];
	districts: CityLabel[];
	park: Rect;
	parkPaths: string[];
	river: { centerline: string; outline: string };
}

const AVENUE_NAMES: Record<string, string> = {
	"col-2": "Mill Street",
	"col-6": "Garden Avenue",
	"col-10": "Central Avenue",
	"col-14": "Station Road",
	"col-18": "Quarry Lane",
	"row-3": "North Boulevard",
	"row-6": "Market Street",
	"row-11": "Harbour Road",
};

export function inPark(col: number, row: number): boolean {
	return (
		col >= PARK.col &&
		col < PARK.col + PARK.cols &&
		row >= PARK.row &&
		row < PARK.row + PARK.rows
	);
}

/** Land kept clear between the river bank and the nearest block. */
export const BANK = 14;
/** A block trimmed by the river shorter than this is dropped. */
const MIN_BLOCK = 28;

/**
 * The parts of `rect` on dry land: a block the river runs through is cut
 * back to clear its banks (by {@link BANK}) above and below the water, and
 * a sliver left over is dropped, so no block peeks out of the river.
 */
export function landPieces(rect: Rect): Rect[] {
	let top = Number.POSITIVE_INFINITY;
	let bottom = Number.NEGATIVE_INFINITY;
	const steps = 8;
	for (let step = 0; step <= steps; step += 1) {
		const center = riverCenter(rect.x + (rect.w * step) / steps);
		top = Math.min(top, center - RIVER_HALF_WIDTH - BANK);
		bottom = Math.max(bottom, center + RIVER_HALF_WIDTH + BANK);
	}
	if (rect.y + rect.h <= top || rect.y >= bottom) {
		return [rect];
	}
	const pieces: Rect[] = [];
	const above = top - rect.y;
	if (above >= MIN_BLOCK) {
		pieces.push({ ...rect, h: above });
	}
	const below = rect.y + rect.h - bottom;
	if (below >= MIN_BLOCK) {
		pieces.push({ ...rect, h: below, y: bottom });
	}
	return pieces;
}

function cityBlocks(): CityBlock[] {
	const blocks: CityBlock[] = [];
	const inset = 11;
	for (let col = 0; col < COLUMNS; col += 1) {
		for (let row = 0; row < ROWS; row += 1) {
			if (inPark(col, row)) {
				continue;
			}
			const seed = hashString(`block-${col}-${row}`);
			const downtown =
				Math.abs(col - PICKUP_CELL.col) + Math.abs(row - PICKUP_CELL.row) < 6;
			const dense = downtown ? seed % 3 !== 0 : seed % 5 === 0;
			const x = col * BLOCK + inset;
			const y = row * BLOCK + inset;
			const size = BLOCK - inset * 2;
			// Some blocks split in two along a service lane, so the grid does
			// not read as graph paper.
			if (seed % 4 === 0) {
				const half = (size - inset) / 2;
				blocks.push(
					{ dense, h: size, id: `${col}-${row}-a`, w: half, x, y },
					{
						dense: !dense && seed % 8 === 0,
						h: size,
						id: `${col}-${row}-b`,
						w: half,
						x: x + half + inset,
						y,
					}
				);
			} else if (seed % 4 === 1) {
				const half = (size - inset) / 2;
				blocks.push(
					{ dense, h: half, id: `${col}-${row}-a`, w: size, x, y },
					{
						dense,
						h: half,
						id: `${col}-${row}-b`,
						w: size,
						x,
						y: y + half + inset,
					}
				);
			} else {
				blocks.push({ dense, h: size, id: `${col}-${row}`, w: size, x, y });
			}
		}
	}
	return blocks.flatMap((block) =>
		landPieces(block).map((piece, index) => ({
			...block,
			...piece,
			id: index === 0 ? block.id : `${block.id}-${index}`,
		}))
	);
}

function riverShapes(): City["river"] {
	const top: string[] = [];
	const bottom: string[] = [];
	const center: string[] = [];
	const margin = DRAWN_BEYOND + BLOCK;
	for (let x = -margin; x <= WORLD.width + margin; x += 40) {
		const y = riverCenter(x);
		top.push(`${x} ${(y - RIVER_HALF_WIDTH).toFixed(1)}`);
		bottom.push(`${x} ${(y + RIVER_HALF_WIDTH).toFixed(1)}`);
		center.push(`${x} ${y.toFixed(1)}`);
	}
	bottom.reverse();
	return {
		centerline: `M${center.join(" L")}`,
		outline: `M${top.join(" L")} L${bottom.join(" L")} Z`,
	};
}

let cachedCity: City | null = null;

/** `road` lengthened by `by` world units at both ends. */
function extendRoad(road: CityRoad, by: number): CityRoad {
	const length = Math.hypot(road.to.x - road.from.x, road.to.y - road.from.y);
	const dx = ((road.to.x - road.from.x) / length) * by;
	const dy = ((road.to.y - road.from.y) / length) * by;
	return {
		...road,
		from: { x: road.from.x - dx, y: road.from.y - dy },
		to: { x: road.to.x + dx, y: road.to.y + dy },
	};
}

/** The one city every Rides map draws. Built once, then shared. */
export function buildCity(): City {
	if (cachedCity) {
		return cachedCity;
	}
	const avenues: CityRoad[] = [
		...AVENUE_COLUMNS.map((col) => ({
			from: { x: col * BLOCK, y: -DRAWN_BEYOND },
			id: `col-${col}`,
			name: AVENUE_NAMES[`col-${col}`] ?? null,
			to: { x: col * BLOCK, y: WORLD.height + DRAWN_BEYOND },
		})),
		...AVENUE_ROWS.map((row) => ({
			from: { x: -DRAWN_BEYOND, y: row * BLOCK },
			id: `row-${row}`,
			name: AVENUE_NAMES[`row-${row}`] ?? null,
			to: { x: WORLD.width + DRAWN_BEYOND, y: row * BLOCK },
		})),
	];
	const diagonals: CityRoad[] = (
		[
			{
				from: { x: -BLOCK, y: WORLD.height + BLOCK * 0.5 },
				id: "diagonal-west",
				name: "Founders Way",
				to: { x: BLOCK * 15.5, y: -BLOCK },
			},
			{
				from: { x: BLOCK * 12, y: WORLD.height + BLOCK },
				id: "diagonal-east",
				name: "Canal Parade",
				to: { x: WORLD.width + BLOCK, y: BLOCK * 6 },
			},
		] satisfies CityRoad[]
	).map((road) => extendRoad(road, DRAWN_BEYOND));
	const park: Rect = {
		h: PARK.rows * BLOCK - 22,
		w: PARK.cols * BLOCK - 22,
		x: PARK.col * BLOCK + 11,
		y: PARK.row * BLOCK + 11,
	};
	const left = park.x + 40;
	const right = park.x + park.w - 40;
	const top = park.y + 40;
	const bottom = park.y + park.h - 40;
	const parkPaths = [
		`M${park.x} ${bottom - 30} C ${left + 80} ${bottom - 60}, ${right - 120} ${top + 140}, ${park.x + park.w} ${top + 10}`,
		`M${left + 60} ${park.y} C ${left + 120} ${top + 120}, ${right - 160} ${bottom - 40}, ${right - 30} ${park.y + park.h}`,
	];
	cachedCity = {
		avenues,
		blocks: cityBlocks(),
		diagonals,
		districts: [
			{ id: "old-town", text: "Old Town", x: BLOCK * 8, y: BLOCK * 1.5 },
			{ id: "west-end", text: "West End", x: BLOCK * 1.5, y: BLOCK * 2.5 },
			{ id: "market", text: "Market", x: BLOCK * 12.5, y: BLOCK * 4.5 },
			{ id: "north-hill", text: "North Hill", x: BLOCK * 16.5, y: BLOCK * 1.5 },
			{ id: "riverside", text: "Riverside", x: BLOCK * 7.5, y: BLOCK * 12.5 },
			{ id: "docklands", text: "Docklands", x: BLOCK * 16.5, y: BLOCK * 12.5 },
		],
		park,
		parkPaths,
		river: riverShapes(),
	};
	return cachedCity;
}

/**
 * How far past the water each bridge span reaches. The map clips the deck's
 * edges to the river, so this only has to cover a diagonal road's far edge,
 * which meets the bank later than its centre line.
 */
const BRIDGE_LANDING = 40;
const BRIDGE_SAMPLES = 800;

/**
 * Where `road` crosses the river: the stretches over water, each extended
 * a little onto the banks. The map draws these as bridge decks with a
 * casing, so a car crossing reads as driving over a bridge, not on water.
 */
export function bridgeSpans(road: CityRoad): { from: Point; to: Point }[] {
	const spans: { from: Point; to: Point }[] = [];
	const at = (share: number): Point => ({
		x: road.from.x + (road.to.x - road.from.x) * share,
		y: road.from.y + (road.to.y - road.from.y) * share,
	});
	const wet = (point: Point) =>
		Math.abs(point.y - riverCenter(point.x)) <=
		RIVER_HALF_WIDTH + BRIDGE_LANDING;
	let start: number | null = null;
	for (let step = 0; step <= BRIDGE_SAMPLES; step += 1) {
		const share = step / BRIDGE_SAMPLES;
		if (wet(at(share))) {
			// From the last dry sample, so the deck always covers the bank.
			start ??= Math.max(0, share - 1 / BRIDGE_SAMPLES);
		} else if (start !== null) {
			spans.push({ from: at(start), to: at(share) });
			start = null;
		}
	}
	if (start !== null) {
		spans.push({ from: at(start), to: road.to });
	}
	return spans;
}

// ---------------------------------------------------------------------------
// Stops and routes
// ---------------------------------------------------------------------------

interface Cell {
	col: number;
	row: number;
}

/** Intersections where a car can wait or a trip can end. */
function stopCells(): Cell[] {
	const cells: Cell[] = [];
	for (let row = 1; row < ROWS; row += 1) {
		for (let col = 1; col < COLUMNS; col += 1) {
			if (RIVER_ROWS.has(row)) {
				continue;
			}
			// Inside the park, where the streets are footpaths.
			if (
				col > PARK.col &&
				col < PARK.col + PARK.cols &&
				row > PARK.row &&
				row < PARK.row + PARK.rows
			) {
				continue;
			}
			if (col === PICKUP_CELL.col && row === PICKUP_CELL.row) {
				continue;
			}
			cells.push({ col, row });
		}
	}
	return cells;
}

const STOP_CELLS = stopCells();

function cellKey(cell: Cell): string {
	return `${cell.col}:${cell.row}`;
}

function gridDistance(a: Cell, b: Cell): number {
	return Math.abs(a.col - b.col) + Math.abs(a.row - b.row);
}

/**
 * A free stop for `key`, chosen by hash and probed forward past taken ones,
 * within `[min, max]` blocks of the pickup.
 */
function claimCell(
	key: string,
	taken: Set<string>,
	min: number,
	max: number
): Cell {
	const pool = STOP_CELLS.filter((cell) => {
		const distance = gridDistance(cell, PICKUP_CELL);
		return distance >= min && distance <= max;
	});
	const start = hashString(key) % pool.length;
	for (let offset = 0; offset < pool.length; offset += 1) {
		const cell = pool[(start + offset) % pool.length];
		if (cell && !taken.has(cellKey(cell))) {
			// Keep the neighbouring corners free too, so pins and their chips
			// never sit on top of each other.
			for (let dc = -1; dc <= 1; dc += 1) {
				for (let dr = -1; dr <= 1; dr += 1) {
					taken.add(cellKey({ col: cell.col + dc, row: cell.row + dr }));
				}
			}
			return cell;
		}
	}
	return pool[start] ?? PICKUP_CELL;
}

function isAcrossRiver(cell: Cell): boolean {
	return cell.row > Math.max(...RIVER_ROWS);
}

/** The bridge (avenue) column nearest to `col`. */
function nearestAvenue(col: number): number {
	let best: number = AVENUE_COLUMNS[0];
	for (const avenue of AVENUE_COLUMNS) {
		if (Math.abs(avenue - col) < Math.abs(best - col)) {
			best = avenue;
		}
	}
	return best;
}

/**
 * The driven route from the pickup to `cell`, along streets only. Trips
 * across the river run along Market Street to the bridge nearest the
 * destination, cross, and turn onto the destination's street; others run
 * along Market Street and turn up the destination's street.
 */
export function routeTo(cell: Cell): Point[] {
	const start = PICKUP_CELL;
	let corners: Cell[];
	if (isAcrossRiver(cell)) {
		const bridge = nearestAvenue(cell.col);
		corners = [
			{ col: bridge, row: start.row },
			{ col: bridge, row: cell.row },
		];
	} else {
		corners = [{ col: cell.col, row: start.row }];
	}
	const points = [start, ...corners, cell]
		.filter(
			(point, index, all) =>
				index === 0 || cellKey(point) !== cellKey(all[index - 1] ?? point)
		)
		.map((point) => cellPoint(point.col, point.row));
	return points.length === 1 ? [...points, ...points] : points;
}

export function routeLength(route: readonly Point[]): number {
	let length = 0;
	for (let index = 1; index < route.length; index += 1) {
		const from = route[index - 1];
		const to = route[index];
		if (from && to) {
			length += Math.hypot(to.x - from.x, to.y - from.y);
		}
	}
	return length;
}

/** Position and heading (degrees, 0 = east, clockwise) at `progress` (0..1). */
export function pointAlong(
	route: readonly Point[],
	progress: number
): Point & { heading: number } {
	const total = routeLength(route);
	let remaining = Math.min(1, Math.max(0, progress)) * total;
	let heading = 0;
	for (let index = 1; index < route.length; index += 1) {
		const from = route[index - 1];
		const to = route[index];
		if (!(from && to)) {
			continue;
		}
		const length = Math.hypot(to.x - from.x, to.y - from.y);
		if (length === 0) {
			continue;
		}
		heading = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
		if (remaining <= length) {
			const share = remaining / length;
			return {
				heading,
				x: from.x + (to.x - from.x) * share,
				y: from.y + (to.y - from.y) * share,
			};
		}
		remaining -= length;
	}
	const last = route.at(-1) ?? PICKUP;
	return { heading, x: last.x, y: last.y };
}

// ---------------------------------------------------------------------------
// Estimates
// ---------------------------------------------------------------------------

export const MINUTE = 60_000;
/** Used when an agent has no finished runs to learn from. */
export const DEFAULT_TRIP_MINUTES = 4;
const MIN_TRIP_MINUTES = 1;
const MAX_TRIP_MINUTES = 45;

/**
 * An agent's typical time to reply, in whole minutes: the median of its
 * finished scheduled runs (the protocol's `medianRunMs`, pooled over the
 * agent's routines), or {@link DEFAULT_TRIP_MINUTES} without any.
 */
export function typicalMinutes(
	agentId: string | null | undefined,
	events: readonly InterfaceEvent[] | undefined
): number {
	// `medianRunMs` treats a missing agent as "every agent"; a trip with no
	// agent only learns from runs that have none either.
	const median =
		agentId == null
			? medianRunMs(
					events?.filter((event) => event.agentId === agentId),
					{}
				)
			: medianRunMs(events, { agentId });
	if (median === null) {
		return DEFAULT_TRIP_MINUTES;
	}
	return Math.min(
		MAX_TRIP_MINUTES,
		Math.max(MIN_TRIP_MINUTES, Math.round(median / MINUTE))
	);
}

/** Where a live trip has got to, and the minutes left on the estimate. */
export function tripProgress(
	updatedAt: string,
	typical: number,
	now: number
): { etaMinutes: number; progress: number } {
	const started = Date.parse(updatedAt);
	const elapsed = Number.isNaN(started)
		? 0
		: Math.max(0, (now - started) / MINUTE);
	return {
		etaMinutes: Math.max(0, Math.ceil(typical - elapsed)),
		// Never quite at the pin: the car only arrives when the agent replies.
		progress: Math.min(0.94, Math.max(0.02, elapsed / typical)),
	};
}

export function etaLabel(minutes: number): string {
	return minutes < 1 ? "<1 min" : `${minutes} min`;
}

// ---------------------------------------------------------------------------
// Trips and cars
// ---------------------------------------------------------------------------

export type TripStage =
	| "arrived"
	| "cancelled"
	| "completed"
	| "enroute"
	| "requested"
	| "unassigned"
	| "unstarted";

const STAGE_BY_STATUS: Record<ThreadStatus, TripStage> = {
	attention: "cancelled",
	quiet: "unstarted",
	waiting: "requested",
	working: "enroute",
	"your-turn": "arrived",
};

export const STAGE_LABELS: Record<TripStage, string> = {
	arrived: "Arrived",
	cancelled: "Cancelled",
	completed: "Completed",
	enroute: "En route",
	requested: "Requested",
	unassigned: "No driver assigned",
	unstarted: "Not started",
};

/** Stages whose route and pin are drawn on the map. */
const ON_MAP = new Set<TripStage>([
	"arrived",
	"cancelled",
	"enroute",
	"requested",
]);

/** Arrived cars wait at the pin this long; after that the trip is history. */
export const PARKED_FOR = 12 * 60 * MINUTE;
/** A car that has just set off is drawn this far along, clear of you. */
const SET_OFF_DISTANCE = 72;

/**
 * The stage a conversation shows as. A thread nobody can drive is never a
 * live request, and a reply older than {@link PARKED_FOR} is a finished trip.
 */
export function tripStage(
	thread: InterfaceThread,
	hasDriver: boolean,
	now: number
): TripStage {
	const stage = unassignedOr(STAGE_BY_STATUS[threadStatus(thread)], hasDriver);
	if (stage === "arrived" && now - Date.parse(thread.updatedAt) >= PARKED_FOR) {
		return "completed";
	}
	return stage;
}

/** Nobody can drive a live request without a driver. */
function unassignedOr(stage: TripStage, hasDriver: boolean): TripStage {
	return !hasDriver && (stage === "requested" || stage === "enroute")
		? "unassigned"
		: stage;
}

export interface RideTrip {
	/**
	 * No car is on this trip: its driver is on (or parked at) another one.
	 * The map draws it as a dotted route and a pin, never a second car.
	 */
	carless: boolean;
	destination: Point;
	driver: InterfaceAgent | undefined;
	/** Minutes left on the estimate, for trips en route. */
	etaMinutes: number | null;
	id: string;
	/** 0..1 along the route, for trips en route. */
	progress: number;
	route: Point[];
	stage: TripStage;
	status: ThreadStatus;
	thread: InterfaceThread;
	/** The driver's typical minutes per reply. */
	typical: number;
}

/**
 * `queued` is a requested trip nobody has picked up yet: the car waits at
 * the start of its route, drawn as an outline, until the run begins.
 */
export type CarState = "arrived" | "driving" | "idle" | "queued";

export interface RideCar {
	agent: InterfaceAgent;
	/** Where the car waits between trips. */
	home: Point;
	/** The agent's id: every agent has exactly one car. */
	id: string;
	state: CarState;
	/** The trip the car is on, parked at, or waiting to start. */
	tripId: string | null;
}

export interface RideCity {
	cars: RideCar[];
	trips: RideTrip[];
}

function byRecency(a: InterfaceThread, b: InterfaceThread): number {
	return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

/**
 * Lay out every agent's car and every conversation's trip. Homes are
 * claimed first (near the pickup, like cars around a rider), then
 * destinations, each by hash so nothing moves between snapshots.
 */
export function buildRides(
	snapshot: InterfaceSnapshot,
	now: number = Date.now(),
	/**
	 * With the act layer: each thread's stage from its act (never from how
	 * old `updatedAt` is), and where a working car is along its route
	 * (`progress.done / total`, or a fixed start without progress).
	 */
	acted?: {
		progressOf: (thread: InterfaceThread) => number | null;
		stageOf: (thread: InterfaceThread) => TripStage;
	}
): RideCity {
	const taken = new Set<string>();
	const homes = new Map<string, Point>();
	const agents = [...snapshot.agents].sort((a, b) => a.id.localeCompare(b.id));
	for (const agent of agents) {
		const cell = claimCell(`home:${agent.id}`, taken, 2, 6);
		homes.set(agent.id, cellPoint(cell.col, cell.row));
	}
	const typicalByAgent = new Map<string, number>();
	const typicalFor = (agentId: string | undefined) => {
		const key = agentId ?? "";
		const cached = typicalByAgent.get(key);
		if (cached !== undefined) {
			return cached;
		}
		const value = typicalMinutes(agentId, snapshot.events);
		typicalByAgent.set(key, value);
		return value;
	};

	// Trips on the map claim the near corners first, so the overview stays
	// compact; history (never drawn) takes whatever is left further out.
	const staged = [...snapshot.threads]
		.sort((a, b) => a.id.localeCompare(b.id))
		.map((thread) => {
			const driverId = thread.agentIds[0];
			const driver = snapshot.agents.find((agent) => agent.id === driverId);
			const stage = acted
				? unassignedOr(acted.stageOf(thread), Boolean(driver))
				: tripStage(thread, Boolean(driver), now);
			return { driver, stage, thread };
		});
	const drawn = (stage: TripStage) => ON_MAP.has(stage);
	const ordered = [
		...staged.filter((item) => drawn(item.stage)),
		...staged.filter((item) => !drawn(item.stage)),
	];
	const trips: RideTrip[] = [];
	for (const { driver, stage, thread } of ordered) {
		const cell = drawn(stage)
			? claimCell(`trip:${thread.id}`, taken, 3, 8)
			: claimCell(`trip:${thread.id}`, taken, 3, 12);
		const typical = typicalFor(driver?.id);
		const route = routeTo(cell);
		let live: { etaMinutes: number | null; progress: number } = {
			etaMinutes: null,
			progress: stage === "arrived" || stage === "completed" ? 1 : 0,
		};
		if (stage === "enroute" && acted) {
			// Route position is the act's pips, never a guess from the clock.
			const floor = SET_OFF_DISTANCE / Math.max(1, routeLength(route));
			live = {
				etaMinutes: null,
				progress: Math.min(
					0.94,
					Math.max(floor, acted.progressOf(thread) ?? floor)
				),
			};
		} else if (stage === "enroute") {
			const estimate = tripProgress(thread.updatedAt, typical, now);
			const floor = SET_OFF_DISTANCE / Math.max(1, routeLength(route));
			live = {
				etaMinutes: estimate.etaMinutes,
				progress: Math.min(0.94, Math.max(floor, estimate.progress)),
			};
		}
		trips.push({
			carless: false,
			destination: cellPoint(cell.col, cell.row),
			driver,
			etaMinutes: live.etaMinutes,
			id: thread.id,
			progress: live.progress,
			route,
			stage,
			status: threadStatus(thread),
			thread,
			typical,
		});
	}
	trips.sort((a, b) => byRecency(a.thread, b.thread));

	const cars = placeCars(snapshot.agents, trips, homes);
	const driven = new Set(cars.map((car) => car.tripId));
	return {
		cars,
		trips: trips.map((trip) =>
			ON_MAP.has(trip.stage) &&
			trip.stage !== "cancelled" &&
			!driven.has(trip.id)
				? { ...trip, carless: true }
				: trip
		),
	};
}

function byAge(a: RideTrip, b: RideTrip): number {
	return (
		a.thread.updatedAt.localeCompare(b.thread.updatedAt) ||
		a.id.localeCompare(b.id)
	);
}

/**
 * One car per agent, because a driver can only be in one place. It drives
 * the agent's oldest trip en route (so a second booking never pulls it off
 * the first); failing that it is parked at the most recent arrival, then
 * waiting at the start of the oldest requested trip, then at home. Every
 * other trip of that agent is drawn without a car.
 */
function placeCars(
	agents: readonly InterfaceAgent[],
	trips: readonly RideTrip[],
	homes: ReadonlyMap<string, Point>
): RideCar[] {
	return agents.map((agent) => {
		const home = homes.get(agent.id) ?? PICKUP;
		const own = trips.filter((trip) => trip.driver?.id === agent.id);
		const oldest = (stage: TripStage) =>
			own.filter((trip) => trip.stage === stage).sort(byAge)[0];
		const driving = oldest("enroute");
		const arrived = own
			.filter((trip) => trip.stage === "arrived")
			.sort((a, b) => byRecency(a.thread, b.thread))[0];
		const queued = oldest("requested");
		let state: CarState = "idle";
		let trip: RideTrip | undefined;
		if (driving) {
			state = "driving";
			trip = driving;
		} else if (arrived) {
			state = "arrived";
			trip = arrived;
		} else if (queued) {
			state = "queued";
			trip = queued;
		}
		return { agent, home, id: agent.id, state, tripId: trip?.id ?? null };
	});
}

/** Where a car is drawn right now, and which way it points. */
export function carPose(
	car: RideCar,
	trips: readonly RideTrip[]
): Point & { heading: number } {
	const trip = car.tripId
		? trips.find((item) => item.id === car.tripId)
		: undefined;
	if (!trip) {
		// Parked facing along the street, varied by agent.
		return { ...car.home, heading: (hashString(car.agent.id) % 4) * 90 };
	}
	if (car.state === "arrived") {
		return pointAlong(trip.route, 1);
	}
	if (car.state === "queued") {
		return pointAlong(trip.route, setOffShare(trip.route));
	}
	return pointAlong(trip.route, trip.progress);
}

/**
 * Screen pixels a parked car stops short of its pin, so the car and the
 * destination marker both stay in view, the way a rider app shows a car
 * pulled up at the drop-off.
 */
export const PARK_GAP = 24;

/** The screen offset that pulls a parked car back from its pin. */
export function parkedShift(heading: number): Point {
	const radians = (heading * Math.PI) / 180;
	// `+ 0` turns a rounded -0 into 0.
	return {
		x: Math.round(-Math.cos(radians) * PARK_GAP) + 0,
		y: Math.round(-Math.sin(radians) * PARK_GAP) + 0,
	};
}

/** A requested trip's ghost car waits this far along its route. */
const QUEUED_DISTANCE = BLOCK;

/**
 * The share of `route` a requested trip's ghost car waits at: a block out,
 * clear of you and your label, and never past halfway.
 */
function setOffShare(route: readonly Point[]): number {
	return Math.min(0.5, QUEUED_DISTANCE / Math.max(1, routeLength(route)));
}

// ---------------------------------------------------------------------------
// Lanes: routes that share a street are drawn side by side
// ---------------------------------------------------------------------------

/** Screen pixels between the centres of two routes sharing a street. */
export const LANE_PX = 7;

interface LaneSpan {
	high: number;
	index: number;
	low: number;
	order: number;
	tripId: string;
}

function assignLanes(spans: LaneSpan[], lanes: Map<string, number[]>): void {
	const sorted = [...spans].sort((a, b) => a.low - b.low);
	let group: LaneSpan[] = [];
	let reach = Number.NEGATIVE_INFINITY;
	const flush = () => {
		if (group.length > 1) {
			group.sort(
				(a, b) => a.order - b.order || a.tripId.localeCompare(b.tripId)
			);
			for (const [lane, span] of group.entries()) {
				const offsets = lanes.get(span.tripId);
				if (offsets) {
					offsets[span.index] = lane - (group.length - 1) / 2;
				}
			}
		}
		group = [];
		reach = Number.NEGATIVE_INFINITY;
	};
	for (const span of sorted) {
		if (span.low >= reach) {
			flush();
		}
		group.push(span);
		reach = Math.max(reach, span.high);
	}
	flush();
}

/**
 * Lane offsets (in lanes, centred on 0) for each segment of each route.
 * Where routes run along the same stretch of street they split into
 * parallel lanes, ordered by where they turn off (northbound turns on the
 * north side, westbound on the west) so the lines never cross to leave.
 */
export function routeLanes(trips: readonly RideTrip[]): Map<string, number[]> {
	const lanes = new Map<string, number[]>();
	const lines = new Map<string, LaneSpan[]>();
	for (const trip of trips) {
		lanes.set(
			trip.id,
			Array.from({ length: Math.max(0, trip.route.length - 1) }, () => 0)
		);
		for (let index = 1; index < trip.route.length; index += 1) {
			const from = trip.route[index - 1];
			const to = trip.route[index];
			if (!(from && to) || (from.x === to.x && from.y === to.y)) {
				continue;
			}
			const horizontal = from.y === to.y;
			const key = horizontal ? `h:${from.y}` : `v:${from.x}`;
			const spans = lines.get(key) ?? [];
			spans.push({
				high: horizontal ? Math.max(from.x, to.x) : Math.max(from.y, to.y),
				index: index - 1,
				low: horizontal ? Math.min(from.x, to.x) : Math.min(from.y, to.y),
				order: horizontal ? trip.destination.y : trip.destination.x,
				tripId: trip.id,
			});
			lines.set(key, spans);
		}
	}
	for (const spans of lines.values()) {
		assignLanes(spans, lanes);
	}
	return lanes;
}

function isHorizontal(route: readonly Point[], segment: number): boolean {
	return route[segment]?.y === route[segment + 1]?.y;
}

/**
 * `route` moved into its lanes: each segment shifted sideways by its lane
 * times `unit` world units, with corners where the shifted segments meet.
 */
export function laneRoute(
	route: readonly Point[],
	offsets: readonly number[] | undefined,
	unit: number
): Point[] {
	if (!offsets || route.length < 2) {
		return [...route];
	}
	return route.map((point, index) => {
		let x = point.x;
		let y = point.y;
		for (const segment of [index - 1, index]) {
			if (segment < 0 || segment >= route.length - 1) {
				continue;
			}
			const shift = (offsets[segment] ?? 0) * unit;
			if (isHorizontal(route, segment)) {
				y = point.y + shift;
			} else {
				x = point.x + shift;
			}
		}
		return { x, y };
	});
}

/** The segment of `route` that `progress` (0..1) falls on. */
export function segmentAt(route: readonly Point[], progress: number): number {
	const total = routeLength(route);
	let remaining = Math.min(1, Math.max(0, progress)) * total;
	for (let index = 1; index < route.length; index += 1) {
		const from = route[index - 1];
		const to = route[index];
		if (!(from && to)) {
			continue;
		}
		const length = Math.hypot(to.x - from.x, to.y - from.y);
		if (remaining <= length && length > 0) {
			return index - 1;
		}
		remaining -= length;
	}
	return Math.max(0, route.length - 2);
}

/**
 * The sideways shift, in lanes, of a car on `trip` at `progress`: the lane
 * of the segment it is on, as an x/y pair.
 */
export function laneShift(
	trip: RideTrip,
	offsets: readonly number[] | undefined,
	progress: number
): Point {
	if (!offsets) {
		return { x: 0, y: 0 };
	}
	const segment = segmentAt(trip.route, progress);
	const lane = offsets[segment] ?? 0;
	return isHorizontal(trip.route, segment)
		? { x: 0, y: lane }
		: { x: lane, y: 0 };
}

/** Where along its route a car is, for lane purposes. */
export function carProgress(car: RideCar, trip: RideTrip): number {
	if (car.state === "arrived") {
		return 1;
	}
	if (car.state === "queued") {
		return setOffShare(trip.route);
	}
	return trip.progress;
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

export type SheetTab = "arrived" | "now" | "trips";

export const SHEET_TABS: readonly { id: SheetTab; label: string }[] = [
	{ id: "now", label: "Now" },
	{ id: "arrived", label: "Arrived" },
	{ id: "trips", label: "Trips" },
];

const STATUS_RANK = new Map(
	THREAD_STATUS_ORDER.map((status, index) => [status, index])
);

/**
 * Trips under way (en route, then requested), followed by cancelled trips,
 * which the sheet sets apart under "Needs attention".
 */
export function nowTrips(trips: readonly RideTrip[]): RideTrip[] {
	return trips
		.filter(
			(trip) =>
				trip.stage === "enroute" ||
				trip.stage === "requested" ||
				trip.stage === "cancelled"
		)
		.sort(
			(a, b) =>
				Number(a.stage === "cancelled") - Number(b.stage === "cancelled") ||
				(STATUS_RANK.get(a.status) ?? 0) - (STATUS_RANK.get(b.status) ?? 0) ||
				byRecency(a.thread, b.thread)
		);
}

/**
 * Trips whose driver replied in the last {@link PARKED_FOR}: the car is
 * waiting at the pin and it is your turn. Newest first.
 */
export function arrivedTrips(trips: readonly RideTrip[]): RideTrip[] {
	return trips
		.filter((trip) => trip.stage === "arrived")
		.sort((a, b) => byRecency(a.thread, b.thread));
}

export interface TripDay {
	key: string;
	label: string;
	trips: RideTrip[];
}

export function dayLabel(dayKey: string, now: Date): string {
	const today = localDayKey(now);
	const yesterday = localDayKey(
		new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
	);
	if (dayKey === today) {
		return "Today";
	}
	if (dayKey === yesterday) {
		return "Yesterday";
	}
	const [year, month, day] = dayKey.split("-").map(Number);
	const date = new Date(year ?? 0, (month ?? 1) - 1, day ?? 1);
	return date.toLocaleDateString("en-US", {
		day: "numeric",
		month: "short",
		weekday: "short",
		...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
	});
}

/**
 * Every trip, grouped by local day, newest day and trip first. With the act
 * layer (`undated`) `updatedAt` is no day a trip happened on: one group,
 * still newest first.
 */
export function tripHistory(
	trips: readonly RideTrip[],
	now: Date = new Date(),
	undated = false
): TripDay[] {
	const days = new Map<string, RideTrip[]>();
	const sorted = [...trips].sort((a, b) => byRecency(a.thread, b.thread));
	if (undated) {
		return sorted.length > 0
			? [{ key: "earlier", label: "Earlier", trips: sorted }]
			: [];
	}
	for (const trip of sorted) {
		const date = new Date(trip.thread.updatedAt);
		if (Number.isNaN(date.getTime())) {
			continue;
		}
		const key = localDayKey(date);
		const list = days.get(key) ?? [];
		list.push(trip);
		days.set(key, list);
	}
	return [...days.entries()].map(([key, list]) => ({
		key,
		label: dayLabel(key, now),
		trips: list,
	}));
}

export function clockTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) {
		return "";
	}
	return date.toLocaleTimeString("en-US", {
		hour: "numeric",
		minute: "2-digit",
	});
}

export interface DriverOption {
	agent: InterfaceAgent;
	available: boolean;
	/** Minutes until free (0 when available now). */
	waitMinutes: number;
}

/** Drivers for the booking list: available first, then soonest free. */
export function driverOptions(
	snapshot: InterfaceSnapshot,
	trips: readonly RideTrip[]
): DriverOption[] {
	return snapshot.agents
		.map((agent) => {
			const busy = trips.filter(
				(trip) => trip.stage === "enroute" && trip.driver?.id === agent.id
			);
			const available = agent.status === "idle" && busy.length === 0;
			const waitMinutes = available
				? 0
				: Math.max(
						1,
						...busy.map((trip) => trip.etaMinutes ?? trip.typical),
						busy.length === 0 ? typicalMinutes(agent.id, snapshot.events) : 1
					);
			return { agent, available, waitMinutes };
		})
		.sort(
			(a, b) =>
				Number(b.available) - Number(a.available) ||
				a.waitMinutes - b.waitMinutes ||
				a.agent.name.localeCompare(b.agent.name)
		);
}

export function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------

/** Points the overview frames: you, every car, and every pin on the map. */
export function overviewPoints(rides: RideCity): Point[] {
	const points: Point[] = [PICKUP];
	for (const car of rides.cars) {
		points.push(carPose(car, rides.trips));
	}
	for (const trip of mapTrips(rides)) {
		points.push(trip.destination);
	}
	return points;
}

/** Points that frame one trip: its whole route. */
export function tripPoints(trip: RideTrip): Point[] {
	return [...trip.route];
}

/**
 * Trips whose route and pin are drawn: anything under way, plus arrivals
 * whose car is still parked at the pin. Older arrivals live in the history.
 */
export function mapTrips(rides: RideCity): RideTrip[] {
	return rides.trips.filter((trip) => ON_MAP.has(trip.stage));
}

/**
 * The history: completed trips (replied more than {@link PARKED_FOR} ago),
 * conversations never started, and ones without a driver. Nothing here is
 * also in Now or Arrived.
 */
export function finishedTrips(trips: readonly RideTrip[]): RideTrip[] {
	return trips.filter(
		(trip) =>
			trip.stage === "completed" ||
			trip.stage === "unstarted" ||
			trip.stage === "unassigned"
	);
}

/**
 * The part of a trip's route the map draws: all of it when selected;
 * otherwise what is still ahead of a car en route, only the last leg of a
 * cancelled trip, and nothing for a finished ride.
 */
export function drawnRoute(trip: RideTrip, selected: boolean): Point[] {
	if (selected) {
		return [...trip.route];
	}
	if (trip.stage === "arrived") {
		return [];
	}
	if (trip.stage === "cancelled") {
		return trip.route.slice(-2);
	}
	if (trip.stage === "enroute" && !trip.carless) {
		return routeAhead(trip.route, trip.progress);
	}
	return [...trip.route];
}

/** The part of a route still ahead of `progress`, starting at the car. */
export function routeAhead(route: readonly Point[], progress: number): Point[] {
	const total = routeLength(route);
	const car = pointAlong(route, progress);
	const ahead: Point[] = [{ x: car.x, y: car.y }];
	let travelled = 0;
	const reached = Math.min(1, Math.max(0, progress)) * total;
	for (let index = 1; index < route.length; index += 1) {
		const from = route[index - 1];
		const to = route[index];
		if (!(from && to)) {
			continue;
		}
		travelled += Math.hypot(to.x - from.x, to.y - from.y);
		if (travelled > reached) {
			ahead.push(to);
		}
	}
	return ahead.length === 1 ? [car, car] : ahead;
}

/** How a driver's availability reads in the booking list: one short phrase. */
export function availabilityText(option: DriverOption): string {
	return option.available
		? "Available now"
		: `About ${option.waitMinutes} min wait`;
}

/**
 * A trip's one status word, wherever it is shown: its row, the list, its
 * pin and the open trip. The act's word when there is one (a carless car
 * en route is "Up next"); a trip without a driver always reads so.
 */
export function tripWord(
	trip: RideTrip,
	acted?: { stage: TripStage; word: string }
): string {
	if (acted && trip.stage !== "unassigned") {
		return acted.stage === "enroute" && trip.carless ? "Up next" : acted.word;
	}
	switch (trip.stage) {
		case "arrived":
			return "Your turn";
		case "cancelled":
			return trip.thread.runState === "interrupted"
				? "Run interrupted"
				: "Run failed";
		case "enroute":
			return trip.carless ? "Up next" : STAGE_LABELS.enroute;
		default:
			return STAGE_LABELS[trip.stage];
	}
}

/**
 * The open trip's status and the one line under it. The destination (the
 * conversation's title) is the heading and the ETA the large figure, so
 * neither is repeated here.
 */
export function tripHeadline(trip: RideTrip): {
	detail: string;
	status: string;
} {
	const driver = trip.driver?.name ?? "No driver";
	switch (trip.stage) {
		case "enroute":
			return trip.carless
				? {
						detail: `${driver} starts this after the current trip`,
						status: tripWord(trip),
					}
				: {
						detail: `Estimated from ${driver}'s usual reply time`,
						status: tripWord(trip),
					};
		case "arrived":
			return {
				detail: `${driver} replied.`,
				status: tripWord(trip),
			};
		case "completed":
			return {
				detail: `${driver} replied. It's still your turn.`,
				status: tripWord(trip),
			};
		case "unassigned":
			return {
				detail: "Add an agent to this conversation to start it",
				status: tripWord(trip),
			};
		case "requested":
			return {
				detail: `Waiting for ${driver} to pick it up`,
				status: tripWord(trip),
			};
		case "cancelled":
			return {
				detail:
					trip.thread.runState === "interrupted"
						? "The run was interrupted. Send a message to try again."
						: "The run failed. Send a message to try again.",
				status: tripWord(trip),
			};
		default:
			return { detail: "Nothing has been sent yet", status: tripWord(trip) };
	}
}

/**
 * The words on a pin's status chip, shared by the marker and the layout so
 * they agree on its width: the lead (bold) and an optional muted tail.
 * A parked car's chip carries the driver's name, since the car has no
 * separate name chip.
 */
export function chipText(
	trip: RideTrip,
	/** The act layer: an ETA only for a routine's run (its estimate). */
	acted = false
): {
	lead: string;
	tail: string | null;
} {
	if (trip.stage === "enroute") {
		if (trip.carless) {
			return { lead: "Up next", tail: null };
		}
		// With acts a map pin never shows the typical-length guess.
		return acted
			? { lead: STAGE_LABELS.enroute, tail: null }
			: { lead: etaLabel(trip.etaMinutes ?? 0), tail: "est." };
	}
	if (trip.stage === "arrived" && !trip.carless && trip.driver) {
		return { lead: trip.driver.name, tail: tripWord(trip) };
	}
	return { lead: tripWord(trip), tail: null };
}

/** "3 min" for a trip en route with a car on it; null for anything else. */
export function tripEta(
	trip: RideTrip,
	/**
	 * The act layer: only a routine's run has an estimate to show (the
	 * median of its own past runs); a chat's typical length is not an ETA.
	 */
	acted = false
): string | null {
	if (trip.stage !== "enroute" || trip.carless) {
		return null;
	}
	if (acted && !trip.thread.routineRun) {
		return null;
	}
	return etaLabel(trip.etaMinutes ?? 0);
}
