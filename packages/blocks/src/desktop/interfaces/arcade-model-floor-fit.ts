/** A machine's footprint at full size: cabinet plus lever, and the aisle between. */
export const SLOT_FOOTPRINT = 228;
export const SLOT_AISLE = 24;
/** A machine's height at full size, topper slot to plinth. */
export const SLOT_HEIGHT = 356;
export const ROW_GAP = 40;
/** The smallest zoom a machine is drawn at (a short floor shrinks them). */
export const MIN_FLOOR_ZOOM = 0.8;
export const MAX_FLOOR_ZOOM = 1.5;
/**
 * At most this many machines stand in view at once; the rest line the
 * aisle, which scrolls sideways. Fewer, bigger machines read as a casino
 * floor, with legible reels and meters, instead of a wall of thumbnails.
 */
export const AISLE_VIEW = 4;
/** Machines in view are at least this big when the floor allows. */
const COMFORT_ZOOM = 1.15;

export interface FloorFit {
	/** Every machine stands in one row along the aisle. */
	columns: number;
	/** More machines than fit in view: the aisle scrolls sideways. */
	overflow: boolean;
	rows: number;
	/** How many machines are in view at once. */
	view: number;
	zoom: number;
}

/** The bank's width in unzoomed pixels for `columns` machines. */
export function bankWidth(columns: number): number {
	return columns * (SLOT_FOOTPRINT + SLOT_AISLE) - SLOT_AISLE;
}

/** The bank's height in unzoomed pixels for `rows` rows. */
export function bankHeight(rows: number): number {
	return rows * (SLOT_HEIGHT + ROW_GAP) - ROW_GAP;
}

function roundDown(value: number): number {
	return Math.floor(value * 100) / 100;
}

/**
 * How the machines fill a floor `width` x `height` pixels: one row along
 * the aisle with up to AISLE_VIEW machines in view, as large as the floor
 * allows (up to MAX_FLOOR_ZOOM). Fewer machines stand in view when the
 * width would shrink them below a comfortable size; a phone shows one at a
 * time.
 */
export function floorFit(
	count: number,
	width: number,
	height: number = Number.POSITIVE_INFINITY
): FloorFit {
	if (count <= 0 || width <= 0 || !Number.isFinite(width)) {
		const columns = Math.max(1, count);
		return { columns, overflow: false, rows: 1, view: columns, zoom: 1 };
	}
	// As many as stand in view at a comfortable size, up to AISLE_VIEW.
	const comfortable = Math.floor(
		(width / COMFORT_ZOOM + SLOT_AISLE) / (SLOT_FOOTPRINT + SLOT_AISLE)
	);
	const view = Math.max(1, Math.min(count, AISLE_VIEW, comfortable));
	const byWidth = width / bankWidth(view);
	const byHeight =
		height > 0 ? height / bankHeight(1) : Number.POSITIVE_INFINITY;
	return {
		columns: count,
		overflow: count > view,
		rows: 1,
		view,
		// A very short floor keeps the machines legible and scrolls instead.
		zoom: roundDown(
			Math.max(
				Math.min(MIN_FLOOR_ZOOM, byWidth),
				Math.min(byWidth, byHeight, MAX_FLOOR_ZOOM)
			)
		),
	};
}

/** Marquee lettering size that keeps `name` inside `room` pixels of the sign. */
export function marqueeFontSize(
	name: string,
	room: number,
	largest: number,
	smallest: number
): number {
	// Uppercase heading glyphs with 0.08em tracking run about 0.78em wide.
	const fit = room / (Math.max(1, name.trim().length) * 0.78);
	return Math.max(smallest, Math.min(largest, Math.floor(fit)));
}
