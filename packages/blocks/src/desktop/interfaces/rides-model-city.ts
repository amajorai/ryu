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
export const RIVER_ROWS = new Set([8, 9]);
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
