import { boxCorners, slabOf } from "../../../../kit/iso-kit.ts";
import { benchPlate, lamp, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * Resume screening: a grading belt. Applications ride from the in-stack
 * under a reading gantry (its lamp is lit while it scores one against the
 * rubric) and drop into three graded trays, each holding its own pile.
 */

const PLATE = { x: -100, y: -50, w: 200, d: 100, r: 8 };
const BELT = { x: -88, y: -14, w: 132, d: 28, r: 3 };
const BELT_H = 6;
const GANTRY_X = -14;
const BEAM_Z = 34;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[GANTRY_X, 0, BEAM_Z + 10],
]);

function sheet(x: number, z: number) {
	s.solid(
		slabOf({ x: x - 10, y: BELT.y + 4, w: 20, d: 20, r: 1 }, z, 1.6, s.P, 2),
		{ crease: "none" }
	);
}

function post(y: number) {
	const plan = { x: GANTRY_X - 5, y, w: 10, d: 8, r: 1.5 };
	s.halo(plan, 0);
	s.solid(slabOf(plan, 0, BEAM_Z, s.P, 3, 0.6));
}

benchPlate(s, PLATE);
s.halo(BELT, 0);
s.solid(slabOf(BELT, 0, BELT_H, s.P, 4, 0.6));
screws(
	s,
	[
		[BELT.x + 6, 0],
		[BELT.x + BELT.w - 6, 0],
	],
	BELT_H,
	1.4
);
post(BELT.y - 12);
// The in-stack of applications waiting at the back of the belt.
for (let i = 0; i < 4; i++) {
	sheet(-70, BELT_H + i * 2.2);
}
sheet(-40, BELT_H);
sheet(GANTRY_X, BELT_H);
post(BELT.y + BELT.d + 4);
const beam = { x: GANTRY_X - 7, y: BELT.y - 14, w: 14, d: 56, r: 2 };
s.solid(slabOf(beam, BEAM_Z, 7, s.P, 3, 0.6));
lamp(s, [GANTRY_X, 0], BEAM_Z + 7, { lit: true, radius: 3.4 });
sheet(26, BELT_H);
// Three graded trays at the end of the belt, piles by score.
for (let i = 0; i < 3; i++) {
	const tray = { x: 54, y: -40 + i * 28, w: 34, d: 24, r: 2 };
	s.halo(tray, 0);
	s.solid(slabOf(tray, 0, 4, s.P, 3, 0.6), { tone: "lo" });
	// Backstop on the far edge, so the tray reads as an open letter tray.
	s.solid(
		slabOf({ x: tray.x, y: tray.y, w: tray.w, d: 3, r: 1 }, 4, 9, s.P, 2),
		{ tone: "lo" }
	);
	const paper = {
		x: tray.x + 4,
		y: tray.y + 5,
		w: tray.w - 8,
		d: tray.d - 8,
		r: 1,
	};
	for (let k = 0; k < 3 - i; k++) {
		s.solid(slabOf(paper, 4 + k * 2.2, 1.6, s.P, 2), {
			crease: "none",
		});
	}
}

export const drawing = cardDrawing(s);
