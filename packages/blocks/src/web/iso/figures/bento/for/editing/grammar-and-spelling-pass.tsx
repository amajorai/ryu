import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, knob, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Grammar and spelling pass: a proofing gantry over a flatbed. The bridge
 * rides two rails down the page line by line; its stylus has stopped on one
 * error and marked it (the lit mark), ready to show the fix.
 */

const PLATE = { x: -96, y: -58, w: 192, d: 116, r: 8 };
const BED = { x: -72, y: -38, w: 128, d: 76, r: 4 };
const SHEET = insetPlan(BED, 7);
const BED_H = 6;
const TOP = BED_H + 1.2;
const RAIL_H = 3;
const GANTRY_X = 6;
const BRIDGE_Z = 26;
const LINES = 7;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[GANTRY_X, 0, BRIDGE_Z + 14],
]);

function rail(y: number) {
	s.solid(slabOf({ x: -80, y, w: 144, d: 6, r: 2 }, 0, RAIL_H, s.P, 3, 0.4), {
		tone: "lo",
	});
}

function post(y: number) {
	const plan = { x: GANTRY_X - 7, y, w: 14, d: 8, r: 2 };
	s.solid(slabOf(plan, RAIL_H, BRIDGE_Z - RAIL_H, s.P, 4, 0.6));
}

benchPlate(s, PLATE);
rail(-50);
s.halo(BED, 0);
s.solid(slabOf(BED, 0, BED_H, s.P, 6, 0.8));
s.solid(slabOf(SHEET, BED_H, 1.2, s.P, 3), { crease: "none" });
const rows = Array.from({ length: LINES }, (_, i) => SHEET.y + 8 + i * 8.4);
const lengths = [92, 70, 84, 60, 88, 74, 48];
rows.forEach((y, i) => {
	s.line(
		lineOnTop(
			[SHEET.x + 6, y],
			[SHEET.x + 6 + (lengths[i] ?? 60), y],
			TOP,
			s.P
		),
		{ tone: i === 0 ? "mid" : "lo" }
	);
});
// The error the stylus found, marked on its line.
const markY = rows[3] ?? 0;
s.solid(
	slabOf(
		{ x: GANTRY_X + 12, y: markY - 2.4, w: 16, d: 4.8, r: 1 },
		TOP,
		1.4,
		s.P,
		2
	),
	{ lit: true, crease: "none" }
);
// Gantry: back post, bridge, stylus, carriage, front post.
post(-50);
s.solid(
	slabOf(
		{ x: GANTRY_X - 7, y: -50, w: 14, d: 100, r: 2 },
		BRIDGE_Z,
		6,
		s.P,
		4,
		0.6
	)
);
screws(
	s,
	[
		[GANTRY_X, -45],
		[GANTRY_X, 45],
	],
	BRIDGE_Z + 6,
	1.4
);
s.solid(
	cylinder(GANTRY_X + 20, markY, 1.4, TOP + 1.4, BRIDGE_Z - TOP, s.P, 16)
);
s.solid(
	slabOf(
		{ x: GANTRY_X - 4, y: markY - 8, w: 30, d: 16, r: 3 },
		BRIDGE_Z + 6,
		7,
		s.P,
		4,
		0.6
	)
);
knob(s, [GANTRY_X + 4, markY], BRIDGE_Z + 13, 3.5, 3);
rail(44);
post(42);

export const drawing = cardDrawing(s);
