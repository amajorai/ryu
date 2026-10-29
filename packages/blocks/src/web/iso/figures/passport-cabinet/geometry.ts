import {
	boxCorners,
	type Flat,
	fitProjection,
	iso,
	type Plan,
	type Point3,
	pathOf,
	sideRing,
	slabOf,
	translateAlong,
} from "../../kit/iso-kit.ts";

/**
 * World layout: x runs left to right along the cabinet, y comes toward the viewer, z is
 * up. The cabinet's face looks along +y. Every part here carries the idea: a wall of
 * keys, one key taken to the site by Passport, and only the page reaching the agent.
 */

export const WIDTH = 600;
const AZIMUTH = 60;
const PAD = 40;

/** The vault: one cabinet, four columns of boxes in three rows. */
const CAB: Plan = { x: -70, y: -30, w: 120, d: 18, r: 1.5 };
const CAB_TOP = 84;
const FACE_Y = CAB.y + CAB.d;
const COLS = 4;
const ROWS = 3;
const CELL_W = 26;
const CELL_GAP = 4;
const CELL_H = 22;
const ROW_GAP = 6;
const CELL_X0 = CAB.x + 2;
const CELL_Z0 = 4;
/** The connection the figure follows: middle row, third column. */
const SUBJECT = { col: 2, row: 1 };

const cellX = (col: number) => CELL_X0 + col * (CELL_W + CELL_GAP);
const cellZ = (row: number) => CELL_Z0 + row * (CELL_H + ROW_GAP);

/** A key tag, built at the origin: bottom centre, standing in the x-z plane. */
const KEY_W = 10;
const KEY_T = 1.6;
const KEY_H = 14;
const KEY_PLAN: Plan = { x: -KEY_W / 2, y: 0, w: KEY_W, d: KEY_T, r: 0.6 };
const KEY_HOLE: Point3 = [0, KEY_T, KEY_H - 3.4];

/** Where a key hangs in a box, its back against the cabinet face. */
const hangOf = (col: number, row: number): Point3 => [
	cellX(col) + CELL_W / 2,
	FACE_Y,
	cellZ(row) + (CELL_H - KEY_H) / 2,
];

/** The site Passport fetches from: one thin standing panel. */
const SITE: Plan = { x: 82, y: -16, w: 36, d: 4, r: 1 };
const SITE_TOP = 50;
const SITE_FACE = SITE.y + SITE.d;

/** The agent's tray, after the site along the same line: cabinet, site, tray. */
const TRAY: Plan = { x: SITE.x + SITE.w + 14, y: -14, w: 30, d: 24, r: 1.5 };
const TRAY_TOP = 2;

/** The fetched page, built at the origin: a thin sheet lying flat. */
const SHEET_W = 14;
const SHEET_D = 11;
const SHEET_T = 0.5;
const SHEET_PLAN: Plan = {
	x: -SHEET_W / 2,
	y: -SHEET_D / 2,
	w: SHEET_W,
	d: SHEET_D,
	r: 0.4,
};

/** The key's way: home in its box, out, across to the site, docked at its face. */
export const KEY_HOME = hangOf(SUBJECT.col, SUBJECT.row);
const KEY_CLEAR = 16;
export const KEY_OUT: Point3 = [KEY_HOME[0], FACE_Y + KEY_CLEAR, KEY_HOME[2]];
const DOCK_X = SITE.x + 11;
const DOCK_Z = 22;
export const KEY_AWAY: Point3 = [DOCK_X, SITE_FACE + KEY_CLEAR, DOCK_Z];
export const KEY_DOCK: Point3 = [DOCK_X, SITE_FACE, DOCK_Z];

/** The page's way: out of the site's foot, along the floor to the middle of the tray. */
export const SHEET_FROM: Point3 = [
	SITE.x + SITE.w - 8,
	SITE_FACE + SHEET_D / 2 + 1,
	TRAY_TOP,
];
export const SHEET_TO: Point3 = [
	TRAY.x + TRAY.w / 2,
	TRAY.y + TRAY.d / 2,
	TRAY_TOP,
];

const EXTENT: Point3[] = [
	...boxCorners(CAB, 0, CAB_TOP),
	...boxCorners(SITE, 0, SITE_TOP),
	...boxCorners(TRAY, 0, TRAY_TOP),
	...boxCorners(
		{ ...KEY_PLAN, x: KEY_AWAY[0] - KEY_W / 2, y: KEY_AWAY[1] },
		KEY_AWAY[2],
		KEY_AWAY[2] + KEY_H
	),
];

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

/** The screen translate that moves a part built at the origin to a world point. */
export const placeAt = (point: Point3) => translateAlong(P, point);

const faceRect = (y: number, x0: number, x1: number, z0: number, z1: number) =>
	pathOf(
		[at([x0, y, z0]), at([x1, y, z0]), at([x1, y, z1]), at([x0, y, z1])],
		true
	);

const keySolid = ([x, y, z]: Point3) =>
	slabOf({ ...KEY_PLAN, x: x + KEY_PLAN.x, y }, z, KEY_H, P, 2, 0.2);

const CELLS = Array.from({ length: ROWS }, (_, row) =>
	Array.from({ length: COLS }, (__, col) => ({ col, row }))
).flat();

export const CABINET_ART = {
	body: slabOf(CAB, 0, CAB_TOP, P, 3, 0.4),
	/** Only the taken key's box is outlined: the empty cell is part of the one accent. */
	empty: faceRect(
		FACE_Y,
		cellX(SUBJECT.col),
		cellX(SUBJECT.col) + CELL_W,
		cellZ(SUBJECT.row),
		cellZ(SUBJECT.row) + CELL_H
	),
	/** Painted left to right, bottom row last, so nearer keys overlap farther ones. */
	keys: CELLS.filter(
		({ col, row }) => !(col === SUBJECT.col && row === SUBJECT.row)
	).map(({ col, row }) => ({
		id: `${col}:${row}`,
		solid: keySolid(hangOf(col, row)),
	})),
};

export const SITE_ART = {
	body: slabOf(SITE, 0, SITE_TOP, P, 2, 0.3),
};

export const TRAY_ART = {
	body: slabOf(TRAY, 0, TRAY_TOP, P, 3, 0.3),
};

/** The moving parts, built at the origin and placed by a transform each frame. */
export const KEY_ART = {
	solid: keySolid([0, 0, 0]),
	/** The taken key alone keeps its ring hole: it is the one lit part. */
	hole: sideRing(KEY_HOLE, 1.5, "y", P, 18),
};

/** The fetched page: a plain sheet. */
export const SHEET_ART = slabOf(SHEET_PLAN, 0, SHEET_T, P, 2);
