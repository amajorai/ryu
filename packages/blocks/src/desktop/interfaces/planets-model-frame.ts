import {
	type Box,
	EMPTY_HUD,
	FIT_SAMPLES,
	HUD_GAP,
	type HudLayout,
	type Insets,
	OVERVIEW_ELEVATION,
	PLATE_PAD,
	sidePad,
} from "./planets-model-hud.ts";

const PORTRAIT_ELEVATION = 1.18;

/**
 * How steeply the overview looks down: an angled view on a wide screen, and
 * closer to top-down on a tall, narrow one, so the system fills the height
 * instead of becoming a thin ellipse.
 */
export function overviewElevation(width: number, height: number): number {
	const aspect = width / Math.max(1, height);
	const t = Math.min(1, Math.max(0, (1.1 - aspect) / 0.6));
	return OVERVIEW_ELEVATION + (PORTRAIT_ELEVATION - OVERVIEW_ELEVATION) * t;
}

/**
 * The regions of the scene the HUD leaves free: beside the system card (when
 * it shows its list) or below it (when it is folded), always between the
 * controls on top and the legend at the bottom. Framing tries each and keeps
 * whichever shows the picture largest.
 */
export function freeRegions(
	layout: HudLayout,
	viewport: { height: number; width: number }
): Insets[] {
	const { card, controls, legend } = layout;
	const top = controls ? controls.bottom + HUD_GAP : HUD_GAP;
	const bottom = legend
		? Math.max(HUD_GAP, viewport.height - legend.top + HUD_GAP)
		: HUD_GAP;
	const beside: Insets = {
		bottom,
		left: card ? card.right + HUD_GAP : HUD_GAP,
		right: HUD_GAP,
		top,
	};
	if (!card) {
		return [beside];
	}
	const below: Insets = {
		bottom,
		left: HUD_GAP,
		right: HUD_GAP,
		top: Math.max(top, card.bottom + HUD_GAP),
	};
	return [beside, below];
}

/** Projected extent of a ring on the orbital plane, in normalized units. */
interface RingExtent {
	maxX: number;
	maxY: number;
	minY: number;
}

/**
 * Where a ring of `radius` on the orbital plane lands in the frame from a
 * camera `distance` away, looking down at `elevation`. Perspective makes the
 * near side of the ring wider and lower, so every sample is projected.
 */
function ringExtent(
	radius: number,
	distance: number,
	half: number,
	aspect: number,
	elevation: number
): RingExtent | null {
	const cosE = Math.cos(elevation);
	const sinE = Math.sin(elevation);
	// Camera at (0, sinE, cosE) * distance looking at the origin; forward is
	// (0, -sinE, -cosE), up is (0, cosE, -sinE), right is +x.
	const camY = sinE * distance;
	const camZ = cosE * distance;
	const extent: RingExtent = { maxX: 0, maxY: -1, minY: 1 };
	for (let index = 0; index < FIT_SAMPLES; index += 1) {
		const angle = (index / FIT_SAMPLES) * Math.PI * 2;
		const x = Math.cos(angle) * radius;
		const dz = Math.sin(angle) * radius - camZ;
		const depth = camY * sinE - dz * cosE;
		if (depth <= 0.1) {
			return null;
		}
		const up = -camY * cosE - dz * sinE;
		extent.maxX = Math.max(extent.maxX, Math.abs(x / (depth * half * aspect)));
		const y = up / (depth * half);
		extent.maxY = Math.max(extent.maxY, y);
		extent.minY = Math.min(extent.minY, y);
	}
	return extent;
}

export interface OverviewFrame {
	distance: number;
	/** The free region the picture was fitted into. */
	region: Insets;
	/** Pixels to slide the picture right (clear of the HUD) and down. */
	shiftX: number;
	shiftY: number;
}

const FULL_REGION: Insets = {
	bottom: HUD_GAP,
	left: HUD_GAP,
	right: HUD_GAP,
	top: HUD_GAP,
};

/** Usable size of a region once the plates' padding is taken off. */
function regionSize(
	region: Insets,
	viewport: { height: number; width: number },
	padded: boolean
): { height: number; width: number } {
	const side = padded ? sidePad(viewport.width) * 2 : 0;
	const vertical = padded ? PLATE_PAD.top + PLATE_PAD.bottom : 0;
	return {
		height: viewport.height - region.top - region.bottom - vertical,
		width: viewport.width - region.left - region.right - side,
	};
}

/** The candidate regions worth trying, with the whole view as a last resort. */
function usableRegions(
	layout: HudLayout,
	viewport: { height: number; width: number },
	padded: boolean
): Insets[] {
	const regions = freeRegions(layout, viewport).filter((region) => {
		const size = regionSize(region, viewport, padded);
		return size.width >= 120 && size.height >= 120;
	});
	return regions.length > 0 ? regions : [FULL_REGION];
}

