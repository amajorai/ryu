import {
	axisVector,
	boxCorners,
	type Flat,
	fitProjection,
	iso,
	type Plan,
	type Point3,
	pathOf,
	ring,
	slabOf,
} from "../../kit/iso-kit.ts";

/*
 * World layout, in units of about 1 px of the drawing. x runs along the box from its far
 * end (left) to the hatch (right), y from the back to the front (the window side), z up.
 * The camera looks from the front right, so the window face and the hatch end both show.
 * The box sits straight on the page: no bench, stand or feet.
 */

export const WIDTH = 600;
const AZIMUTH = 50;
const PAD = 80;

/* The sealed box. Its hatch end is x = BOX_END. */
const BOX: Plan = { x: -80, y: -32, w: 120, d: 64, r: 3 };
const BOX_TOP = 64;
const BOX_END = BOX.x + BOX.w;

/* Three blanked ports on the roof: no files, no network, no environment. */
const BLANK_XS = [-60, -42, -24] as const;
const BLANK_Y = -12;
const BLANK_R = 4.6;

/* The hatch at the right end: a chamber, its mouth, a lifting door and a tray. */
const CHAMBER: Plan = { x: BOX_END, y: -16, w: 22, d: 32, r: 1.2 };
const CHAMBER_TOP = 58;
const MOUTH_X = CHAMBER.x + CHAMBER.w;
const MOUTH = { y0: -9, y1: 9, z0: 18, z1: 34 };
const DOOR = { y0: -11, y1: 11, z0: MOUTH.z0, z1: MOUTH.z1 + 2, t: 1.6 };
/** How far the door lifts: just clear of the mouth, still on the chamber's face. */
const DOOR_LIFT = MOUTH.z1 - MOUTH.z0 + 2;
const TRAY: Plan = { x: MOUTH_X + DOOR.t, y: -11, w: 24, d: 22, r: 1 };
const TRAY_H = 2.4;

/* The one call that passes the hatch: it rests inside, then comes out onto the tray. */
const TOKEN = { long: 10, wide: 10, tall: 7 };
const TOKEN_IN = MOUTH_X - 12;
const TOKEN_OUT = TRAY.x + TRAY.w - 9;

const EXTENT: Point3[] = [
	...boxCorners(BOX, 0, BOX_TOP),
	...boxCorners(TRAY, MOUTH.z0 - TRAY_H, MOUTH.z0),
];

/** The viewBox is as tall as the object needs at this width, so there are no dead bands. */
export const HEIGHT = (() => {
	const unit = { origin: [0, 0] as Flat, scale: 1, azimuth: AZIMUTH };
	const flat = EXTENT.map((point) => iso(point, unit));
	const xs = flat.map(([x]) => x);
	const ys = flat.map(([, y]) => y);
	const scale = (WIDTH - PAD * 2) / (Math.max(...xs) - Math.min(...xs));
	return Math.ceil((Math.max(...ys) - Math.min(...ys)) * scale + PAD * 2);
})();

const P = fitProjection(EXTENT, WIDTH, HEIGHT, { pad: PAD, azimuth: AZIMUTH });

const at = (point: Point3): Flat => iso(point, P);
const fine = (value: number) => Math.round(value * 100) / 100;

/** A screen translate for a world offset. */
function shift(dx: number, dy: number, dz: number) {
	const [x, y] = axisVector(P, [dx, dy, dz]);
	return `translate(${fine(x)} ${fine(y)})`;
}

/** Points round a rounded rectangle in a vertical face, as (along, z) pairs. */
function roundedFace(
	a0: number,
	a1: number,
	z0: number,
	z1: number,
	r: number
): [number, number][] {
	const radius = Math.max(0, Math.min(r, (a1 - a0) / 2, (z1 - z0) / 2));
	const turns: [number, number, number][] = [
		[a1 - radius, z0 + radius, -90],
		[a1 - radius, z1 - radius, 0],
		[a0 + radius, z1 - radius, 90],
		[a0 + radius, z0 + radius, 180],
	];
	const out: [number, number][] = [];
	for (const [ca, cz, start] of turns) {
		const count = radius > 0 ? 6 : 0;
		for (let step = 0; step <= count; step++) {
			const angle =
				((start + (count ? (90 * step) / count : 45)) * Math.PI) / 180;
			out.push([ca + radius * Math.cos(angle), cz + radius * Math.sin(angle)]);
		}
	}
	return out;
}

const cross = (o: Flat, a: Flat, b: Flat) =>
	(a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

function hullOf(points: Flat[]): Flat[] {
	const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const half = (list: Flat[]) => {
		const out: Flat[] = [];
		for (const point of list) {
			while (
				out.length >= 2 &&
				cross(out.at(-2) as Flat, out.at(-1) as Flat, point) <= 0
			) {
				out.pop();
			}
			out.push(point);
		}
		return out.slice(0, -1);
	};
	return [...half(sorted), ...half(sorted.toReversed())];
}

/* --------------------------------------------------------------- static --- */

export const BOX_ART = {
	body: slabOf(BOX, 0, BOX_TOP, P, 4, 1),
	/** The blanked roof ports, drawn as faint hairline circles flush with the roof. */
	blanks: BLANK_XS.map((x) => ring(x, BLANK_Y, BLANK_R, BOX_TOP, P, 32)).join(
		""
	),
};

export const HATCH_ART = {
	chamber: slabOf(CHAMBER, 6, CHAMBER_TOP - 6, P, 3, 0.6),
	mouth: pathOf(
		roundedFace(MOUTH.y0, MOUTH.y1, MOUTH.z0, MOUTH.z1, 0.8).map(([y, z]) =>
			at([MOUTH_X, y, z])
		),
		true
	),
	door: slabOf(
		{
			x: MOUTH_X,
			y: DOOR.y0,
			w: DOOR.t,
			d: DOOR.y1 - DOOR.y0,
			r: 0.3,
		},
		DOOR.z0,
		DOOR.z1 - DOOR.z0,
		P,
		2,
		0.3
	),
	tray: slabOf(TRAY, MOUTH.z0 - TRAY_H, TRAY_H, P, 2, 0.3),
};

/* ---------------------------------------------------------------- moving --- */

/** The hatch door's offset for a lift share 0..1. */
export const doorAt = (lift: number) => shift(0, 0, lift * DOOR_LIFT);

const tokenX = (out: number) => TOKEN_IN + (TOKEN_OUT - TOKEN_IN) * out;

/** Whether any of the token has passed the mouth, so it can be seen. */
export const tokenShows = (out: number) =>
	tokenX(out) + TOKEN.long / 2 > MOUTH_X + 0.2;

/** The token's offset from its place on the tray, for a share 0..1 of the way out. */
export const tokenAt = (out: number) => shift(tokenX(out) - TOKEN_OUT, 0, 0);

/** The token, built once where it rests on the tray. */
export const TOKEN_ART = slabOf(
	{
		x: TOKEN_OUT - TOKEN.long / 2,
		y: -TOKEN.wide / 2,
		w: TOKEN.long,
		d: TOKEN.wide,
		r: 1.2,
	},
	MOUTH.z0,
	TOKEN.tall,
	P,
	4,
	0.5
);

/** Where the token can be seen: the mouth and everything outside it. */
export const TOKEN_CLIP = (() => {
	const points = [MOUTH_X, MOUTH_X + 80].flatMap((x) =>
		[MOUTH.y0, MOUTH.y1].flatMap((y) =>
			[MOUTH.z0 - 4, MOUTH.z1].map((z) => at([x, y, z]))
		)
	);
	return pathOf(hullOf(points), true);
})();
