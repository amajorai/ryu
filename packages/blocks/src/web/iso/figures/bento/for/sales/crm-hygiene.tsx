import { boxCorners, lineOnTop, slabOf } from "../../../../kit/iso-kit.ts";
import { benchPlate, lamp, ruler, screws } from "../../../static/parts.ts";
import { cardDrawing, createCardSketch } from "../../card.ts";

/*
 * CRM hygiene: a lying abacus. Each rod is a deal, its beads mark the stage
 * it has reached; after the meeting one bead is slid on to the next stage
 * (the lit bead), and the stage scale in front reads where each deal stands.
 */

const PLATE = { x: -100, y: -54, w: 200, d: 108, r: 8 };
const FRAME = { x: -84, y: -40, w: 156, d: 70, r: 4 };
const END_W = 12;
const END_H = 20;
const ROD_Z = 13;
const RODS = [-28, -14, 0, 14];
const STAGES = [3, 1, 4, 2];
const BEAD = 9;

const s = createCardSketch([
	...boxCorners(PLATE, -15, 0),
	[FRAME.x, 0, END_H + 4],
]);

function bead(x: number, y: number, lit = false) {
	s.solid(
		slabOf(
			{ x: x - 4, y: y - BEAD / 2, w: 8, d: BEAD, r: 3 },
			ROD_Z - 4.5,
			9,
			s.P,
			4,
			0.6
		),
		{ lit, tone: "mid" }
	);
}

benchPlate(s, PLATE);
s.halo(FRAME, 0);
s.solid(slabOf(FRAME, 0, 4, s.P, 6, 0.6), { tone: "lo" });
const left = { x: FRAME.x, y: FRAME.y, w: END_W, d: FRAME.d, r: 3 };
s.solid(slabOf(left, 4, END_H - 4, s.P, 4, 0.8));
const innerX0 = FRAME.x + END_W;
const innerX1 = FRAME.x + FRAME.w - END_W;
RODS.forEach((y, row) => {
	s.line(lineOnTop([innerX0, y], [innerX1, y], ROD_Z, s.P), { tone: "mid" });
	const done = STAGES[row] ?? 0;
	for (let i = 0; i < done; i++) {
		bead(innerX0 + 7 + i * 9, y);
	}
	const moved = row === RODS.length - 1;
	for (let i = 0; i < 6 - done - (moved ? 1 : 0); i++) {
		bead(innerX1 - 7 - i * 9, y);
	}
	if (moved) {
		bead(innerX0 + 7 + done * 9 + 14, y, true);
	}
});
const right = { x: innerX1, y: FRAME.y, w: END_W, d: FRAME.d, r: 3 };
s.solid(slabOf(right, 4, END_H - 4, s.P, 4, 0.8));
screws(
	s,
	[
		[left.x + 6, left.y + 8],
		[left.x + 6, left.y + left.d - 8],
		[right.x + 6, right.y + 8],
		[right.x + 6, right.y + right.d - 8],
	],
	END_H,
	1.4
);
ruler(
	s,
	{ x: innerX0, y: FRAME.y + FRAME.d - 9, w: innerX1 - innerX0, d: 6, r: 1 },
	4
);
lamp(s, [FRAME.x + FRAME.w + 12, FRAME.y + FRAME.d + 8], 0, { radius: 2 });

export const drawing = cardDrawing(s);