/** Fits a ring of `radius` around the target into one free region. */
function fitRing(
	radius: number,
	viewport: { height: number; width: number },
	half: number,
	elevation: number,
	region: Insets
): OverviewFrame {
	const { height, width } = viewport;
	const aspect = width / height;
	const room = regionSize(region, viewport, true);
	const roomWidth = Math.max(40, room.width);
	const roomHeight = Math.max(40, room.height);
	const fits = (distance: number) => {
		const extent = ringExtent(radius, distance, half, aspect, elevation);
		return (
			extent !== null &&
			extent.maxX * width <= roomWidth &&
			((extent.maxY - extent.minY) * height) / 2 <= roomHeight
		);
	};
	let low = radius * 0.3;
	let high = radius * 60;
	for (let step = 0; step < 40; step += 1) {
		const middle = (low + high) / 2;
		if (fits(middle)) {
			high = middle;
		} else {
			low = middle;
		}
	}
	const extent = ringExtent(radius, high, half, aspect, elevation);
	const centre = extent ? (extent.maxY + extent.minY) / 2 : 0;
	const top = region.top + PLATE_PAD.top;
	const bottom = region.bottom + PLATE_PAD.bottom;
	return {
		distance: high,
		region,
		shiftX: (region.left - region.right) / 2,
		shiftY: centre * (height / 2) + (top - bottom) / 2,
	};
}

/**
 * The framing that keeps the system inside one free region (beside or below
 * the card), as a starting point and fallback for the closer fit.
 */
function regionFrame(
	radius: number,
	size: { height: number; width: number },
	half: number,
	elevation: number,
	layout: HudLayout
): OverviewFrame {
	let best: OverviewFrame | null = null;
	for (const region of usableRegions(layout, size, true)) {
		const frame = fitRing(radius, size, half, elevation, region);
		if (!best || frame.distance < best.distance) {
			best = frame;
		}
	}
	return best ?? fitRing(radius, size, half, elevation, FULL_REGION);
}

/** Fractions of the reach sampled for the closer fit (outer orbit inwards). */
const SHAPE_RINGS = [1, 0.78, 0.55, 0.3] as const;
const SHAPE_SAMPLES = 48;
/** Finest grid step (px) when searching for a shift that clears the HUD. */
const SHIFT_STEP = 8;
/** At most this many grid steps per axis, so the search stays cheap. */
const SHIFT_CELLS = 28;
const SHAPE_STEPS = 18;

/**
 * Screen boxes (px, before any shift) around sampled points of the system's
 * rings, padded for the name plates; null when the camera is inside it.
 */
function shapeBoxes(
	radius: number,
	distance: number,
	viewport: { height: number; width: number },
	half: number,
	elevation: number
): Box[] | null {
	const { height, width } = viewport;
	const cosE = Math.cos(elevation);
	const sinE = Math.sin(elevation);
	const camY = sinE * distance;
	const camZ = cosE * distance;
	const side = sidePad(width);
	const boxes: Box[] = [];
	const push = (x: number, z: number) => {
		const dz = z - camZ;
		const depth = camY * sinE - dz * cosE;
		if (depth <= 0.1) {
			return false;
		}
		const up = -camY * cosE - dz * sinE;
		const px = width / 2 + (x / (depth * half)) * (height / 2);
		const py = height / 2 - (up / (depth * half)) * (height / 2);
		boxes.push({
			bottom: py + PLATE_PAD.bottom,
			left: px - side,
			right: px + side,
			top: py - PLATE_PAD.top,
		});
		return true;
	};
	if (!push(0, 0)) {
		return null;
	}
	for (const fraction of SHAPE_RINGS) {
		for (let index = 0; index < SHAPE_SAMPLES; index += 1) {
			const angle = (index / SHAPE_SAMPLES) * Math.PI * 2;
			const ring = radius * fraction;
			if (!push(Math.cos(angle) * ring, Math.sin(angle) * ring)) {
				return null;
			}
		}
	}
	return boxes;
}

function boxesTouch(a: Box, b: Box, dx: number, dy: number): boolean {
	return (
		a.left + dx < b.right &&
		a.right + dx > b.left &&
		a.top + dy < b.bottom &&
		a.bottom + dy > b.top
	);
}

/**
 * A shift (px) that keeps every sampled box on screen and clear of the HUD,
 * as close to `preferred` as the search grid allows; null when none does.
 */
