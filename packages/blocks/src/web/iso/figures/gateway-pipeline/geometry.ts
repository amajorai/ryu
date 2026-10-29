import {
	fitProjection,
	iso,
	type Plan,
	type Point3,
	type SolidPaths,
	slabOf,
} from "../../kit/iso-kit.ts";
import { STAGE_COUNT, STAGES } from "./model.ts";

/**
 * World layout, in drawing units: x runs along the line from the first gate (left, far)
 * to audit (right, near), y is across it and z is up. The whole figure is one thin track,
 * eight gates over it and one request riding it.
 */

export const WIDTH = 600;
export const HEIGHT = 250;
const AZIMUTH = 66;
const PAD = 30;

/** The track: one thin slab under every gate. */
const TRACK_FROM = -190;
const TRACK_TO = 190;
const TRACK_HALF = 15;
export const TRACK_TOP = 1.5;

/** The gates: two posts and a lintel each, like a portal frame; pinned stages stand taller. */
const GATE_STEP = 44;
export const GATE_X: readonly number[] = Array.from(
	{ length: STAGE_COUNT },
	(_, index) => (index - (STAGE_COUNT - 1) / 2) * GATE_STEP
);
/** How deep each frame is along the line, and how thick its posts are across it. */
const FRAME = 6;
const POST = 3;
const POST_Y = 15;
const LINTEL = 3.5;
const PINNED_TALL = 36;
const SWAPPABLE_TALL = 25;

/** The request: a small cube. */
const PARCEL = 12;

/** Where the request appears and leaves, just past each end of the track. */
export const ENTER_X = TRACK_FROM + 9;
export const LEAVE_X = TRACK_TO - 9;

const EXTENT: Point3[] = [
	[TRACK_FROM, -TRACK_HALF, 0],
	[TRACK_FROM, TRACK_HALF, 0],
	[TRACK_TO, -TRACK_HALF, 0],
	[TRACK_TO, TRACK_HALF, 0],
	[GATE_X[0] ?? 0, -POST_Y - POST / 2, PINNED_TALL],
	[GATE_X.at(-1) ?? 0, POST_Y + POST / 2, PINNED_TALL],
];

export const P = fitProjection(EXTENT, WIDTH, HEIGHT, {
	pad: PAD,
	azimuth: AZIMUTH,
});

export const at = (point: Point3) => iso(point, P);

const solid = (plan: Plan, z: number, h: number): SolidPaths =>
	slabOf(plan, z, h, P, 2, 0);

export const TRACK = solid(
	{
		x: TRACK_FROM,
		y: -TRACK_HALF,
		w: TRACK_TO - TRACK_FROM,
		d: TRACK_HALF * 2,
		r: 2,
	},
	0,
	TRACK_TOP
);

export interface GateParts {
	far: SolidPaths;
	lintel: SolidPaths;
	near: SolidPaths;
	stage: number;
}

export const GATES: readonly GateParts[] = GATE_X.map((x, stage) => {
	const tall = STAGES[stage]?.pinned ? PINNED_TALL : SWAPPABLE_TALL;
	const postPlan = (y: number): Plan => ({
		x: x - FRAME / 2,
		y: y - POST / 2,
		w: FRAME,
		d: POST,
		r: 0.4,
	});
	return {
		stage,
		far: solid(postPlan(-POST_Y), TRACK_TOP, tall - LINTEL - TRACK_TOP),
		near: solid(postPlan(POST_Y), TRACK_TOP, tall - LINTEL - TRACK_TOP),
		lintel: solid(
			{
				x: x - FRAME / 2,
				y: -POST_Y - POST / 2,
				w: FRAME,
				d: POST_Y * 2 + POST,
				r: 0.4,
			},
			tall - LINTEL,
			LINTEL
		),
	};
});

/** The request, drawn once at x = 0; the loop slides it along the track. */
export const PARCEL_PATHS = solid(
	{ x: -PARCEL / 2, y: -PARCEL / 2, w: PARCEL, d: PARCEL, r: 0.6 },
	TRACK_TOP,
	PARCEL
);

const ORIGIN = at([0, 0, 0]);

/** The screen offset that moves the request to `x` along the track. */
export function slideTo(x: number): string {
	const [sx, sy] = at([x, 0, 0]);
	const fine = (value: number) => Math.round(value * 100) / 100;
	return `translate(${fine(sx - ORIGIN[0])} ${fine(sy - ORIGIN[1])})`;
}

/** Screen x of each gate, for mapping a pointer to the nearest stage. */
export const GATE_SX: readonly number[] = GATE_X.map((x) => at([x, 0, 0])[0]);
