import {
	boxCorners,
	cylinder,
	insetPlan,
	lineOnTop,
	slabOf,
} from "../../../../kit/iso-kit.ts";
import { benchPlate, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Fraud signal flagging: a scanning bed. The claim lies on the bed and a
 * gantry head passes over it line by line; wherever a line does not add up,
 * a marker pin is pushed in at that line. The newest red flag is the lit one.
 */

const PLATE = { x: -100, y: -56, w: 200, d: 112, r: 8 };
const BED = { x: -84, y: -44, w: 132, d: 88, r: 4 };
const BED_H = 6;
const SHEET = insetPlan({ x: -70, y: -40, w: 104, d: 80, r: 2 }, 2);
const TOP = BED_H + 1;
const GANTRY_Y = -18;
const GANTRY_Z = 30;
const LINES = 8;
const FLAGS: [number, number][] = [
	[4, 10],
	[5, -44],
	[6, -14],
];
const KEY = 0;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[0, 0, GANTRY_Z + 10],
]);

const lineY = (i: number) => SHEET.y + 7 + i * 9;

function flag(index: number) {
	const [row, x] = FLAGS[index] ?? [0, 0];
	const y = lineY(row);
	const lit = index === KEY;
	s.solid(cylinder(x, y, 0.9, TOP, 18, s.P, 12), { tone: "lo" });
	s.solid(
		slabOf({ x, y: y - 0.8, w: 11, d: 1.6, r: 0.3 }, TOP + 11, 7, s.P, 2),
		{
			lit,
		}
	);
}

function upright(x: number) {
	const plan = { x: x - 5, y: GANTRY_Y - 6, w: 10, d: 12, r: 2 };
	s.solid(slabOf(plan, BED_H, GANTRY_Z - BED_H, s.P, 3, 0.6));
}

benchPlate(s, PLATE);
s.halo(BED, 0);
s.solid(slabOf(BED, 0, BED_H, s.P, 6, 0.8));
for (const x of [BED.x + 5, BED.x + BED.w - 5]) {
	s.solid(
		slabOf(
			{ x: x - 2, y: BED.y + 4, w: 4, d: BED.d - 8, r: 1 },
			BED_H,
			1.5,
			s.P,
			2
		),
		{
			tone: "lo",
		}
	);
}
s.solid(slabOf(SHEET, BED_H, 1, s.P, 2), { crease: "none" });
for (let i = 0; i < LINES; i++) {
	const length = [84, 70, 78, 60, 82, 66, 74, 50][i] ?? 60;
	s.line(
		lineOnTop(
			[SHEET.x + 6, lineY(i)],
			[SHEET.x + 6 + length, lineY(i)],
			TOP,
			s.P
		),
		{
			tone: "lo",
		}
	);
}
upright(BED.x + 5);
upright(BED.x + BED.w - 5);
// Gantry bridge with its scan head.
s.solid(
	slabOf(
		{ x: BED.x, y: GANTRY_Y - 5, w: BED.w, d: 10, r: 2 },
		GANTRY_Z,
		5,
		s.P,
		3,
		0.6
	)
);
s.solid(
	slabOf(
		{ x: -26, y: GANTRY_Y - 7, w: 20, d: 14, r: 2 },
		GANTRY_Z - 8,
		14,
		s.P,
		3,
		0.6
	),
	{
		tone: "lo",
	}
);
lamp(s, [-16, GANTRY_Y], GANTRY_Z + 6, { radius: 1.6 });
flag(0);
flag(1);
flag(2);
// Spare marker pins in a cup.
s.halo({ x: 64, y: 18, w: 22, d: 22, r: 11 }, 0);
s.solid(cylinder(75, 29, 10, 0, 12, s.P, 36, 0.6), { tone: "lo" });
for (const [x, y] of [
	[72, 26],
	[78, 29],
	[74, 32],
] as const) {
	s.solid(cylinder(x, y, 0.9, 12, 10, s.P, 12), { tone: "lo" });
}
screws(
	s,
	[
		[BED.x + 12, BED.y + BED.d - 5],
		[BED.x + BED.w - 12, BED.y + BED.d - 5],
	],
	BED_H,
	1.3
);

export const drawing = cardDrawing(s);
