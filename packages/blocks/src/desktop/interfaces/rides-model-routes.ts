import {
	AVENUE_COLUMNS,
	COLUMNS,
	cellPoint,
	hashString,
	PARK,
	PICKUP,
	PICKUP_CELL,
	type Point,
	RIVER_ROWS,
	ROWS,
} from "./rides-model-city.ts";

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
export function claimCell(
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
