import {
	cylinder,
	depthOf,
	type Flat,
	fitProjection,
	iso,
	type Plane,
	type Point3,
	type SolidPaths,
	towardViewer,
} from "../../kit/iso-kit.ts";
import {
	APPROVAL,
	CONDITION,
	INPUT,
	NODE_COUNT,
	OUTPUT,
	PROMPT,
	TOOL,
	WEBHOOK,
} from "./model.ts";

/*
 * The whole drawing: seven low discs, one per node, joined by hairline edges, a marble
 * (the run) and a checkpoint pin per disc. World units are about a pixel; x runs along
 * the run, y across it (the two branches), z is up.
 */

export const WIDTH = 600;
const AZIMUTH = 60;
const PAD = 40;

const PITCH = 46;
const LANE = 21;

export const DISC_R = 8.5;
export const DISC_H = 2.4;
export const MARBLE_R = 3.6;
const PIN_R = 0.55;
const PIN_RISE = 11;
const HEAD_R = 1.25;

const PLACES: Record<number, Plane> = {
	[INPUT]: [-PITCH * 2.5, 0],
	[PROMPT]: [-PITCH * 1.5, 0],
	[CONDITION]: [-PITCH * 0.5, 0],
	[TOOL]: [PITCH * 0.5, LANE],
	[WEBHOOK]: [PITCH * 0.5, -LANE],
	[APPROVAL]: [PITCH * 1.5, 0],
	[OUTPUT]: [PITCH * 2.5, 0],
};

export const placeOf = (node: number): Plane => PLACES[node] ?? [0, 0];

/** The edges of the graph: [from, to]. */
export const EDGES: readonly (readonly [number, number])[] = [
	[INPUT, PROMPT],
	[PROMPT, CONDITION],
	[CONDITION, TOOL],
	[CONDITION, WEBHOOK],
	[TOOL, APPROVAL],
	[WEBHOOK, APPROVAL],
	[APPROVAL, OUTPUT],
];

const EXTENT: Point3[] = Object.values(PLACES).flatMap(([x, y]): Point3[] => [
	[x - DISC_R, y - DISC_R, 0],
	[x + DISC_R, y + DISC_R, 0],
	[x, y, DISC_H + PIN_RISE + HEAD_R * 2],
]);

/** The viewBox is as tall as the drawing needs at this width. */
export const HEIGHT = (() => {
	const unit = { origin: [0, 0] as Flat, scale: 1, azimuth: AZIMUTH };
	const flat = EXTENT.map((point) => iso(point, unit));
	const xs = flat.map(([x]) => x);
	const ys = flat.map(([, y]) => y);
	const scale = (WIDTH - PAD * 2) / (Math.max(...xs) - Math.min(...xs));
	return Math.ceil((Math.max(...ys) - Math.min(...ys)) * scale + PAD * 2);
})();

const P = fitProjection(EXTENT, WIDTH, HEIGHT, { pad: PAD, azimuth: AZIMUTH });

const at = (point: Point3) => iso(point, P);
const round = (value: number) => Math.round(value * 10) / 10;

/** Screen px per world unit (the kit's projection is isotropic). */
const SCREEN_K = Math.hypot(
	at([1, 0, 0])[0] - at([0, 0, 0])[0],
	at([1, 0, 0])[1] - at([0, 0, 0])[1]
);

export const depthAt = (point: Point3) => depthOf(point, P);

/* ---------------------------------------------------------- static parts --- */

export const DISCS: readonly SolidPaths[] = Array.from(
	{ length: NODE_COUNT },
	(_, node) => {
		const [x, y] = placeOf(node);
		return cylinder(x, y, DISC_R, 0, DISC_H, P, 48, 0.4);
	}
);

/** An edge, rim to rim, on the discs' top plane: the track the marble rolls along. */
export function edgePath(from: number, to: number) {
	const [ax, ay] = placeOf(from);
	const [bx, by] = placeOf(to);
	const length = Math.hypot(bx - ax, by - ay) || 1;
	const dx = (bx - ax) / length;
	const dy = (by - ay) / length;
	const a = at([ax + dx * DISC_R, ay + dy * DISC_R, DISC_H]);
	const b = at([bx - dx * DISC_R, by - dy * DISC_R, DISC_H]);
	return `M${round(a[0])} ${round(a[1])}L${round(b[0])} ${round(b[1])}`;
}

/* ---------------------------------------------------------- moving parts --- */

/** Where the marble rests on a disc. */
export const seatOf = (node: number): Point3 => {
	const [x, y] = placeOf(node);
	return [x, y, DISC_H + MARBLE_R];
};

/** A disc's seat on screen, for mapping the pointer to the nearest node. */
export const seatScreen = (node: number) => at(seatOf(node));

/** The marble's screen centre and radius. */
export function marbleAt(centre: Point3) {
	const [cx, cy] = at(centre);
	return { cx: round(cx), cy: round(cy), r: round(MARBLE_R * SCREEN_K) };
}

/** The checkpoint pin stands at the back of its disc, behind the marble. */
const BACK: Plane = (() => {
	const [tx, ty] = towardViewer(P);
	const length = Math.hypot(tx, ty) || 1;
	return [(-tx / length) * 5, (-ty / length) * 5];
})();

export interface PinPaths {
	head: SolidPaths;
	stem: SolidPaths;
}

/** A pin raised to `share` of its travel; null when it is down in its disc. */
export function pinPaths(node: number, share: number): PinPaths | null {
	const height = share * PIN_RISE;
	if (height < 0.2) {
		return null;
	}
	const [x, y] = placeOf(node);
	const px = x + BACK[0];
	const py = y + BACK[1];
	return {
		stem: cylinder(px, py, PIN_R, DISC_H, height, P, 12),
		head: cylinder(px, py, HEAD_R, DISC_H + height, HEAD_R * 1.4, P, 20, 0.3),
	};
}
