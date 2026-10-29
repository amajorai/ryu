import { boxCorners, cylinder, slabOf } from "../../../../kit/iso-kit.ts";
import { benchPlate, faceLine, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Regulation-to-control mapping: a terminal board. The regulation stands at
 * the back as a thick stack of pages with one terminal per clause; cords
 * patch each clause to the control that answers it on the rack in front. The
 * last clause has no cord, and its lamp (the lit part) flags the gap.
 */

const PLATE = { x: -96, y: -58, w: 192, d: 116, r: 8 };
const STACK = { x: -74, y: -48, w: 148, d: 22, r: 3 };
const STACK_H = 26;
const STRIP = { x: -74, y: -22, w: 148, d: 14, r: 2 };
const STRIP_H = 5;
const RACK = { x: -74, y: 18, w: 148, d: 26, r: 3 };
const RACK_H = 10;
const COLUMNS = [-52, -18, 16, 50];
const CLAUSE_Y = -15;
const CONTROL_Y = 28;
const PEG_TOP = STRIP_H + 7;
const POST_TOP = RACK_H + 8;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[0, 0, STACK_H + 2],
	[0, 0, 38],
]);

benchPlate(s, PLATE);
// The regulation: a bound stack of pages, edges ruled on its front face.
s.halo(STACK, 0);
s.solid(slabOf(STACK, 0, 4, s.P, 3, 0.6), { tone: "lo" });
s.solid(
	slabOf({ ...STACK, x: STACK.x + 2, w: STACK.w - 4 }, 4, STACK_H - 8, s.P, 3)
);
s.solid(slabOf(STACK, STACK_H - 4, 4, s.P, 3, 0.6), { tone: "lo" });
for (let i = 1; i < 5; i++) {
	s.line(
		faceLine(
			s,
			"y",
			STACK.y + STACK.d,
			STACK.x + 4,
			STACK.x + STACK.w - 4,
			4 + i * 3.6
		),
		{
			tone: "faint",
		}
	);
}
// The clause strip, one terminal and lamp per clause.
s.halo(STRIP, 0);
s.solid(slabOf(STRIP, 0, STRIP_H, s.P, 3, 0.6));
COLUMNS.forEach((x, i) => {
	lamp(s, [x + 10, CLAUSE_Y], STRIP_H, { lit: i === 3, radius: 1.8 });
	s.solid(cylinder(x, CLAUSE_Y, 3.6, STRIP_H, 2, s.P, 20), { tone: "lo" });
	s.solid(cylinder(x, CLAUSE_Y, 2.2, STRIP_H + 2, 5, s.P, 16));
});
// The control rack: three controls with posts, one blank faceplate.
s.halo(RACK, 0);
s.solid(slabOf(RACK, 0, RACK_H, s.P, 4, 0.8));
screws(
	s,
	[
		[RACK.x + 6, RACK.y + 13],
		[RACK.x + RACK.w - 6, RACK.y + 13],
	],
	RACK_H,
	1.3
);
COLUMNS.slice(0, 3).forEach((x) => {
	s.solid(
		slabOf(
			{ x: x - 9, y: RACK.y + 4, w: 18, d: 18, r: 2 },
			RACK_H,
			1.5,
			s.P,
			3
		),
		{
			tone: "lo",
		}
	);
	s.solid(cylinder(x, CONTROL_Y, 3, RACK_H + 1.5, 6.5, s.P, 20));
});
s.solid(
	slabOf(
		{ x: COLUMNS[3]! - 9, y: RACK.y + 4, w: 18, d: 18, r: 2 },
		RACK_H,
		1.5,
		s.P,
		3
	),
	{ tone: "lo" }
);
// Cords: each clause patched to the control that answers it.
const pairs: [number, number][] = [
	[0, 1],
	[1, 0],
	[2, 2],
];
for (const [clause, control] of pairs) {
	const from: [number, number, number] = [COLUMNS[clause]!, CLAUSE_Y, PEG_TOP];
	const to: [number, number, number] = [COLUMNS[control]!, CONTROL_Y, POST_TOP];
	const via: [number, number, number][] = [];
	for (let i = 1; i < 10; i++) {
		const t = i / 10;
		via.push([
			from[0] + (to[0] - from[0]) * t,
			from[1] + (to[1] - from[1]) * t,
			from[2] + (to[2] - from[2]) * t + 18 * Math.sin(Math.PI * t),
		]);
	}
	s.wire(from, to, via, { tone: "mid" });
}

export const drawing = cardDrawing(s);