function clearShift(
	boxes: readonly Box[],
	viewport: { height: number; width: number },
	obstacles: readonly Box[],
	preferred: { x: number; y: number }
): { x: number; y: number } | null {
	let minX = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const box of boxes) {
		minX = Math.min(minX, box.left);
		maxX = Math.max(maxX, box.right);
		minY = Math.min(minY, box.top);
		maxY = Math.max(maxY, box.bottom);
	}
	const range = {
		x0: HUD_GAP - minX,
		x1: viewport.width - HUD_GAP - maxX,
		y0: HUD_GAP - minY,
		y1: viewport.height - HUD_GAP - maxY,
	};
	if (range.x0 > range.x1 || range.y0 > range.y1) {
		return null;
	}
	const clamp = (value: number, low: number, high: number) =>
		Math.min(high, Math.max(low, value));
	const steps = (low: number, high: number, wanted: number) => {
		const values = [clamp(wanted, low, high), high];
		const step = Math.max(SHIFT_STEP, (high - low) / SHIFT_CELLS);
		for (let value = low; value < high; value += step) {
			values.push(value);
		}
		return values;
	};
	const xs = steps(range.x0, range.x1, preferred.x);
	const ys = steps(range.y0, range.y1, preferred.y);
	const candidates: { x: number; y: number }[] = [];
	for (const x of xs) {
		for (const y of ys) {
			candidates.push({ x, y });
		}
	}
	const away = (point: { x: number; y: number }) =>
		Math.hypot(point.x - preferred.x, point.y - preferred.y);
	candidates.sort((a, b) => away(a) - away(b));
	for (const shift of candidates) {
		const clear = boxes.every((box) =>
			obstacles.every(
				(obstacle) => !boxesTouch(box, obstacle, shift.x, shift.y)
			)
		);
		if (clear) {
			return shift;
		}
	}
	return null;
}

/**
 * The overview framing: the camera distance that fits a ring of `radius`
 * (the outermost orbit and its planet, or just the inner system), and the
 * shift that places it on screen. The system is an ellipse, so it may tuck
 * its empty corners beside the HUD's cards: every sampled orbit point (with
 * room for its name plate) stays on screen and clear of the HUD, and the
 * camera comes as close as that allows. Perspective otherwise leaves the
 * near side of the system low in frame.
 */
export function overviewFrame(
	radius: number,
	viewport: { height: number; width: number },
	fov: number,
	elevation: number,
	layout: HudLayout = EMPTY_HUD
): OverviewFrame {
	const size = {
		height: Math.max(1, viewport.height),
		width: Math.max(1, viewport.width),
	};
	const half = Math.tan((fov * Math.PI) / 360);
	const start = regionFrame(radius, size, half, elevation, layout);
	const obstacles = [layout.card, layout.controls, layout.legend]
		.filter((box): box is Box => box !== null)
		.map((box) => ({
			bottom: box.bottom + HUD_GAP,
			left: box.left - HUD_GAP,
			right: box.right + HUD_GAP,
			top: box.top - HUD_GAP,
		}));
	const preferred = { x: start.shiftX, y: start.shiftY };
	const attempt = (distance: number) => {
		const boxes = shapeBoxes(radius, distance, size, half, elevation);
		return boxes ? clearShift(boxes, size, obstacles, preferred) : null;
	};
	let high = start.distance;
	let fit = attempt(high);
	if (!fit) {
		return start;
	}
	let low = high * 0.5;
	for (let step = 0; step < SHAPE_STEPS; step += 1) {
		const middle = (low + high) / 2;
		const shift = attempt(middle);
		if (shift) {
			high = middle;
			fit = shift;
		} else {
			low = middle;
		}
	}
	return { distance: high, region: start.region, shiftX: fit.x, shiftY: fit.y };
}

export interface FocusFrame {
	distance: number;
	region: Insets;
	shiftX: number;
	shiftY: number;
}

/**
 * How far to stand from a visited body so it and its moons (with room for
 * their labels) fill the free region, and the shift that centres it there.
 */
export function focusFrame(
	extent: number,
	viewport: { height: number; width: number },
	fov: number,
	layout: HudLayout,
	limits: { margin: number; minDistance: number; minExtents: number }
): FocusFrame {
	const size = {
		height: Math.max(1, viewport.height),
		width: Math.max(1, viewport.width),
	};
	const half = Math.tan((fov * Math.PI) / 360);
	const reach = extent * limits.margin;
	let best: FocusFrame | null = null;
	for (const region of usableRegions(layout, size, false)) {
		const room = regionSize(region, size, false);
		const distance = Math.max(
			limits.minDistance,
			extent * limits.minExtents,
			(reach * size.height) / (half * Math.max(40, room.width)),
			(reach * size.height) / (half * Math.max(40, room.height))
		);
		if (!best || distance < best.distance) {
			best = {
				distance,
				region,
				shiftX: (region.left - region.right) / 2,
				shiftY: (region.top - region.bottom) / 2,
			};
		}
	}
	return (
		best ?? {
			distance: limits.minDistance,
			region: FULL_REGION,
			shiftX: 0,
			shiftY: 0,
		}
	);
}
