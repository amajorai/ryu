import {
	boxCorners,
	cylinder,
	insetPlan,
	knurl,
	planOutline,
	ring,
	slabOf,
} from "../../../kit/iso-kit.ts";
import { benchPlate, faceRules, lamp, screws } from "../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../card.ts";

/*
 * Tool abuse: a bench vise on a test bench. One tool has been taken from the
 * rack behind (its socket stands empty) and clamped in the jaws (the lit
 * handle), where it is twisted and forced the way an attacker would.
 */

const PLATE = { x: -82, y: -54, w: 160, d: 92, r: 8 };
const RACK = { x: -70, y: -44, w: 78, d: 20, r: 3 };
const RACK_H = 10;
const BASE = { x: -22, y: -14, w: 72, d: 44, r: 4 };
const BASE_H = 7;
const JAW_H = 15;
const TOOL: [number, number] = [10, 8];

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[TOOL[0], TOOL[1], 58],
	[-46, -34, 52],
]);

benchPlate(s, PLATE);
// Tool rack: a block of sockets with handles standing upright.
s.halo(RACK, 0);
s.solid(slabOf(RACK, 0, RACK_H, s.P, 4, 0.8));
const cy = RACK.y + RACK.d / 2;
const tools: Array<[number, number, number] | null> = [
	[RACK.x + 10, 4, 24],
	[RACK.x + 24, 3.4, 30],
	[RACK.x + 38, 4.4, 20],
	[RACK.x + 52, 3.2, 26],
	null,
];
tools.forEach((tool, index) => {
	if (!tool) {
		const x = RACK.x + 10 + index * 14;
		s.line(ring(x, cy, 4, RACK_H, s.P, 20), { tone: "mid" });
		s.line(ring(x, cy, 2.6, RACK_H, s.P, 20), { tone: "lo" });
		return;
	}
	const [x, radius, height] = tool;
	s.solid(cylinder(x, cy, radius + 0.8, RACK_H, 2, s.P, 20), { tone: "lo" });
	s.solid(cylinder(x, cy, radius, RACK_H + 2, height, s.P, 24));
	s.line(knurl(x, cy, radius, RACK_H + 4, RACK_H + height - 4, 16, s.P), {
		tone: "faint",
	});
	s.solid(cylinder(x, cy, 1, RACK_H + 2 + height, 8, s.P, 10));
});
// Vise: base, fixed jaw, the clamped tool, moving jaw, screw and T-handle.
s.halo(BASE, 0);
s.solid(cylinder(BASE.x + 30, BASE.y + 22, 24, 0, 3, s.P, 40, 0.6), {
	tone: "lo",
});
s.solid(slabOf(BASE, 3, BASE_H - 3, s.P, 4, 0.6));
screws(
	s,
	[
		[BASE.x + 6, BASE.y + 6],
		[BASE.x + BASE.w - 6, BASE.y + BASE.d - 6],
	],
	BASE_H,
	1.5
);
const FIXED = { x: BASE.x + 4, y: BASE.y + 4, w: 22, d: 36, r: 2 };
s.solid(slabOf(FIXED, BASE_H, JAW_H, s.P, 3, 0.8));
s.line(planOutline(insetPlan(FIXED, 3), BASE_H + JAW_H, s.P, 2), {
	tone: "faint",
});
faceRules(
	s,
	"y",
	FIXED.y + FIXED.d,
	FIXED.x + 4,
	BASE_H + JAW_H - 5,
	[12, 12, 12],
	3
);
// The clamped tool: a handle with a ferrule and shank sticking out the top.
s.solid(cylinder(TOOL[0], TOOL[1], 6, BASE_H, 32, s.P, 28), { lit: true });
s.solid(cylinder(TOOL[0], TOOL[1], 3.2, BASE_H + 32, 4, s.P, 20), {
	tone: "lo",
});
s.solid(cylinder(TOOL[0], TOOL[1], 1.4, BASE_H + 36, 14, s.P, 12));
const MOVING = { x: TOOL[0] + 6, y: BASE.y + 4, w: 18, d: 36, r: 2 };
s.solid(slabOf(MOVING, BASE_H, JAW_H - 2, s.P, 3, 0.8));
faceRules(
	s,
	"y",
	MOVING.y + MOVING.d,
	MOVING.x + 4,
	BASE_H + JAW_H - 7,
	[10, 10],
	3
);
const SCREW_Y = TOOL[1] - 2;
s.solid(
	slabOf(
		{ x: MOVING.x + MOVING.w, y: SCREW_Y, w: 26, d: 4, r: 1 },
		14,
		4,
		s.P,
		2
	)
);
s.solid(
	slabOf(
		{ x: MOVING.x + MOVING.w + 24, y: SCREW_Y - 14, w: 4, d: 32, r: 1 },
		14.5,
		3,
		s.P,
		2
	)
);
s.solid(cylinder(MOVING.x + MOVING.w + 26, SCREW_Y - 15, 3, 13, 5, s.P, 16), {
	tone: "lo",
});
s.solid(cylinder(MOVING.x + MOVING.w + 26, SCREW_Y + 19, 3, 13, 5, s.P, 16), {
	tone: "lo",
});
// Status lamp on the bench corner.
lamp(s, [-62, 22], 0, { radius: 2 });

export const drawing = cardDrawing(s);
