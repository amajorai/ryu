/**
 * Arrow-key focus order for the 3D stage's plates (`IsoStage`): pure, so it
 * is testable without a DOM.
 *
 * Plates move in reading order, never "nearest in that direction":
 * - plates that carry a game order (`data-iso-order`: advent doors 1 to 24,
 *   path stops, quiz cells) step through that order, Right/Down to the next
 *   and Left/Up to the previous;
 * - every other plate reads like a page: rows top to bottom by screen
 *   position (plates within `ROW_TOLERANCE` px of a row's first plate share
 *   it), left to right within a row. Left/Right step through that sequence;
 *   Up/Down move to the row above or below, to its plate nearest across.
 */

/** A plate's centre on screen (px) and its game order, if it has one. */
export interface FocusPlate {
	order?: number;
	x: number;
	y: number;
}

export type FocusKey = "ArrowDown" | "ArrowLeft" | "ArrowRight" | "ArrowUp";

/** Plates whose centres sit this close vertically read as one row (px). */
export const ROW_TOLERANCE = 18;

/** Rows of plate indices, top to bottom, each sorted left to right. */
export function readingRows(
	plates: readonly FocusPlate[],
	tolerance = ROW_TOLERANCE
): number[][] {
	const byY = plates
		.map((_, index) => index)
		.sort((a, b) => (plates[a]?.y ?? 0) - (plates[b]?.y ?? 0));
	const rows: number[][] = [];
	let row: number[] = [];
	let rowTop = Number.NEGATIVE_INFINITY;
	for (const index of byY) {
		const y = plates[index]?.y ?? 0;
		if (row.length > 0 && y - rowTop > tolerance) {
			rows.push(row);
			row = [];
		}
		if (row.length === 0) {
			rowTop = y;
		}
		row.push(index);
	}
	if (row.length > 0) {
		rows.push(row);
	}
	for (const each of rows) {
		each.sort((a, b) => (plates[a]?.x ?? 0) - (plates[b]?.x ?? 0));
	}
	return rows;
}

/** Every plate index in reading order. */
export function readingOrder(
	plates: readonly FocusPlate[],
	tolerance = ROW_TOLERANCE
): number[] {
	return readingRows(plates, tolerance).flat();
}

function stepOrdered(
	plates: readonly FocusPlate[],
	current: number,
	forward: boolean
): number {
	const ordered = plates
		.map((plate, index) => ({ index, order: plate.order }))
		.filter(
			(entry): entry is { index: number; order: number } =>
				entry.order !== undefined
		)
		.sort((a, b) => a.order - b.order || a.index - b.index);
	const at = ordered.findIndex((entry) => entry.index === current);
	const next = ordered[at + (forward ? 1 : -1)];
	return next ? next.index : current;
}

function stepRows(
	plates: readonly FocusPlate[],
	current: number,
	key: FocusKey,
	tolerance: number
): number {
	const rows = readingRows(plates, tolerance);
	if (key === "ArrowLeft" || key === "ArrowRight") {
		const sequence = rows.flat();
		const at = sequence.indexOf(current);
		return sequence[at + (key === "ArrowRight" ? 1 : -1)] ?? current;
	}
	const rowAt = rows.findIndex((row) => row.includes(current));
	const row = rows[rowAt + (key === "ArrowDown" ? 1 : -1)];
	if (!row) {
		return current;
	}
	const x = plates[current]?.x ?? 0;
	let best = row[0] ?? current;
	let bestGap = Number.POSITIVE_INFINITY;
	for (const index of row) {
		const gap = Math.abs((plates[index]?.x ?? 0) - x);
		if (gap < bestGap) {
			bestGap = gap;
			best = index;
		}
	}
	return best;
}

/**
 * The plate an arrow key moves focus to from `current` (an index into
 * `plates`, or -1 when no plate has focus: then the first in order). Returns
 * `current` at either end, so focus never wraps or jumps.
 */
export function nextFocus(
	plates: readonly FocusPlate[],
	current: number,
	key: FocusKey,
	tolerance = ROW_TOLERANCE
): number {
	if (plates.length === 0) {
		return -1;
	}
	if (current < 0 || current >= plates.length) {
		if (plates.some((plate) => plate.order !== undefined)) {
			return firstOrdered(plates);
		}
		return readingOrder(plates, tolerance)[0] ?? 0;
	}
	if (plates[current]?.order !== undefined) {
		return stepOrdered(
			plates,
			current,
			key === "ArrowRight" || key === "ArrowDown"
		);
	}
	return stepRows(plates, current, key, tolerance);
}

function firstOrdered(plates: readonly FocusPlate[]): number {
	let best = 0;
	let bestOrder = Number.POSITIVE_INFINITY;
	for (const [index, plate] of plates.entries()) {
		if (plate.order !== undefined && plate.order < bestOrder) {
			bestOrder = plate.order;
			best = index;
		}
	}
	return best;
}
